use aomi_sdk::schemars::JsonSchema;
use aomi_sdk::*;
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::client::{Account, AccountAccess, CHAIN_ID, WorldClient, asset_by_symbol};
use crate::mandate::{Mandate, TradeFacts, Verdict, parse_decimal};
use crate::reporting::{
    AccountEffectInput, FixtureReporting, GuardianPreference, Reporting, ResizeInput, SliceInput,
    UnwindCandidate,
};

#[derive(Clone, Default)]
pub(crate) struct WorldMarketsApp {
    client: WorldClient,
    reporting: FixtureReporting,
}

pub(crate) struct ListWorldAssets;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct ListWorldAssetsArgs {}

pub(crate) struct GetWorldAccount;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct GetWorldAccountArgs {
    /// World account ID. Optional when handover account context is available.
    #[serde(default)]
    pub(crate) account_id: Option<u64>,
    /// Expected owner wallet. This does not replace the acting wallet authorization check.
    #[serde(default)]
    pub(crate) wallet_address: Option<String>,
}

pub(crate) struct GetWorldMarket;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct GetWorldMarketArgs {
    /// Product type: spot, perp, or lend.
    pub(crate) product: String,
    /// Base asset symbol, such as BTC.b or WETH.
    pub(crate) base_symbol: String,
    /// Quote asset symbol. Required for spot and perp, omitted for lend.
    #[serde(default)]
    pub(crate) quote_symbol: Option<String>,
}

pub(crate) struct PreviewWorldTrade;
pub(crate) struct CheckWorldMandate;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct WorldTradeArgs {
    /// Product type: spot or perp.
    pub(crate) product: String,
    /// Trade side: buy or sell.
    pub(crate) side: String,
    /// Base asset symbol.
    pub(crate) base_symbol: String,
    /// Quote asset symbol.
    pub(crate) quote_symbol: String,
    /// Human-readable base quantity, such as "0.25".
    pub(crate) quantity: String,
    /// Optional World account ID. Handover account context is used when omitted.
    #[serde(default)]
    pub(crate) account_id: Option<u64>,
    /// Optional expected owner wallet.
    #[serde(default)]
    pub(crate) wallet_address: Option<String>,
}

pub(crate) struct GetWorldAgentPermission;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct GetWorldAgentPermissionArgs {
    /// World account ID. Handover account context is used when omitted.
    #[serde(default)]
    pub(crate) account_id: Option<u64>,
    /// Actor address to inspect. The active EVM actor is used when omitted.
    #[serde(default)]
    pub(crate) actor_address: Option<String>,
}

pub(crate) struct GetWorldOpenOrders;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct GetWorldOpenOrdersArgs {
    /// Product type: spot or perp.
    pub(crate) product: String,
    /// Base asset symbol.
    pub(crate) base_symbol: String,
    /// Quote asset symbol.
    pub(crate) quote_symbol: String,
    /// World account ID. Handover account context is used when omitted.
    #[serde(default)]
    pub(crate) account_id: Option<u64>,
    /// Optional expected owner wallet.
    #[serde(default)]
    pub(crate) wallet_address: Option<String>,
}

impl WorldMarketsApp {
    fn account_id(ctx: &DynToolCallCtx, explicit: Option<u64>) -> Option<u64> {
        explicit
            .or_else(|| ctx.attribute_u64(&["world", "account_id"]))
            .or_else(|| value_u64(ctx.attribute_path(&["handover_account_id"])))
            .or_else(|| value_u64(ctx.attribute_path(&["platform_account_ref"])))
            .or_else(|| value_u64(ctx.attribute_path(&["handover_account_ref"])))
            .or_else(|| ctx.attribute_u64(&["handover_mandate", "account", "id"]))
    }

    fn brief(ctx: &DynToolCallCtx) -> Option<Value> {
        ctx.attribute_path(&["handover_brief"])
            .or_else(|| ctx.attribute_path(&["brief"]))
            .or_else(|| ctx.attribute_path(&["handover_mandate", "brief"]))
            .cloned()
    }

    fn access(
        &self,
        account_id: Option<u64>,
        wallet_address: Option<&str>,
        ctx: &DynToolCallCtx,
    ) -> Result<AccountAccess, String> {
        let account_id = Self::account_id(ctx, account_id);
        let owner_wallet = wallet_address
            .map(ToString::to_string)
            .or_else(|| ctx.attribute_string(&["world", "owner_wallet"]));
        let actor = ctx.attribute_string(&["domain", "evm", "address"]);
        self.client
            .resolve_account(account_id, owner_wallet.as_deref(), actor.as_deref())
    }

