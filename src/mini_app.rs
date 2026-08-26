//! Public Mini App snapshot: live contract + reporting figures only.
//!
//! 24h change and isolated leverage are omitted (`null`) until a reporting
//! function produces them. Dollarpower is computed from this account's NAV and
//! gross notionals — the fixture `get_dollarpower` book is not this user's book.

use std::str::FromStr;
use std::sync::OnceLock;

use rust_decimal::Decimal;
use rust_decimal::RoundingStrategy;
use rust_decimal::prelude::ToPrimitive;
use serde::Serialize;
use serde_json::Value;

use crate::brain::BrainClient;
use crate::client::{Account, Asset, BASE_TOKEN_ID, WorldClient};
use crate::liquidation_risk::{self, PortfolioMetrics};
use crate::lookups::notional_usdt;
use crate::mandate::{Mandate, parse_decimal};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PortfolioResponse {
    pub positions: Vec<PositionRow>,
    pub dollarpower: DollarpowerSnapshot,
    pub risk: RiskSnapshot,
    pub total_usd_value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_change_24h_pct: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub floor: Option<String>,
    pub flags: MiniFlags,
    pub block_number: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PositionRow {
    pub symbol: String,
    pub quantity: String,
    pub usd_value: String,
    pub change_24h_pct: Option<String>,
    pub leverage: Option<String>,
    pub change_direction: Option<String>,
    pub asset_type: String,
    pub group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    pub can_exit: bool,
    pub watch_count: u32,
    pub keywords: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DollarpowerSnapshot {
    pub ratio: String,
    pub equivalent_usd: String,
    pub committed_usd: String,
    pub fill_pct: String,
    pub is_estimate: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RiskSnapshot {
    #[serde(rename = "liquidation_score")]
    pub score: u8,
    pub band: String,
    pub distance_from_floor_pct: Option<String>,
    pub is_estimate: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MiniFlags {
    pub primary_view: String,
    pub jobline_negative: bool,
    pub family: String,
}

struct PositionDraft {
    symbol: String,
    quantity: Decimal,
    usd: Decimal,
    asset_type: &'static str,
    side: Option<String>,
}

fn shared_client() -> &'static WorldClient {
    static CLIENT: OnceLock<WorldClient> = OnceLock::new();
    CLIENT.get_or_init(WorldClient::default)
}

/// Parse `WORLD_ACCOUNT_ID` (`17` or `world-17`).
pub fn account_id_from_env() -> Option<u64> {
    parse_account_id(&std::env::var("WORLD_ACCOUNT_ID").ok()?)
}

pub fn parse_account_id(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(id) = trimmed.parse::<u64>() {
        return Some(id);
    }
    let rest = trimmed
        .strip_prefix("world-")
        .or_else(|| trimmed.strip_prefix("WORLD-"))?;
    rest.parse().ok()
}

pub fn load_portfolio(account_id: u64) -> Result<PortfolioResponse, String> {
    let client = shared_client();
    let assets = client.assets()?;
    let account = client.account(account_id, &assets)?;
    let block_number = client.block_number()?;
    let metrics = liquidation_risk::compute_metrics(client, &account, &assets, block_number)?;
    let floor = mandate_floor();
    assemble(client, &account, &assets, &metrics, floor, block_number)
}

#[derive(Debug, Clone, Serialize)]
pub struct ChartSnapshot {
    pub symbol: String,
    pub feed_symbol: String,
    pub period: String,
    pub period_label: String,
    pub bar_label: String,
    pub source: String,
    pub candles: Vec<ChartBar>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChartBar {
    pub t: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
}

#[derive(Debug)]
pub enum ChartError {
    BadRequest(String),
    NotFound(String),
    Upstream(String),
}

impl std::fmt::Display for ChartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadRequest(m) | Self::NotFound(m) | Self::Upstream(m) => write!(f, "{m}"),
        }
    }
}

/// Live OHLC for the Mini App chart (same Yahoo feed as the Telegram PNG).
pub fn load_chart(ticker: &str, period: &str) -> Result<ChartSnapshot, ChartError> {
    use crate::marketdata::{
        ChartRange, FeedError, feed_from_env, load_or_refresh, normalize_ticker, resolve_ticker,
    };

    let range = ChartRange::parse(period).ok_or_else(|| {
        ChartError::BadRequest("[world-markets] period must be d, w, or m".into())
    })?;
    let requested = normalize_ticker(ticker)
        .ok_or_else(|| ChartError::BadRequest("[world-markets] ticker is empty".into()))?;
    let feed = feed_from_env().map_err(ChartError::Upstream)?;
    let universe = load_or_refresh(feed.as_ref()).map_err(ChartError::Upstream)?;
    let resolved = resolve_ticker(&requested, &universe);
    let series = match feed.candles(&resolved.feed_symbol, range) {
        Ok(series) => series,
        Err(FeedError::NotFound { symbol }) => {
            return Err(ChartError::NotFound(format!(
                "[world-markets] no chart for {symbol}"
            )));
        }
        Err(err) => return Err(ChartError::Upstream(err.to_string())),
    };
    Ok(ChartSnapshot {
        symbol: requested,
        feed_symbol: series.feed_symbol,
        period: range.as_token().to_string(),
        period_label: range.label().to_string(),
        bar_label: range.bar_label().to_string(),
        source: series.source,
        candles: series
            .candles
            .into_iter()
            .map(|c| ChartBar {
                t: c.ts,
                o: c.open,
                h: c.high,
                l: c.low,
                c: c.close,
            })
            .collect(),
    })
}

fn mandate_floor() -> Option<Decimal> {
    let path = std::env::var("WORLD_MANDATE_PATH").unwrap_or_default();
    let path_lc = path.trim().to_ascii_lowercase();
    let has_json = std::env::var("WORLD_MANDATE_JSON")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let real_file = !path_lc.is_empty()
        && !matches!(
            path_lc.as_str(),
            "placeholder" | "dev" | "-" | "none" | "off" | "missing"
        );
    if !has_json && !real_file {
        return None;
    }
    let mandate = Mandate::bound(None).ok()?;
    parse_decimal(
        &mandate.min_risk_adjusted_portfolio_value.amount,
        "min_risk_adjusted_portfolio_value",
    )
    .ok()
}

fn assemble(
    client: &WorldClient,
    account: &Account,
    assets: &[Asset],
    metrics: &PortfolioMetrics,
    floor: Option<Decimal>,
    block_number: u64,
) -> Result<PortfolioResponse, String> {
    let base = assets
        .iter()
        .find(|asset| asset.token_id == BASE_TOKEN_ID)
        .ok_or_else(|| "[world-markets] base token config is missing".to_string())?;
    let by_id: std::collections::BTreeMap<u32, &Asset> =
        assets.iter().map(|asset| (asset.token_id, asset)).collect();

    let mut drafts = Vec::new();
    let mut had_unpriced = false;
    let mut had_any = false;

    for perp in &account.perpetual_positions {
        let qty = parse_qty(&perp.quantity, "perp_quantity")?;
        if qty.is_zero() {
            continue;
        }
        had_any = true;
        let Some(asset) = by_id.get(&perp.token_id) else {
            had_unpriced = true;
            continue;
        };
        match notional_usdt(client, asset, base, qty.abs()) {
            Ok(usd) => drafts.push(PositionDraft {
                symbol: perp.symbol.clone(),
                quantity: qty.abs(),
                usd,
                asset_type: "perp",
                side: Some(perp.side.clone()),
            }),
            Err(_) => had_unpriced = true,
        }
    }

    for lend in &account.lending_positions {
        let Some(asset) = by_id.get(&lend.token_id) else {
            continue;
        };
        let lender = parse_qty(&lend.lender_quantity, "lender_quantity")?;
        let borrower = parse_qty(&lend.borrower_quantity, "borrower_quantity")?;
        if !lender.is_zero() {
            had_any = true;
            match notional_usdt(client, asset, base, lender.abs()) {
                Ok(usd) => drafts.push(PositionDraft {
                    symbol: lend.symbol.clone(),
                    quantity: lender.abs(),
                    usd,
                    asset_type: "lend",
                    side: None,
                }),
                Err(_) => had_unpriced = true,
            }
        }
        if !borrower.is_zero() {
            had_any = true;
            match notional_usdt(client, asset, base, borrower.abs()) {
                Ok(usd) => drafts.push(PositionDraft {
                    symbol: lend.symbol.clone(),
                    quantity: borrower.abs(),
                    usd,
                    asset_type: "borrow",
                    side: None,
                }),
                Err(_) => had_unpriced = true,
            }
        }
    }

    for balance in &account.balances {
        let qty = parse_qty(&balance.balance, "balance")?;
        if qty.is_zero() {
            continue;
        }
        had_any = true;
        let Some(asset) = by_id.get(&balance.token_id) else {
            had_unpriced = true;
            continue;
        };
        match notional_usdt(client, asset, base, qty.abs()) {
            Ok(usd) => drafts.push(PositionDraft {
                symbol: balance.symbol.clone(),
                quantity: qty.abs(),
                usd,
                asset_type: "spot",
                side: None,
            }),
            Err(_) => had_unpriced = true,
        }
    }

    if had_any && drafts.is_empty() {
        return Err("[world-markets] position marks unavailable".to_string());
    }

    drafts.sort_by(|a, b| b.usd.cmp(&a.usd).then_with(|| a.symbol.cmp(&b.symbol)));

    let mut total = Decimal::ZERO;
    let mut positions = Vec::with_capacity(drafts.len());
    for row in &drafts {
        total += row.usd;
        positions.push(PositionRow {
            symbol: row.symbol.clone(),
            quantity: format_qty(row.quantity),
            usd_value: two_dp(row.usd),
            change_24h_pct: None,
            leverage: None,
            change_direction: None,
            asset_type: row.asset_type.to_string(),
            group: group_for(row.asset_type).to_string(),
            extra: extra_for(&row.symbol, row.asset_type, floor),
            side: row.side.clone(),
            can_exit: row.asset_type != "lend",
            watch_count: 0,
            keywords: format!(
                "{} {} {}",
                row.symbol,
                row.asset_type,
                row.side.as_deref().unwrap_or("")
            ),
        });
    }

    let committed = parse_decimal(&metrics.net_asset_value, "net_asset_value")
        .map_err(|v| format!("[world-markets] {}: {}", v.rule, v.detail))?;
    let equivalent = if total > Decimal::ZERO {
        total
    } else {
        committed
    };
    let is_estimate = had_unpriced;
    let ratio = if committed > Decimal::ZERO {
        (equivalent / committed).round_dp_with_strategy(1, RoundingStrategy::MidpointAwayFromZero)
    } else {
        Decimal::ZERO
    };

    let rapv = parse_decimal(
        &account.risk_adjusted_portfolio_value,
        "risk_adjusted_portfolio_value",
    )
    .map_err(|v| format!("[world-markets] {}: {}", v.rule, v.detail))?;
    let score = risk_score(metrics, account.eligible_for_liquidation);
    let band = spec_band(score).to_string();
    let distance = if score < 9 {
        distance_pct(rapv, floor)
    } else {
        None
    };

    Ok(PortfolioResponse {
        positions,
        dollarpower: DollarpowerSnapshot {
            ratio: ratio.normalize().to_string(),
            equivalent_usd: two_dp(equivalent),
            committed_usd: two_dp(committed),
            fill_pct: fill_pct(committed, equivalent),
            is_estimate,
        },
        risk: RiskSnapshot {
            score,
            band,
            distance_from_floor_pct: distance,
            is_estimate: false,
        },
        total_usd_value: two_dp(total),
        total_change_24h_pct: None,
        floor: floor.map(two_dp),
        flags: mini_flags(),
        block_number,
    })
}

fn parse_qty(raw: &str, field: &'static str) -> Result<Decimal, String> {
    parse_decimal(raw, field).map_err(|v| format!("[world-markets] {}: {}", v.rule, v.detail))
}

pub fn spec_band(score: u8) -> &'static str {
    match score {
        0..=5 => "safe",
        6..=8 => "elevated",
        _ => "high",
    }
}

