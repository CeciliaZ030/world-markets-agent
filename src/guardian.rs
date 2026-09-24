//! The guardian: when the account breaches its signed floor, unwind the
//! cheapest legs that bring it back, then hold every risk-adding order until
//! the user checks in. Every figure here is derived from live state in Rust;
//! the model chooses nothing about the order of legs or their size.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

use crate::client::{Account, Asset, BASE_TOKEN_ID, WorldClient};
use crate::liquidation_risk::{TradeIntent, project_post_trade};
use crate::mandate::{Verdict, parse_decimal};

/// Slippage tolerance an unwind leg accepts: wider than an ordinary market
/// order because the point is to get flat, and the cost it implies is what
/// the plan reports as the cost of protection.
pub(crate) const EMERGENCY_SLIPPAGE: Decimal = Decimal::from_parts(2, 0, 0, false, 2);

/// A standing guardian preference set in chat. Never a signed policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GuardianPreference {
    /// Run the cheapest-safe ranking unmodified (the default).
    CheapestSafe,
    /// Demote ETH-bearing legs; chosen only if nothing else reaches the floor,
    /// and reported honestly when overridden.
    ProtectEth,
}

impl GuardianPreference {
    pub(crate) fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|raw| !raw.is_empty()) {
            None | Some("cheapest_safe") => Ok(Self::CheapestSafe),
            Some("protect_eth") => Ok(Self::ProtectEth),
            Some(other) => Err(format!(
                "[world-markets] unknown guardian preference {other:?}; use cheapest_safe or protect_eth"
            )),
        }
    }
}

/// One venue order that closes a position, sized to close all of it.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct UnwindLeg {
    pub(crate) product: &'static str,
    /// The closing side: `sell` a long or a holding, `buy` back a short.
    pub(crate) side: &'static str,
    #[serde(skip_serializing)]
    pub(crate) base: Asset,
    #[serde(skip_serializing)]
    pub(crate) quote: Asset,
    pub(crate) base_symbol: String,
    pub(crate) quantity: Decimal,
    pub(crate) mark: Decimal,
}

/// A leg the guardian may close, with the live figures the ranking needs.
#[derive(Debug, Clone)]
pub(crate) struct UnwindCandidate {
    pub(crate) label: String,
    pub(crate) leg: UnwindLeg,
    /// Risk-adjusted portfolio value gained by closing the whole leg, from the
    /// same post-trade projection the mandate uses. Quote units.
    pub(crate) delta_rapv: Decimal,
    /// The projection's post-trade RAPV, kept so the mandate leg check uses
    /// the same figure the ranking did.
    pub(crate) post_rapv: Decimal,
    /// Slippage the leg accepts to get flat now: quantity × mark × emergency
    /// slippage. An estimate; fees are not modelled.
    pub(crate) exit_cost: Decimal,
    /// Closing this leg lowers RAPV — it was the hedge. Never a candidate.
    pub(crate) breaks_structure: bool,
    /// Closing this leg reduces directional exposure (a perp), preferred on ties.
    pub(crate) reduces_directional_exposure: bool,
    /// The user protects this holding by preference: a veto, never a candidate.
    pub(crate) protected: bool,
    pub(crate) is_eth: bool,
}

impl UnwindCandidate {
    /// Every leg the account could close right now, scored against live state:
    /// each open perp (closed towards flat) and each spot holding other than
    /// the quote asset (sold to quote). Legs whose post-trade RAPV cannot be
    /// proven are left out rather than guessed.
    pub(crate) fn from_account(
        client: &WorldClient,
        account: &Account,
        assets: &[Asset],
        protect: &[String],
    ) -> Result<Vec<Self>, String> {
        let quote = assets
            .iter()
            .find(|asset| asset.token_id == BASE_TOKEN_ID)
            .cloned()
            .ok_or_else(|| "[world-markets] quote asset config is missing".to_string())?;
        let live_rapv = parse_decimal(
            &account.risk_adjusted_portfolio_value,
            "risk_adjusted_portfolio_value",
        )
        .map_err(|verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))?;
        let is_protected = |symbol: &str| protect.iter().any(|p| p.eq_ignore_ascii_case(symbol));