    fn trade_preview(&self, args: WorldTradeArgs, ctx: &DynToolCallCtx) -> Result<Value, String> {
        let product = normalize_product(&args.product)?;
        let side = args.side.to_ascii_lowercase();
        if !matches!(side.as_str(), "buy" | "sell") {
            return Err("[world-markets] side must be buy or sell".to_string());
        }
        let quantity = parse_decimal(&args.quantity, "quantity")
            .map_err(|verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))?;
        if quantity <= Decimal::ZERO {
            return Err("[world-markets] quantity must be greater than zero".to_string());
        }

        let access = self.access(args.account_id, args.wallet_address.as_deref(), ctx)?;
        let assets = self.client.assets()?;
        let account = self.client.account(access.account_id, &assets)?;
        let base = asset_by_symbol(&assets, &args.base_symbol)?;
        let quote = asset_by_symbol(&assets, &args.quote_symbol)?;
        let market = self
            .client
            .market(product, base.clone(), Some(quote.clone()))?;
        let mark_price = parse_decimal(&market.mark_price, "mark_price")
            .map_err(|verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))?;
        let current_position_quantity = current_position(&account, product, &base.symbol)?;
        let rapv = parse_decimal(
            &account.risk_adjusted_portfolio_value,
            "risk_adjusted_portfolio_value",
        )
        .map_err(|verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))?;
        let mandate = Mandate::parse(ctx.attribute_path(&["handover_mandate"]));
        let verdict = match mandate {
            Ok(mandate) => mandate.evaluate(&TradeFacts {
                product,
                side: &side,
                base: &base.symbol,
                quote: &quote.symbol,
                quantity,
                mark_price,
                current_position_quantity,
                risk_adjusted_portfolio_value: rapv,
                post_trade_risk_adjusted_portfolio_value: None,
                eligible_for_liquidation: account.eligible_for_liquidation,
            }),
            Err(verdict) => verdict,
        };
        let estimated_notional = quantity.checked_mul(mark_price).ok_or_else(|| {
            "[world-markets] estimated notional exceeds numeric range".to_string()
        })?;
        let status = if verdict.is_allow() {
            "policy_allowed_preview_only"
        } else {
            "policy_denied"
        };
        let reason = if verdict.is_allow() {
            "The deterministic mandate permits this intent, but this release remains non-executable until the host transaction boundary cannot bypass app policy."
        } else {
            "The deterministic World mandate denied this intent; do not construct or stage a transaction."
        };

        Ok(json!({
            "source": "world-markets-contract",
            "chain_id": CHAIN_ID,
            "exchange": self.client.exchange(),
            "block_number": self.client.block_number()?,
            "standing_brief": Self::brief(ctx),
            "access": access,
            "preview": {
                "account_id": account.account_id,
                "owner": account.owner,
                "product": product,
                "side": side,
                "base_symbol": base.symbol,
                "quote_symbol": quote.symbol,
                "quantity": args.quantity,
                "current_position_quantity": current_position_quantity.to_string(),
                "mark_price": market.mark_price,
                "estimated_notional": estimated_notional.to_string(),
                "order_book": market.book,
                "pre_execution_risk_adjusted_portfolio_value": account.risk_adjusted_portfolio_value,
                "post_trade_risk_adjusted_portfolio_value": null,
                "pre_execution_eligible_for_liquidation": account.eligible_for_liquidation,
                "policy_result": verdict,
                "executable": false,
                "status": status,
                "reason": reason,
            }
        }))
    }
}

impl DynAomiTool for ListWorldAssets {
    type App = WorldMarketsApp;
    type Args = ListWorldAssetsArgs;
    const NAME: &'static str = "list_world_assets";
    const DESCRIPTION: &'static str = "List live World Markets assets and their token IDs, symbols, addresses, decimals, and risk parameters.";

    fn run(
        app: &WorldMarketsApp,
        _args: Self::Args,
        _ctx: DynToolCallCtx,
    ) -> Result<Value, String> {
        Ok(json!({
            "source": "world-markets-contract",
            "chain_id": CHAIN_ID,
            "exchange": app.client.exchange(),
            "block_number": app.client.block_number()?,
            "assets": app.client.assets()?,
        }))
    }
}