pub fn mini_flags() -> MiniFlags {
    MiniFlags {
        primary_view: std::env::var("WORLD_MINI_PRIMARY_VIEW")
            .ok()
            .filter(|v| v == "portfolio" || v == "ledger")
            .unwrap_or_else(|| "ledger".to_string()),
        jobline_negative: std::env::var("WORLD_MINI_JOBLINE_NEGATIVE")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false),
        family: std::env::var("WORLD_MINI_FAMILY")
            .ok()
            .filter(|v| v == "violet" || v == "blue")
            .unwrap_or_else(|| "blue".to_string()),
    }
}

fn group_for(asset_type: &str) -> &'static str {
    match asset_type {
        "perp" => "positions",
        "lend" | "borrow" => "lending",
        _ => "holdings",
    }
}

fn extra_for(symbol: &str, asset_type: &str, floor: Option<Decimal>) -> Option<String> {
    let upper = symbol.to_ascii_uppercase();
    if upper.contains("STETH") {
        return Some("accrues in price".to_string());
    }
    if upper.contains("XETH") {
        return Some("borrow leg backs it".to_string());
    }
    match asset_type {
        "perp" => floor.map(|value| format!("floor ${}", two_dp(value))),
        "lend" => Some("fixed term".to_string()),
        "spot" => Some("free collateral".to_string()),
        _ => None,
    }
}