        let mut legs: Vec<(String, &'static str, &'static str, Asset, Decimal, bool)> = Vec::new();
        for position in &account.perpetual_positions {
            let quantity =
                parse_decimal(&position.quantity, "perp_quantity").map_err(|verdict| {
                    format!("[world-markets] {}: {}", verdict.rule, verdict.detail)
                })?;
            if quantity.is_zero() {
                continue;
            }
            let Some(base) = assets
                .iter()
                .find(|asset| asset.token_id == position.token_id)
            else {
                continue;
            };
            let side = if quantity.is_sign_positive() {
                "sell"
            } else {
                "buy"
            };
            let label = format!(
                "close {} {} perp {}",
                quantity.abs().normalize(),
                base.symbol,
                if quantity.is_sign_positive() {
                    "long"
                } else {
                    "short"
                }
            );
            legs.push((label, "perp", side, base.clone(), quantity.abs(), true));
        }
        for balance in &account.balances {
            if balance.token_id == BASE_TOKEN_ID {
                continue;
            }
            let available = parse_decimal(&balance.available, "available").map_err(|verdict| {
                format!("[world-markets] {}: {}", verdict.rule, verdict.detail)
            })?;
            if available <= Decimal::ZERO {
                continue;
            }
            let Some(base) = assets
                .iter()
                .find(|asset| asset.token_id == balance.token_id)
            else {
                continue;
            };
            let label = format!("sell {} {} spot", available.normalize(), base.symbol);
            legs.push((label, "spot", "sell", base.clone(), available, false));
        }

        let mut candidates = Vec::new();
        for (label, product, side, base, quantity, reduces_directional_exposure) in legs {
            let mark = parse_decimal(&client.mark_price(base.token_id)?.1, "mark_price").map_err(
                |verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail),
            )?;
            let Ok(projection) = project_post_trade(
                client,
                account,
                assets,
                &TradeIntent {
                    product,
                    side,
                    base: &base,
                    quote: &quote,
                    quantity,
                    mark,
                },
            ) else {
                continue;
            };
            let delta_rapv = projection.rapv - live_rapv;
            let exit_cost = quantity * mark * EMERGENCY_SLIPPAGE;
            candidates.push(Self {
                label,
                is_eth: base.symbol.to_ascii_uppercase().contains("ETH"),
                protected: is_protected(&base.symbol),
                breaks_structure: delta_rapv <= Decimal::ZERO,
                reduces_directional_exposure,
                leg: UnwindLeg {
                    product,
                    side,
                    base_symbol: base.symbol.clone(),
                    base,
                    quote: quote.clone(),
                    quantity,
                    mark,
                },
                delta_rapv,
                post_rapv: projection.rapv,
                exit_cost,
            });
        }
        Ok(candidates)
    }
}

/// One chosen step of the plan, in execution order.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct UnwindStep {
    pub(crate) label: String,
    pub(crate) leg: UnwindLeg,
    pub(crate) delta_rapv: String,
    pub(crate) post_rapv: String,
    pub(crate) exit_cost: String,
    /// Chosen past the protect-ETH preference because nothing cheaper was left.
    pub(crate) overrode_preference: bool,
}

/// The cheapest-safe plan: greedy by RAPV gained per unit of exit cost until
/// the floor is reached, vetoes filtered first, protect-ETH as a ranking
/// demotion rather than a cost change so reported costs stay truthful.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct UnwindPlan {
    pub(crate) steps: Vec<UnwindStep>,
    pub(crate) cost_of_protection: String,
    /// The floor is reached by the summed per-leg gains. `false` is the
    /// degraded case: everything closable still leaves the account short.
    pub(crate) reached_target: bool,
    /// Live RAPV plus the chosen legs' gains — an estimate, since gains are
    /// projected one leg at a time from the same starting state.
    pub(crate) resulting_rapv: String,
    pub(crate) target: String,
    pub(crate) kept: String,
}