impl DynAomiTool for GetWorldAccount {
    type App = WorldMarketsApp;
    type Args = GetWorldAccountArgs;
    const NAME: &'static str = "get_world_account";
    const DESCRIPTION: &'static str = "Inspect a live World account after proving that the active actor is its owner or an on-chain permitted trader.";

    fn run(app: &WorldMarketsApp, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        let access = app.access(args.account_id, args.wallet_address.as_deref(), &ctx)?;
        let assets = app.client.assets()?;
        let account = app.client.account(access.account_id, &assets)?;
        Ok(json!({
            "source": "world-markets-contract",
            "chain_id": CHAIN_ID,
            "exchange": app.client.exchange(),
            "block_number": app.client.block_number()?,
            "standing_brief": WorldMarketsApp::brief(&ctx),
            "access": access,
            "account": account,
        }))
    }
}

impl DynAomiTool for GetWorldMarket {
    type App = WorldMarketsApp;
    type Args = GetWorldMarketArgs;
    const NAME: &'static str = "get_world_market";
    const DESCRIPTION: &'static str = "Resolve a live World spot, perpetual, or lending order book and the current configured mark price.";

    fn run(app: &WorldMarketsApp, args: Self::Args, _ctx: DynToolCallCtx) -> Result<Value, String> {
        let assets = app.client.assets()?;
        let base = asset_by_symbol(&assets, &args.base_symbol)?;
        let quote = args
            .quote_symbol
            .as_deref()
            .map(|symbol| asset_by_symbol(&assets, symbol))
            .transpose()?;
        let product = args.product.to_ascii_lowercase();
        let market = app.client.market(&product, base, quote)?;
        Ok(json!({
            "source": "world-markets-contract",
            "chain_id": CHAIN_ID,
            "exchange": app.client.exchange(),
            "block_number": app.client.block_number()?,
            "market": market,
        }))
    }
}

impl DynAomiTool for PreviewWorldTrade {
    type App = WorldMarketsApp;
    type Args = WorldTradeArgs;
    const NAME: &'static str = "preview_world_trade";
    const DESCRIPTION: &'static str = "Preview a World spot or perpetual intent from live state and return the deterministic mandate verdict. It never stages or executes.";

    fn run(app: &WorldMarketsApp, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        app.trade_preview(args, &ctx)
    }
}

impl DynAomiTool for CheckWorldMandate {
    type App = WorldMarketsApp;
    type Args = WorldTradeArgs;
    const NAME: &'static str = "check_world_mandate";
    const DESCRIPTION: &'static str = "Evaluate one structured World trade intent against the bound mandate and live account/market state. Returns the exact allow or deny rule; it does not execute.";

    fn run(app: &WorldMarketsApp, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        let preview = app.trade_preview(args, &ctx)?;
        Ok(json!({
            "source": preview.get("source"),
            "chain_id": preview.get("chain_id"),
            "block_number": preview.get("block_number"),
            "access": preview.get("access"),
            "standing_brief": preview.get("standing_brief"),
            "intent": preview.pointer("/preview").map(|value| json!({
                "account_id": value.get("account_id"),
                "product": value.get("product"),
                "side": value.get("side"),
                "base_symbol": value.get("base_symbol"),
                "quote_symbol": value.get("quote_symbol"),
                "quantity": value.get("quantity"),
                "mark_price": value.get("mark_price"),
                "estimated_notional": value.get("estimated_notional"),
            })),
            "policy_result": preview.pointer("/preview/policy_result"),
            "executable": false,
        }))
    }
}

impl DynAomiTool for GetWorldAgentPermission {
    type App = WorldMarketsApp;
    type Args = GetWorldAgentPermissionArgs;
    const NAME: &'static str = "get_world_agent_permission";
    const DESCRIPTION: &'static str = "Read the World account owner and permitted-trader list to determine whether the active agent grant is live or revoked.";

    fn run(app: &WorldMarketsApp, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        let account_id = WorldMarketsApp::account_id(&ctx, args.account_id).ok_or_else(|| {
            "[world-markets] no World account id is available for the permission check".to_string()
        })?;
        let actor = args
            .actor_address
            .or_else(|| ctx.attribute_string(&["domain", "evm", "address"]))
            .ok_or_else(|| {
                "[world-markets] no active EVM actor is available for the permission check"
                    .to_string()
            })?;
        Ok(json!({
            "source": "world-markets-contract",
            "chain_id": CHAIN_ID,
            "exchange": app.client.exchange(),
            "block_number": app.client.block_number()?,
            "permission": app.client.agent_permission(account_id, &actor)?,
        }))
    }
}

