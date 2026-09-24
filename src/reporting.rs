//! Derived figures for the honest-numbers layer. Every number a message
//! interpolates comes from a live contract read or from here, computed in Rust
//! with `rust_decimal`; the model writes only the sentences between them.

use rust_decimal::Decimal;
use serde::Serialize;

use crate::client::Account;
use crate::mandate::parse_decimal;

/// One figure with the metadata copy needs to render it honestly: whether it
/// is an estimate rather than an exact contract value.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct Figure {
    pub(crate) value: String,
    pub(crate) unit: String,
    pub(crate) is_estimate: bool,
}

impl Figure {
    pub(crate) fn decimal(value: Decimal, unit: impl Into<String>, is_estimate: bool) -> Self {
        Self {
            value: value.normalize().to_string(),
            unit: unit.into(),
            is_estimate,
        }
    }
}

/// A before → after transition of one figure. Both ends come from Rust, so the
/// arrow never spans a model-invented number.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct Transition {
    pub(crate) before: String,
    pub(crate) after: String,
    pub(crate) unit: String,
    /// Nothing changed; the message layer suppresses this line.
    pub(crate) unchanged: bool,
    /// `liquidation_risk` (0–10, higher = worse): `safer` / `less safe`.
    /// Other fields: `rises` / `falls` / `unchanged`.
    pub(crate) direction: String,
}

impl Transition {
    pub(crate) fn new(
        before: Decimal,
        after: Decimal,
        unit: impl Into<String>,
        field: &str,
    ) -> Self {
        let direction = if before == after {
            "unchanged"
        } else if field == "liquidation_risk" {
            if after > before { "less safe" } else { "safer" }
        } else if after > before {
            "rises"
        } else {
            "falls"
        };
        Self {
            before: before.normalize().to_string(),
            after: after.normalize().to_string(),
            unit: unit.into(),
            unchanged: before == after,
            direction: direction.to_string(),
        }
    }
}

/// The account-change bundle behind a simulation preview. User-facing risk is
/// the 0–10 liquidation score, never RAPV.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct AccountEffect {
    pub(crate) directional_exposure: Transition,
    pub(crate) exposure_symbol: String,
    pub(crate) available_to_deploy: Transition,
    /// 0–10 liquidation score. `None` when post-trade risk cannot be proven.
    pub(crate) liquidation_risk: Option<Transition>,
    pub(crate) estimated_cost: Option<Figure>,
    /// Concern-line direction for the score, verbatim. Absent when risk is omitted.
    pub(crate) direction: Option<String>,
    /// One portfolio-level clause, derived from the position change.
    pub(crate) concern_clause: String,
    /// Pasteable concern line with the 0–10 delta, empty when unprovable.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) concern_line: String,
    pub(crate) missing_mark_symbols: Vec<String>,
    pub(crate) post_trade_risk_unavailable: bool,
    pub(crate) baseline: String,
}

/// Snapshot plus intent evaluation the reporting layer formats. Every figure
/// is computed from live state; the model never supplies a before or after.
#[derive(Debug, Clone)]
pub(crate) struct EffectPlan {
    pub(crate) exposure_symbol: String,
    pub(crate) exposure_before: Decimal,
    pub(crate) exposure_after: Decimal,
    pub(crate) available_before: Decimal,
    pub(crate) available_after: Decimal,
    pub(crate) quote: String,
    pub(crate) liquidation_risk_before: Option<Decimal>,
    pub(crate) liquidation_risk_after: Option<Decimal>,
    pub(crate) estimated_cost: Option<Decimal>,
    pub(crate) missing_mark_symbols: Vec<String>,
    pub(crate) post_trade_risk_unavailable: bool,
    pub(crate) concern_clause: String,
    pub(crate) baseline: String,
}

impl EffectPlan {
    /// The one portfolio-level clause: flat, reducing, or adding directional
    /// exposure in `base`, given the other open perp legs.
    pub(crate) fn concern_clause(
        account: &Account,
        base: &str,
        current: Decimal,
        after: Decimal,
    ) -> String {
        let others = account
            .perpetual_positions
            .iter()
            .filter(|position| !position.symbol.eq_ignore_ascii_case(base))
            .filter(|position| {
                parse_decimal(&position.quantity, "quantity").is_ok_and(|qty| !qty.is_zero())
            })
            .map(|position| format!("{} {}", position.symbol, position.side))
            .collect::<Vec<_>>();
        let side = if current.is_sign_negative() {
            "short"
        } else {
            "long"
        };
        if after.is_zero() && !current.is_zero() {
            if others.is_empty() {
                format!("the open {base} {side} was your main directional exposure")
            } else {
                format!(
                    "you'd be flat {base} while still carrying {}",
                    others.join(", ")
                )
            }
        } else if after.abs() < current.abs() {
            format!("this reduces your {base} directional exposure")
        } else {
            format!("this adds {base} directional exposure")
        }
    }