pub fn apply_watch_counts(
    portfolio: &mut PortfolioResponse,
    counts: &serde_json::Map<String, Value>,
) {
    for row in &mut portfolio.positions {
        let key = row.symbol.to_ascii_uppercase();
        let n = counts
            .get(&key)
            .and_then(Value::as_u64)
            .or_else(|| {
                counts.iter().find_map(|(k, v)| {
                    if key.contains(&k.to_ascii_uppercase())
                        || k.to_ascii_uppercase().contains(&key)
                    {
                        v.as_u64()
                    } else {
                        None
                    }
                })
            })
            .unwrap_or(0) as u32;
        row.watch_count = n;
    }
}

pub fn load_ledger_summary(account_id: u64) -> Result<Value, String> {
    BrainClient::from_env().ledger_summary(account_id)
}

pub fn load_ledger(account_id: u64) -> Result<Value, String> {
    BrainClient::from_env().ledger(account_id)
}

pub fn load_instruction(account_id: u64, id: &str) -> Result<Value, String> {
    BrainClient::from_env().ledger_one(account_id, id)
}

pub fn submit_compose(body: &Value) -> Result<Value, String> {
    BrainClient::from_env().compose(body)
}

fn risk_score(metrics: &PortfolioMetrics, eligible: bool) -> u8 {
    if eligible {
        return 10;
    }
    let parsed = Decimal::from_str(&metrics.liquidation_risk).unwrap_or(Decimal::ZERO);
    let rounded = parsed.round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
    rounded.to_u8().unwrap_or(0).min(10)
}