impl DynAomiTool for GetWorldOpenOrders {
    type App = WorldMarketsApp;
    type Args = GetWorldOpenOrdersArgs;
    const NAME: &'static str = "get_world_open_orders";
    const DESCRIPTION: &'static str = "Read the authorized World account's resting buy and sell orders for one live spot or perpetual market.";

    fn run(app: &WorldMarketsApp, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        let product = normalize_product(&args.product)?;
        let access = app.access(args.account_id, args.wallet_address.as_deref(), &ctx)?;
        let assets = app.client.assets()?;
        let base = asset_by_symbol(&assets, &args.base_symbol)?;
        let quote = asset_by_symbol(&assets, &args.quote_symbol)?;
        let market = app.client.market(product, base, Some(quote))?;
        Ok(json!({
            "source": "world-markets-contract",
            "chain_id": CHAIN_ID,
            "exchange": app.client.exchange(),
            "block_number": app.client.block_number()?,
            "access": access,
            "open_orders": app.client.open_orders(&market, access.account_id)?,
        }))
    }
}

// ============================================================================
// Reporting-service tools (the honest-numbers layer).
//
// Each tool returns DERIVED figures computed deterministically in Rust. The
// message layer may state a number only if it appears in one of these results
// (or in a live contract read). See TELEGRAM-MESSAGING-UX-SPEC §4.1 and §11.
// All numeric arguments are decimal strings so no f64 rounding enters a receipt.
// Every result carries `source` and `executable: false`.
// ============================================================================

/// Parse a decimal string tool argument, surfacing a clear error to the model.
fn report_decimal(value: &str, field: &'static str) -> Result<Decimal, String> {
    parse_decimal(value, field)
        .map_err(|verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))
}

pub(crate) struct PreviewAccountEffect;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct PreviewAccountEffectArgs {
    /// Expected net yield before the action, percent, e.g. "4.3".
    pub(crate) yield_before: String,
    /// Expected net yield after the action, percent, e.g. "8.1".
    pub(crate) yield_after: String,
    /// Directional exposure before, in quote units.
    pub(crate) exposure_before: String,
    /// Directional exposure after, in quote units.
    pub(crate) exposure_after: String,
    /// Available-to-deploy before, in quote units.
    pub(crate) available_before: String,
    /// Available-to-deploy after, in quote units.
    pub(crate) available_after: String,
    /// Risk (RAPV, engine units) before.
    pub(crate) risk_before: String,
    /// Risk (RAPV, engine units) after.
    pub(crate) risk_after: String,
    /// Estimated execution cost, in quote units.
    pub(crate) estimated_cost: String,
    /// Quote symbol, e.g. "USDT".
    pub(crate) quote_symbol: String,
    /// The baseline this counterfactual is measured against, one sentence.
    pub(crate) baseline: String,
}

impl DynAomiTool for PreviewAccountEffect {
    type App = WorldMarketsApp;
    type Args = PreviewAccountEffectArgs;
    const NAME: &'static str = "preview_account_effect";
    const DESCRIPTION: &'static str = "Compute the portfolio-level before/after figures (net yield, exposure, available-to-deploy, RAPV risk, estimated cost) for a proposed action's preview or receipt. Numbers only; never executes.";

    fn run(app: &WorldMarketsApp, args: Self::Args, _ctx: DynToolCallCtx) -> Result<Value, String> {
        let input = AccountEffectInput {
            yield_before: report_decimal(&args.yield_before, "yield_before")?,
            yield_after: report_decimal(&args.yield_after, "yield_after")?,
            exposure_before: report_decimal(&args.exposure_before, "exposure_before")?,
            exposure_after: report_decimal(&args.exposure_after, "exposure_after")?,
            available_before: report_decimal(&args.available_before, "available_before")?,
            available_after: report_decimal(&args.available_after, "available_after")?,
            risk_before: report_decimal(&args.risk_before, "risk_before")?,
            risk_after: report_decimal(&args.risk_after, "risk_after")?,
            estimated_cost: report_decimal(&args.estimated_cost, "estimated_cost")?,
            quote: args.quote_symbol,
            baseline: args.baseline,
        };
        Ok(json!({
            "source": "world-markets-reporting",
            "account_effect": app.reporting.account_effect(&input),
            "executable": false,
        }))
    }
}