impl UnwindPlan {
    pub(crate) fn cheapest_safe(
        candidates: &[UnwindCandidate],
        current_rapv: Decimal,
        target: Decimal,
        preference: GuardianPreference,
    ) -> Self {
        let mut pool: Vec<&UnwindCandidate> = candidates
            .iter()
            .filter(|c| !c.protected && !c.breaks_structure)
            .collect();
        let mut rapv = current_rapv;
        let mut steps = Vec::new();
        let mut total_cost = Decimal::ZERO;
        let mut kept_eth = preference == GuardianPreference::ProtectEth;
        let eth_penalty = Decimal::from(1_000_000);
        let epsilon = Decimal::new(1, 6);
        let tie_bonus = Decimal::new(1, 3);

        while rapv < target && !pool.is_empty() {
            let rank = |c: &UnwindCandidate| {
                let penalty = if preference == GuardianPreference::ProtectEth && c.is_eth {
                    eth_penalty
                } else {
                    Decimal::ZERO
                };
                let bonus = if c.reduces_directional_exposure {
                    tie_bonus
                } else {
                    Decimal::ZERO
                };
                (c.delta_rapv + bonus) / (c.exit_cost + penalty + epsilon)
            };
            let Some(best) = pool
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| rank(a).cmp(&rank(b)))
                .map(|(index, _)| index)
            else {
                break;
            };
            let chosen = pool.remove(best);
            let overrode = preference == GuardianPreference::ProtectEth && chosen.is_eth;
            if overrode {
                kept_eth = false;
            }
            rapv += chosen.delta_rapv;
            total_cost += chosen.exit_cost;
            steps.push(UnwindStep {
                label: chosen.label.clone(),
                leg: chosen.leg.clone(),
                delta_rapv: chosen.delta_rapv.normalize().to_string(),
                post_rapv: chosen.post_rapv.normalize().to_string(),
                exit_cost: chosen.exit_cost.normalize().to_string(),
                overrode_preference: overrode,
            });
        }

        let kept = match preference {
            GuardianPreference::ProtectEth if kept_eth => "your ETH stack".to_string(),
            GuardianPreference::ProtectEth => {
                "nothing of the position — protecting ETH was no longer enough to reach your floor"
                    .to_string()
            }
            GuardianPreference::CheapestSafe => "nothing of the position".to_string(),
        };
        Self {
            steps,
            cost_of_protection: total_cost.normalize().to_string(),
            reached_target: rapv >= target,
            resulting_rapv: rapv.normalize().to_string(),
            target: target.normalize().to_string(),
            kept,
        }
    }
}

/// A guardian hold on one account: from the moment an unwind was staged until
/// the user checks in, every order that would lower RAPV is refused.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Hold {
    pub(crate) held_since: u64,
    pub(crate) reason: String,
    #[serde(default)]
    pub(crate) released_at: Option<u64>,
}

impl Hold {
    pub(crate) fn is_active(&self) -> bool {
        self.released_at.is_none()
    }