pub fn fill_pct(committed: Decimal, equivalent: Decimal) -> String {
    if equivalent <= Decimal::ZERO {
        return "0".to_string();
    }
    let pct = (committed / equivalent * Decimal::from(100))
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
        .max(Decimal::ZERO)
        .min(Decimal::from(100));
    pct.normalize().to_string()
}

fn distance_pct(rapv: Decimal, floor: Option<Decimal>) -> Option<String> {
    let floor = floor?;
    if rapv <= Decimal::ZERO {
        return None;
    }
    let pct = ((rapv - floor) / rapv * Decimal::from(100))
        .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
        .max(Decimal::ZERO);
    Some(pct.normalize().to_string())
}

pub fn format_qty(value: Decimal) -> String {
    let v = value.normalize();
    let abs = v.abs();
    if abs.is_zero() {
        return "0".to_string();
    }
    if abs < Decimal::new(1, 2) {
        return v.normalize().to_string();
    }
    if abs >= Decimal::from(100) {
        return v
            .round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero)
            .normalize()
            .to_string();
    }
    v.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero)
        .normalize()
        .to_string()
}

pub fn two_dp(value: Decimal) -> String {
    let rounded = value.round_dp_with_strategy(2, RoundingStrategy::MidpointAwayFromZero);
    let s = rounded.to_string();
    if let Some(i) = s.find('.') {
        match s.len() - i - 1 {
            0 => format!("{s}00"),
            1 => format!("{s}0"),
            _ => s,
        }
    } else {
        format!("{s}.00")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_id_parses_bare_and_prefixed() {
        assert_eq!(parse_account_id("17"), Some(17));
        assert_eq!(parse_account_id("world-17"), Some(17));
        assert_eq!(parse_account_id("WORLD-99"), Some(99));
        assert_eq!(parse_account_id(""), None);
        assert_eq!(parse_account_id("wallet-17"), None);
    }

    #[test]
    fn bands_follow_spec_not_engine_eight() {
        assert_eq!(spec_band(0), "safe");
        assert_eq!(spec_band(5), "safe");
        assert_eq!(spec_band(6), "elevated");
        assert_eq!(spec_band(8), "elevated");
        assert_eq!(spec_band(9), "high");
        assert_eq!(spec_band(10), "high");
    }

    #[test]
    fn fill_is_committed_over_equivalent() {
        assert_eq!(fill_pct(Decimal::from(25), Decimal::from(100)), "25");
        assert_eq!(fill_pct(Decimal::from(10), Decimal::ZERO), "0");
        assert_eq!(fill_pct(Decimal::from(200), Decimal::from(100)), "100");
    }

    #[test]
    fn quantity_keeps_small_precision() {
        assert_eq!(format_qty(Decimal::new(5, 4)), "0.0005");
        assert_eq!(format_qty(Decimal::new(235, 2)), "2.35");
        assert_eq!(format_qty(Decimal::from(12800)), "12800");
    }

    #[test]
    fn money_always_two_dp() {
        assert_eq!(two_dp(Decimal::from(8432)), "8432.00");
        assert_eq!(two_dp(Decimal::new(84325, 1)), "8432.50");
    }

    #[test]
    fn copy_module_strings_have_no_exclamation() {
        let src = include_str!("../mini-app/static/copy.js");
        let mut quoted = String::new();
        let mut in_str = false;
        let mut chars = src.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                if in_str && let Some(next) = chars.next() {
                    quoted.push(next);
                }
                continue;
            }
            if ch == '"' {
                if in_str {
                    quoted.push('\n');
                }
                in_str = !in_str;
                continue;
            }
            if in_str {
                quoted.push(ch);
            }
        }
        for line in quoted.lines() {
            assert!(
                !line.contains('!'),
                "copy strings must not use exclamation marks: {line}"
            );
        }
    }

    #[test]
    fn risk_json_uses_spec_liquidation_score_key() {
        let json = serde_json::to_value(&RiskSnapshot {
            score: 3,
            band: "safe".into(),
            distance_from_floor_pct: Some("47".into()),
            is_estimate: false,
        })
        .unwrap();
        assert_eq!(json["liquidation_score"], 3);
        assert!(json.get("score").is_none());
    }

    #[test]
    fn load_chart_rejects_bad_period() {
        match load_chart("AAPL", "year") {
            Err(ChartError::BadRequest(_)) => {}
            other => panic!("expected bad request, got {other:?}"),
        }
        match load_chart("   ", "d") {
            Err(ChartError::BadRequest(_)) => {}
            other => panic!("expected empty ticker, got {other:?}"),
        }
    }

    #[test]
    fn distance_omits_without_floor_or_nonpositive_rapv() {
        assert_eq!(distance_pct(Decimal::from(100), None), None);
        assert_eq!(distance_pct(Decimal::ZERO, Some(Decimal::from(10))), None);
        assert_eq!(
            distance_pct(Decimal::from(100), Some(Decimal::from(53))),
            Some("47".to_string())
        );
    }
}