pub(crate) struct ComputeResize;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct ComputeResizeArgs {
    /// The user's floor — the ONE number a block cites (RAPV, engine units).
    pub(crate) floor: String,
    /// Largest size that clears the floor, in quote units. Omit if none complies.
    #[serde(default)]
    pub(crate) largest_compliant_size: Option<String>,
    /// Quote symbol.
    pub(crate) quote_symbol: String,
    /// The engine `rule` code that gated the intent, verbatim.
    pub(crate) rule: String,
}

impl DynAomiTool for ComputeResize {
    type App = WorldMarketsApp;
    type Args = ComputeResizeArgs;
    const NAME: &'static str = "compute_resize";
    const DESCRIPTION: &'static str = "For a blocked intent, return the user's floor and the largest compliant size (if any). A block cites exactly one number: the floor. Never executes.";

    fn run(app: &WorldMarketsApp, args: Self::Args, _ctx: DynToolCallCtx) -> Result<Value, String> {
        let largest = args
            .largest_compliant_size
            .as_deref()
            .map(|raw| report_decimal(raw, "largest_compliant_size"))
            .transpose()?;
        let input = ResizeInput {
            floor: report_decimal(&args.floor, "floor")?,
            largest_compliant_size: largest,
            quote: args.quote_symbol,
            rule: args.rule,
        };
        Ok(json!({
            "source": "world-markets-reporting",
            "resize": app.reporting.resize_solution(&input),
            "executable": false,
        }))
    }
}

pub(crate) struct PreviewExit;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct PreviewExitArgs {
    /// Position identifier to price an exit for.
    pub(crate) position_id: String,
}

impl DynAomiTool for PreviewExit {
    type App = WorldMarketsApp;
    type Args = PreviewExitArgs;
    const NAME: &'static str = "preview_exit";
    const DESCRIPTION: &'static str = "Price closing a position before entry is possible: price impact, p90 time-to-flat, and the net-of-everything result. Estimate against the live book; never executes.";

    fn run(app: &WorldMarketsApp, args: Self::Args, _ctx: DynToolCallCtx) -> Result<Value, String> {
        Ok(json!({
            "source": "world-markets-reporting",
            "exit_cost": app.reporting.exit_cost(&args.position_id),
            "executable": false,
        }))
    }
}

pub(crate) struct PlanLargeOrder;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct PlanLargeOrderArgs {
    /// Estimated cost of one market order, in quote units.
    pub(crate) market_order_cost: String,
    /// Estimated cost of the sliced plan, in quote units.
    pub(crate) sliced_cost: String,
    /// Number of slices in the plan.
    pub(crate) slices: u32,
    /// Total window for the plan, minutes.
    pub(crate) window_minutes: u32,
    /// Quote symbol.
    pub(crate) quote_symbol: String,
    /// The baseline the saving is measured against, one sentence.
    pub(crate) baseline: String,
}

impl DynAomiTool for PlanLargeOrder {
    type App = WorldMarketsApp;
    type Args = PlanLargeOrderArgs;
    const NAME: &'static str = "plan_large_order";
    const DESCRIPTION: &'static str = "Compare a single market order against a sliced plan and return the money saved, or a plain $0 when slicing wouldn't help at this size. Estimate; never executes.";

    fn run(app: &WorldMarketsApp, args: Self::Args, _ctx: DynToolCallCtx) -> Result<Value, String> {
        let input = SliceInput {
            market_order_cost: report_decimal(&args.market_order_cost, "market_order_cost")?,
            sliced_cost: report_decimal(&args.sliced_cost, "sliced_cost")?,
            slices: args.slices,
            window_minutes: args.window_minutes,
            quote: args.quote_symbol,
            baseline: args.baseline,
        };
        Ok(json!({
            "source": "world-markets-reporting",
            "slice_plan": app.reporting.slice_plan(&input),
            "executable": false,
        }))
    }
}

pub(crate) struct GetDollarpower;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct GetDollarpowerArgs {
    /// Portfolio identifier. Handover account context is used when omitted.
    #[serde(default)]
    pub(crate) portfolio_id: Option<String>,
}

impl DynAomiTool for GetDollarpower {
    type App = WorldMarketsApp;
    type Args = GetDollarpowerArgs;
    const NAME: &'static str = "get_dollarpower";
    const DESCRIPTION: &'static str = "Return capital efficiency (dollarpower) as a ratio plus its dollar translation (committed vs effective). A status figure, never a headline; never executes.";