    /// The verdict this hold imposes on an allowed intent, if any: only
    /// intents whose post-trade RAPV is below the live RAPV add risk.
    pub(crate) fn blocks(
        &self,
        live_rapv: Decimal,
        post_trade_rapv: Option<Decimal>,
    ) -> Option<Verdict> {
        let adds_risk = post_trade_rapv.is_some_and(|post| post < live_rapv);
        if !self.is_active() || !adds_risk {
            return None;
        }
        Some(Verdict {
            status: "deny",
            rule: "guardian_hold",
            detail: format!(
                "The guardian has held all risk-adding activity since {} ({}); the user has not checked in yet.",
                self.held_since, self.reason
            ),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct HoldLedger {
    holds: BTreeMap<u64, Hold>,
}

/// Where holds live: a file under the app's data dir, or memory for tests.
#[derive(Clone, Debug)]
pub(crate) enum GuardianStore {
    File(PathBuf),
    #[allow(dead_code)]
    Memory(Arc<Mutex<HoldLedger>>),
}

impl Default for GuardianStore {
    fn default() -> Self {
        let dir = if let Ok(dir) = std::env::var("WORLD_GUARDIAN_DIR") {
            PathBuf::from(dir)
        } else if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            PathBuf::from(xdg).join("aomi/world-markets/guardian")
        } else if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(".local/share/aomi/world-markets/guardian")
        } else {
            std::env::temp_dir().join("aomi-world-markets-guardian")
        };
        Self::File(dir)
    }
}

impl GuardianStore {
    #[allow(dead_code)]
    pub(crate) fn in_memory() -> Self {
        Self::Memory(Arc::new(Mutex::new(HoldLedger::default())))
    }

    /// The active hold on `account_id`, if any.
    pub(crate) fn status(&self, account_id: u64) -> Result<Option<Hold>, String> {
        Ok(self
            .load()?
            .holds
            .get(&account_id)
            .filter(|hold| hold.is_active())
            .cloned())
    }

    /// Place (or refresh) the hold on `account_id`.
    pub(crate) fn hold(&self, account_id: u64, reason: String) -> Result<Hold, String> {
        let mut ledger = self.load()?;
        let hold = Hold {
            held_since: now_unix(),
            reason,
            released_at: None,
        };
        ledger.holds.insert(account_id, hold.clone());
        self.save(&ledger)?;
        Ok(hold)
    }

    /// The user checked in: release the hold. `None` when there was none.
    pub(crate) fn release(&self, account_id: u64) -> Result<Option<Hold>, String> {
        let mut ledger = self.load()?;
        let Some(hold) = ledger
            .holds
            .get_mut(&account_id)
            .filter(|hold| hold.is_active())
        else {
            return Ok(None);
        };
        hold.released_at = Some(now_unix());
        let released = hold.clone();
        self.save(&ledger)?;
        Ok(Some(released))
    }

    fn load(&self) -> Result<HoldLedger, String> {
        match self {
            Self::Memory(inner) => Ok(inner.lock().expect("guardian ledger lock").clone()),
            Self::File(dir) => match fs::read_to_string(dir.join("holds.json")) {
                Ok(raw) => serde_json::from_str(&raw)
                    .map_err(|e| format!("[world-markets] failed to parse guardian ledger: {e}")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HoldLedger::default()),
                Err(e) => Err(format!(
                    "[world-markets] failed to read guardian ledger: {e}"
                )),
            },
        }
    }

    fn save(&self, ledger: &HoldLedger) -> Result<(), String> {
        match self {
            Self::Memory(inner) => {
                *inner.lock().expect("guardian ledger lock") = ledger.clone();
                Ok(())
            }
            Self::File(dir) => {
                fs::create_dir_all(dir).map_err(|e| {
                    format!(
                        "[world-markets] failed to create guardian dir {}: {e}",
                        dir.display()
                    )
                })?;
                let path = dir.join("holds.json");
                let tmp = path.with_extension("json.tmp");
                let raw = serde_json::to_vec_pretty(ledger).map_err(|e| {
                    format!("[world-markets] failed to serialize guardian ledger: {e}")
                })?;
                fs::write(&tmp, &raw)
                    .map_err(|e| format!("[world-markets] failed to write guardian ledger: {e}"))?;
                fs::rename(&tmp, &path)
                    .map_err(|e| format!("[world-markets] failed to publish guardian ledger: {e}"))
            }
        }
    }
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn asset(token_id: u32, symbol: &str) -> Asset {
        Asset {
            token_id,
            symbol: symbol.to_string(),
            name: symbol.to_string(),
            token_type: "erc20".to_string(),
            erc20_address: "0x2222222222222222222222222222222222222222".to_string(),
            erc20_decimals: 18,
            vault_decimals: 8,
            position_decimals: 4,
            risk_price_percent: 10,
            risk_slippage_percent: 1.0,
        }
    }

    fn candidate(
        label: &str,
        symbol: &str,
        delta: &str,
        cost: &str,
        perp: bool,
    ) -> UnwindCandidate {
        let delta_rapv = Decimal::from_str(delta).unwrap();
        UnwindCandidate {
            label: label.to_string(),
            leg: UnwindLeg {
                product: if perp { "perp" } else { "spot" },
                side: "sell",
                base: asset(4, symbol),
                quote: asset(1, "USDT"),
                base_symbol: symbol.to_string(),
                quantity: Decimal::ONE,
                mark: Decimal::from(100),
            },
            delta_rapv,
            post_rapv: Decimal::from(5000) + delta_rapv,
            exit_cost: Decimal::from_str(cost).unwrap(),
            breaks_structure: delta_rapv <= Decimal::ZERO,
            reduces_directional_exposure: perp,
            protected: false,
            is_eth: symbol.contains("ETH"),
        }
    }

    #[test]
    fn cheapest_safe_ranks_by_gain_per_cost_and_stops_at_the_floor() {
        let candidates = vec![
            candidate("close WBTC short", "WBTC", "400", "40", true), // 10 per unit
            candidate("sell WETH spot", "WETH", "900", "30", false),  // 30 per unit
            candidate("close SOL long", "SOL", "300", "5", true),     // 60 per unit
        ];
        let plan = UnwindPlan::cheapest_safe(
            &candidates,
            Decimal::from(5000),
            Decimal::from(6000),
            GuardianPreference::CheapestSafe,
        );
        let order: Vec<&str> = plan.steps.iter().map(|s| s.label.as_str()).collect();
        assert_eq!(order, ["close SOL long", "sell WETH spot"]);
        assert!(plan.reached_target);
        assert_eq!(plan.resulting_rapv, "6200");
        assert_eq!(plan.cost_of_protection, "35");
        assert_eq!(plan.kept, "nothing of the position");
    }

    #[test]
    fn vetoes_are_filtered_and_a_short_plan_reports_not_reached() {
        let mut protected = candidate("sell WETH spot", "WETH", "900", "30", false);
        protected.protected = true;
        let hedge = candidate("close WBTC short", "WBTC", "-50", "10", true);
        let small = candidate("close SOL long", "SOL", "300", "5", true);
        let plan = UnwindPlan::cheapest_safe(
            &[protected, hedge, small],
            Decimal::from(5000),
            Decimal::from(6000),
            GuardianPreference::CheapestSafe,
        );
        assert_eq!(plan.steps.len(), 1);
        assert_eq!(plan.steps[0].label, "close SOL long");
        assert!(!plan.reached_target);
        assert_eq!(plan.resulting_rapv, "5300");
    }

    #[test]
    fn protect_eth_demotes_eth_and_reports_an_override_honestly() {
        let eth = candidate("sell WETH spot", "WETH", "900", "1", false);
        let sol = candidate("close SOL long", "SOL", "300", "50", true);
        let kept = UnwindPlan::cheapest_safe(
            &[eth.clone(), sol.clone()],
            Decimal::from(5000),
            Decimal::from(5200),
            GuardianPreference::ProtectEth,
        );
        assert_eq!(kept.steps[0].label, "close SOL long");
        assert_eq!(kept.steps.len(), 1);
        assert_eq!(kept.kept, "your ETH stack");

        let forced = UnwindPlan::cheapest_safe(
            &[eth, sol],
            Decimal::from(5000),
            Decimal::from(6000),
            GuardianPreference::ProtectEth,
        );
        assert_eq!(forced.steps.len(), 2);
        assert!(forced.steps[1].overrode_preference);
        assert!(forced.kept.starts_with("nothing of the position"));
    }

    #[test]
    fn a_hold_blocks_only_risk_adding_intents_until_released() {
        let store = GuardianStore::in_memory();
        assert_eq!(store.status(7).unwrap(), None);
        let hold = store.hold(7, "floor breached".to_string()).unwrap();
        assert!(hold.is_active());
        let live = Decimal::from(5000);
        assert!(hold.blocks(live, Some(Decimal::from(4900))).is_some());
        assert!(hold.blocks(live, Some(Decimal::from(5100))).is_none());
        assert!(hold.blocks(live, None).is_none());
        assert_eq!(
            hold.blocks(live, Some(Decimal::from(4900))).unwrap().rule,
            "guardian_hold"
        );
        assert_eq!(store.status(7).unwrap(), Some(hold.clone()));
        let released = store.release(7).unwrap().unwrap();
        assert!(!released.is_active());
        assert_eq!(store.status(7).unwrap(), None);
        assert_eq!(store.release(7).unwrap(), None);
        assert_eq!(
            GuardianPreference::parse(Some("protect_eth")).unwrap(),
            GuardianPreference::ProtectEth
        );
        assert!(GuardianPreference::parse(Some("yolo")).is_err());
    }
}