    pub(crate) fn derive(&self) -> AccountEffect {
        let liquidation_risk = match (self.liquidation_risk_before, self.liquidation_risk_after) {
            (Some(before), Some(after)) => {
                Some(Transition::new(before, after, "", "liquidation_risk"))
            }
            _ => None,
        };
        let concern_line = match &liquidation_risk {
            Some(risk) if !risk.unchanged => {
                let line = format!("Risk `{}` → `{}`", risk.before, risk.after);
                if self.concern_clause.trim().is_empty() {
                    line
                } else {
                    format!("{line} — {}", self.concern_clause)
                }
            }
            _ => String::new(),
        };
        AccountEffect {
            directional_exposure: Transition::new(
                self.exposure_before,
                self.exposure_after,
                self.quote.clone(),
                "exposure",
            ),
            exposure_symbol: self.exposure_symbol.clone(),
            available_to_deploy: Transition::new(
                self.available_before,
                self.available_after,
                self.quote.clone(),
                "available",
            ),
            direction: liquidation_risk.as_ref().map(|t| t.direction.clone()),
            concern_clause: if liquidation_risk.is_some() {
                self.concern_clause.clone()
            } else {
                String::new()
            },
            concern_line,
            post_trade_risk_unavailable: self.post_trade_risk_unavailable
                || self.liquidation_risk_after.is_none(),
            liquidation_risk,
            estimated_cost: self
                .estimated_cost
                .map(|cost| Figure::decimal(cost, self.quote.clone(), true)),
            missing_mark_symbols: self.missing_mark_symbols.clone(),
            baseline: self.baseline.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn plan(before: Option<&str>, after: Option<&str>) -> EffectPlan {
        EffectPlan {
            exposure_symbol: "WETH".to_string(),
            exposure_before: Decimal::from(100),
            exposure_after: Decimal::from(50),
            available_before: Decimal::from(900),
            available_after: Decimal::from(950),
            quote: "USDT".to_string(),
            liquidation_risk_before: before.map(|v| Decimal::from_str(v).unwrap()),
            liquidation_risk_after: after.map(|v| Decimal::from_str(v).unwrap()),
            estimated_cost: None,
            missing_mark_symbols: vec![],
            post_trade_risk_unavailable: false,
            concern_clause: "this reduces your WETH directional exposure".to_string(),
            baseline: "test".to_string(),
        }
    }

    #[test]
    fn risk_direction_inverts_and_concern_line_carries_the_delta() {
        let effect = plan(Some("4.2"), Some("3.1")).derive();
        let risk = effect.liquidation_risk.unwrap();
        assert_eq!(risk.direction, "safer");
        assert_eq!(
            effect.concern_line,
            "Risk `4.2` → `3.1` — this reduces your WETH directional exposure"
        );
        assert_eq!(effect.directional_exposure.direction, "falls");
        assert_eq!(effect.available_to_deploy.direction, "rises");
        assert!(!effect.post_trade_risk_unavailable);
    }

    #[test]
    fn unprovable_risk_omits_the_line_and_flags_it() {
        let effect = plan(Some("4.2"), None).derive();
        assert!(effect.liquidation_risk.is_none());
        assert!(effect.concern_line.is_empty());
        assert!(effect.concern_clause.is_empty());
        assert!(effect.post_trade_risk_unavailable);
        let unchanged = plan(Some("4.2"), Some("4.2")).derive();
        assert!(unchanged.liquidation_risk.unwrap().unchanged);
        assert!(unchanged.concern_line.is_empty());
    }

    #[test]
    fn concern_clause_names_flat_reduce_and_add() {
        let account = Account {
            account_id: 1,
            owner: String::new(),
            risk_adjusted_portfolio_value_raw: 0,
            risk_adjusted_portfolio_value: "0".to_string(),
            eligible_for_liquidation: false,
            balances: vec![],
            lending_positions: vec![],
            perpetual_positions: vec![],
            debt_token_ids: vec![],
            non_debt_token_ids: vec![],
        };
        let one = Decimal::ONE;
        assert_eq!(
            EffectPlan::concern_clause(&account, "WETH", one, Decimal::ZERO),
            "the open WETH long was your main directional exposure"
        );
        assert_eq!(
            EffectPlan::concern_clause(&account, "WETH", -one, -one / Decimal::TWO),
            "this reduces your WETH directional exposure"
        );
        assert_eq!(
            EffectPlan::concern_clause(&account, "WETH", one, one * Decimal::TWO),
            "this adds WETH directional exposure"
        );
    }
}