    fn run(app: &WorldMarketsApp, args: Self::Args, ctx: DynToolCallCtx) -> Result<Value, String> {
        let portfolio_id = args
            .portfolio_id
            .or_else(|| WorldMarketsApp::account_id(&ctx, None).map(|id| id.to_string()))
            .unwrap_or_default();
        Ok(json!({
            "source": "world-markets-reporting",
            "dollarpower": app.reporting.dollarpower(&portfolio_id),
            "executable": false,
        }))
    }
}

pub(crate) struct SimulateGuardianUnwind;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct GuardianCandidateArg {
    /// Human label for the leg, e.g. "close 0.4 ETH short".
    pub(crate) label: String,
    /// Risk-score points recovered if this leg fully closes (engine units).
    pub(crate) delta_score: String,
    /// Slippage + fees (+ accrued interest for a loan leg) to fully close.
    pub(crate) exit_cost: String,
    /// True when closing this leg leaves a worse residual (e.g. breaks a hedge).
    #[serde(default)]
    pub(crate) breaks_structure_into_worse_residual: bool,
    /// True when this leg reduces directional exposure.
    #[serde(default)]
    pub(crate) reduces_directional_exposure: bool,
    /// True when this holding is protected by policy (a veto, never a candidate).
    #[serde(default)]
    pub(crate) protected: bool,
    /// True when closing this leg touches ETH.
    #[serde(default)]
    pub(crate) is_eth: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct SimulateGuardianUnwindArgs {
    /// Candidate legs the guardian may close.
    pub(crate) candidates: Vec<GuardianCandidateArg>,
    /// Current risk score (engine units).
    pub(crate) current_score: String,
    /// Recovery target to reach (engine units).
    pub(crate) recovery_target: String,
    /// Standing preference: "cheapest_safe" (default) or "protect_eth".
    #[serde(default)]
    pub(crate) preference: Option<String>,
    /// Whether the emergency slippage limit can be met at required size.
    #[serde(default = "default_true")]
    pub(crate) emergency_slippage_reachable: bool,
}

fn default_true() -> bool {
    true
}

impl DynAomiTool for SimulateGuardianUnwind {
    type App = WorldMarketsApp;
    type Args = SimulateGuardianUnwindArgs;
    const NAME: &'static str = "simulate_guardian_unwind";
    const DESCRIPTION: &'static str = "Run the cheapest-safe unwind algorithm over candidate legs and return the chosen order, per-step recovery and cost, total cost, and what a protection preference kept. For fire drills and guardian reports; never executes.";

    fn run(app: &WorldMarketsApp, args: Self::Args, _ctx: DynToolCallCtx) -> Result<Value, String> {
        let preference = match args.preference.as_deref() {
            None | Some("cheapest_safe") => GuardianPreference::CheapestSafe,
            Some("protect_eth") => GuardianPreference::ProtectEth,
            Some(other) => {
                return Err(format!(
                    "[world-markets] unknown guardian preference {other:?}; use cheapest_safe or protect_eth"
                ));
            }
        };
        let mut candidates = Vec::with_capacity(args.candidates.len());
        for candidate in &args.candidates {
            candidates.push(UnwindCandidate {
                label: candidate.label.clone(),
                delta_score: report_decimal(&candidate.delta_score, "delta_score")?,
                exit_cost: report_decimal(&candidate.exit_cost, "exit_cost")?,
                breaks_structure_into_worse_residual: candidate
                    .breaks_structure_into_worse_residual,
                reduces_directional_exposure: candidate.reduces_directional_exposure,
                protected: candidate.protected,
                is_eth: candidate.is_eth,
            });
        }
        let plan = app.reporting.guardian_unwind(
            &candidates,
            report_decimal(&args.current_score, "current_score")?,
            report_decimal(&args.recovery_target, "recovery_target")?,
            preference,
            args.emergency_slippage_reachable,
        );
        Ok(json!({
            "source": "world-markets-reporting",
            "unwind_plan": plan,
            "executable": false,
        }))
    }
}

pub(crate) struct CheckNegativeCarry;

#[derive(Debug, Deserialize, JsonSchema)]
pub(crate) struct CheckNegativeCarryArgs {
    /// Position identifier to inspect.
    pub(crate) position_id: String,
}

impl DynAomiTool for CheckNegativeCarry {
    type App = WorldMarketsApp;
    type Args = CheckNegativeCarryArgs;
    const NAME: &'static str = "check_negative_carry";
    const DESCRIPTION: &'static str = "Return the negative-carry regime state for a basis position: days negative, the pre-authorized trigger window, average daily carry, and whether the plan has fired. Never executes.";

    fn run(app: &WorldMarketsApp, args: Self::Args, _ctx: DynToolCallCtx) -> Result<Value, String> {
        Ok(json!({
            "source": "world-markets-reporting",
            "carry_state": app.reporting.carry_state(&args.position_id),
            "executable": false,
        }))
    }
}

fn value_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| {
        value.as_u64().or_else(|| {
            let raw = value.as_str()?;
            raw.parse::<u64>()
                .ok()
                .or_else(|| raw.strip_prefix("world-")?.parse::<u64>().ok())
        })
    })
}

fn normalize_product(product: &str) -> Result<&'static str, String> {
    match product.to_ascii_lowercase().as_str() {
        "spot" => Ok("spot"),
        "perp" | "perpetual" => Ok("perp"),
        _ => Err("[world-markets] trade tools support spot and perp only".to_string()),
    }
}

fn current_position(
    account: &Account,
    product: &str,
    base_symbol: &str,
) -> Result<Decimal, String> {
    let value = match product {
        "perp" => account
            .perpetual_positions
            .iter()
            .find(|position| position.symbol.eq_ignore_ascii_case(base_symbol))
            .map(|position| position.quantity.as_str()),
        "spot" => account
            .balances
            .iter()
            .find(|balance| balance.symbol.eq_ignore_ascii_case(base_symbol))
            .map(|balance| balance.balance.as_str()),
        _ => None,
    }
    .unwrap_or("0");
    parse_decimal(value, "current_position_quantity")
        .map_err(|verdict: Verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numeric_and_prefixed_account_references() {
        assert_eq!(value_u64(Some(&json!(42))), Some(42));
        assert_eq!(value_u64(Some(&json!("42"))), Some(42));
        assert_eq!(value_u64(Some(&json!("world-42"))), Some(42));
        assert_eq!(value_u64(Some(&json!("other-42"))), None);
    }

    #[test]
    #[ignore = "requires live UniFi RPC"]
    fn live_preview_uses_actor_account_and_mandate_context() {
        let app = WorldMarketsApp::default();
        let account_id = 1_577;
        let owner = app.client.owner_for(account_id).unwrap();
        let attributes = json!({
            "domain": { "evm": { "address": format!("{owner:#x}") } },
            "handover_mandate": {
                "version": 1,
                "markets": [{ "product": "perp", "base": "WETH", "quote": "USDT" }],
                "max_position_notional": { "amount": "25000", "quote": "USDT" },
                "max_leverage": "3",
                "min_risk_adjusted_portfolio_value": { "amount": "1", "quote": "USDT" },
                "halt_if_eligible_for_liquidation": true,
                "can_withdraw": false,
                "account": { "id": account_id },
                "brief": { "objective": "watch risk" }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let ctx = DynToolCallCtx {
            session_id: "live-world-preview".to_string(),
            tool_name: "preview_world_trade".to_string(),
            call_id: "live-world-preview-1".to_string(),
            state_attributes: attributes,
            secrets: Default::default(),
        };
        let value = app
            .trade_preview(
                WorldTradeArgs {
                    product: "perp".to_string(),
                    side: "buy".to_string(),
                    base_symbol: "WETH".to_string(),
                    quote_symbol: "USDT".to_string(),
                    quantity: "0.01".to_string(),
                    account_id: None,
                    wallet_address: None,
                },
                &ctx,
            )
            .unwrap();
        assert_eq!(value["access"]["authorization"], "owner");
        assert_eq!(value["standing_brief"]["objective"], "watch risk");
        assert_eq!(value["preview"]["policy_result"]["status"], "deny");
        assert_eq!(value["preview"]["policy_result"]["rule"], "portfolio_floor");
        assert_eq!(value["preview"]["executable"], false);
    }

    fn empty_ctx(tool: &str) -> DynToolCallCtx {
        DynToolCallCtx {
            session_id: "test".to_string(),
            tool_name: tool.to_string(),
            call_id: "test-1".to_string(),
            state_attributes: Default::default(),
            secrets: Default::default(),
        }
    }

    // Task 2.1: a zero-edge slice through the TOOL returns the $0 null case,
    // never a fabricated saving (§4.1 "null results are results").
    #[test]
    fn plan_large_order_tool_reports_zero_edge() {
        let app = WorldMarketsApp::default();
        let value = PlanLargeOrder::run(
            &app,
            PlanLargeOrderArgs {
                market_order_cost: "0.05".to_string(),
                sliced_cost: "0.05".to_string(),
                slices: 1,
                window_minutes: 0,
                quote_symbol: "USDT".to_string(),
                baseline: "book at quote time".to_string(),
            },
            empty_ctx("plan_large_order"),
        )
        .unwrap();
        assert_eq!(value["source"], "world-markets-reporting");
        assert_eq!(value["executable"], false);
        assert_eq!(value["slice_plan"]["null_case"], true);
        assert_eq!(value["slice_plan"]["saved"]["value"], "0");
    }

    // Every reporting tool tags its source and marks itself non-executable.
    #[test]
    fn reporting_tools_are_sourced_and_non_executable() {
        let app = WorldMarketsApp::default();

        let effect = PreviewAccountEffect::run(
            &app,
            PreviewAccountEffectArgs {
                yield_before: "4.3".to_string(),
                yield_after: "8.1".to_string(),
                exposure_before: "0".to_string(),
                exposure_after: "0".to_string(),
                available_before: "31400".to_string(),
                available_after: "28100".to_string(),
                risk_before: "7400".to_string(),
                risk_after: "6800".to_string(),
                estimated_cost: "8.72".to_string(),
                quote_symbol: "USDT".to_string(),
                baseline: "current book".to_string(),
            },
            empty_ctx("preview_account_effect"),
        )
        .unwrap();
        assert_eq!(effect["source"], "world-markets-reporting");
        assert_eq!(effect["executable"], false);
        // Unchanged exposure is flagged so copy can say "unchanged".
        assert_eq!(
            effect["account_effect"]["directional_exposure"]["unchanged"],
            true
        );

        let dp = GetDollarpower::run(
            &app,
            GetDollarpowerArgs { portfolio_id: None },
            empty_ctx("get_dollarpower"),
        )
        .unwrap();
        assert_eq!(dp["source"], "world-markets-reporting");
        assert_eq!(dp["executable"], false);
    }

    // The guardian tool runs the algorithm end-to-end and surfaces the plan.
    #[test]
    fn guardian_tool_runs_and_rejects_bad_preference() {
        let app = WorldMarketsApp::default();
        let ok = SimulateGuardianUnwind::run(
            &app,
            SimulateGuardianUnwindArgs {
                candidates: vec![GuardianCandidateArg {
                    label: "close A".to_string(),
                    delta_score: "1.5".to_string(),
                    exit_cost: "50".to_string(),
                    breaks_structure_into_worse_residual: false,
                    reduces_directional_exposure: true,
                    protected: false,
                    is_eth: false,
                }],
                current_score: "6.0".to_string(),
                recovery_target: "7.0".to_string(),
                preference: Some("cheapest_safe".to_string()),
                emergency_slippage_reachable: true,
            },
            empty_ctx("simulate_guardian_unwind"),
        )
        .unwrap();
        assert_eq!(ok["source"], "world-markets-reporting");
        assert_eq!(ok["unwind_plan"]["reached_target"], true);
        assert_eq!(ok["unwind_plan"]["steps"].as_array().unwrap().len(), 1);

        let bad = SimulateGuardianUnwind::run(
            &app,
            SimulateGuardianUnwindArgs {
                candidates: vec![],
                current_score: "6.0".to_string(),
                recovery_target: "7.0".to_string(),
                preference: Some("do_whatever".to_string()),
                emergency_slippage_reachable: true,
            },
            empty_ctx("simulate_guardian_unwind"),
        );
        assert!(bad.is_err());
    }

    // A block's resize surfaces the floor and the engine rule verbatim.
    #[test]
    fn compute_resize_carries_floor_and_rule() {
        let app = WorldMarketsApp::default();
        let value = ComputeResize::run(
            &app,
            ComputeResizeArgs {
                floor: "6000".to_string(),
                largest_compliant_size: Some("18500".to_string()),
                quote_symbol: "USDT".to_string(),
                rule: "portfolio_floor".to_string(),
            },
            empty_ctx("compute_resize"),
        )
        .unwrap();
        assert_eq!(value["resize"]["rule"], "portfolio_floor");
        assert_eq!(value["resize"]["floor"]["value"], "6000");
        assert_eq!(value["resize"]["largest_compliant_size"]["value"], "18500");
    }
}
