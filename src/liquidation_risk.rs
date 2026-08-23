//! Portfolio metrics aligned with the Composite frontend (`@composite/sdk`).
//!
//! `liquidation_risk` is a 0–10 score from `Portfolio.calculateLiquidationRisk`:
//! binary search on the risk multiplier, then a non-linear map to the display scale.
//! The Telegram agent must cite only values returned here — never infer them.

use std::collections::BTreeMap;
use std::str::FromStr;

use rust_decimal::Decimal;
use rust_decimal::RoundingStrategy;
use rust_decimal::prelude::FromPrimitive;
use serde::Serialize;

use crate::client::{
    Account, Asset, BASE_TOKEN_ID, Balance, PerpetualPosition, WorldClient, decimal_digits,
};
use crate::mandate::parse_decimal;
const LEND_DURATION_DAYS: u32 = 10;
const LENDER_HAIRCUT: i64 = 980;
const PERMILLE_SCALE: i64 = 1000;
const FUNDING_INTERVAL_SEC: u64 = 8 * 60 * 60;
const FUNDING_RATE_DIVISOR: i64 = 10_000_000;
const MAX_SCORE: f64 = 10.0;
const SEARCH_PRECISION: f64 = 0.05;
const MAX_SEARCH_ITERATIONS: u32 = 10;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct PortfolioMetrics {
    /// Net asset value (portfolio evaluation at risk multiplier 0).
    pub(crate) net_asset_value: String,
    /// 0–10 liquidation risk score (one decimal), matching the Composite UI.
    pub(crate) liquidation_risk: String,
    pub(crate) liquidation_risk_scale: &'static str,
    /// `safe` (<6), `elevated` (6–8), `high` (8–10), `liquidation` (10).
    pub(crate) liquidation_risk_band: String,
    pub(crate) baseline: String,
}

pub(crate) fn compute_metrics(
    client: &WorldClient,
    account: &Account,
    assets: &[Asset],
    block_number: u64,
) -> Result<PortfolioMetrics, String> {
    let time_sec = client.block_timestamp()?;
    let base = assets
        .iter()
        .find(|asset| asset.token_id == BASE_TOKEN_ID)
        .ok_or_else(|| "[world-markets] base token config is missing".to_string())?;
    let state = build_state(client, account, assets)?;
    let nav = evaluate(&state, assets, client, base, time_sec, 0.0)?;
    let prv = parse_decimal(
        &account.risk_adjusted_portfolio_value,
        "risk_adjusted_portfolio_value",
    )
    .map_err(|verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))?;
    let val_at_max = evaluate(&state, assets, client, base, time_sec, MAX_SCORE)?;
    let risk = calculate_liquidation_risk(nav, prv, val_at_max, |multiplier| {
        evaluate(&state, assets, client, base, time_sec, multiplier)
    })?;
    Ok(PortfolioMetrics {
        net_asset_value: format_decimal(nav, base.position_decimals),
        liquidation_risk: format_risk_score(risk),
        liquidation_risk_scale: "0-10",
        liquidation_risk_band: risk_band(risk).to_string(),
        baseline: format!(
            "composite portfolio evaluation at block {block_number} (risk multiplier search vs live RAPV)"
        ),
    })
}

fn risk_band(score: f64) -> &'static str {
    if score >= MAX_SCORE {
        "liquidation"
    } else if score >= 8.0 {
        "high"
    } else if score >= 6.0 {
        "elevated"
    } else {
        "safe"
    }
}

fn format_risk_score(score: f64) -> String {
    format!("{:.1}", score.clamp(0.0, MAX_SCORE))
}

struct TokenState {
    balance_vault: u128,
    lend_borrower_raw: u64,
    lend_lender_raw: u64,
    lend_rate_raw: u16,
    perp: Option<PerpetualPosition>,
    mark_price: Decimal,
}

struct PortfolioState {
    tokens: BTreeMap<u32, TokenState>,
}

fn build_state(
    client: &WorldClient,
    account: &Account,
    assets: &[Asset],
) -> Result<PortfolioState, String> {
    let balances: BTreeMap<u32, &Balance> =
        account.balances.iter().map(|b| (b.token_id, b)).collect();
    let lending = account
        .lending_positions
        .iter()
        .map(|l| (l.token_id, l))
        .collect::<BTreeMap<_, _>>();
    let perps = account
        .perpetual_positions
        .iter()
        .map(|p| (p.token_id, p))
        .collect::<BTreeMap<_, _>>();

    let mut tokens = BTreeMap::new();
    for asset in assets {
        let has_activity = balances.contains_key(&asset.token_id)
            || lending.contains_key(&asset.token_id)
            || perps.contains_key(&asset.token_id);
        if !has_activity {
            continue;
        }
        let balance_vault = balances
            .get(&asset.token_id)
            .and_then(|b| b.balance_raw.parse().ok())
            .unwrap_or(0);
        let lend = lending.get(&asset.token_id);
        let perp = perps.get(&asset.token_id).cloned().cloned();
        let (_raw, mark) = client.mark_price(asset.token_id)?;
        let mark_price = parse_decimal(&mark, "mark_price")
            .map_err(|verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))?;
        tokens.insert(
            asset.token_id,
            TokenState {
                balance_vault,
                lend_borrower_raw: lend.map(|l| l.borrower_quantity_raw).unwrap_or(0),
                lend_lender_raw: lend.map(|l| l.lender_quantity_raw).unwrap_or(0),
                lend_rate_raw: lend.map(|l| l.highest_interest_rate_raw).unwrap_or(0),
                perp,
                mark_price,
            },
        );
    }
    Ok(PortfolioState { tokens })
}

fn evaluate(
    state: &PortfolioState,
    assets: &[Asset],
    client: &WorldClient,
    base: &Asset,
    time_sec: u64,
    risk_multiplier: f64,
) -> Result<Decimal, String> {
    let asset_map: BTreeMap<u32, &Asset> = assets.iter().map(|a| (a.token_id, a)).collect();
    let mut total = Decimal::ZERO;
    for (token_id, token) in &state.tokens {
        let asset = asset_map
            .get(token_id)
            .ok_or_else(|| format!("[world-markets] missing asset config for token {token_id}"))?;
        let effective = compute_effective_balance(token, asset, risk_multiplier)?;
        if *token_id == BASE_TOKEN_ID {
            total = add_dec(total, effective)?;
            continue;
        }
        let base_quantity =
            convert_token_to_base(token.mark_price, effective, base.position_decimals)?;
        let (mut high, mut low) =
            calc_spot_risk_bounds(effective, base_quantity, asset, base, risk_multiplier)?;
        if let Some(perp) = &token.perp {
            let history_rate = funding_history_rate(client, perp, asset, time_sec)?;
            let (high_perp, low_perp) = calc_perp_risk_bounds(
                perp,
                asset,
                base,
                token.mark_price,
                history_rate,
                risk_multiplier,
            )?;
            high = add_dec(high, high_perp)?;
            low = add_dec(low, low_perp)?;
        }
        total = add_dec(total, high.min(low))?;
    }
    Ok(total)
}

fn calculate_liquidation_risk<F>(
    nav: Decimal,
    prv: Decimal,
    val_at_max: Decimal,
    mut evaluate_at: F,
) -> Result<f64, String>
where
    F: FnMut(f64) -> Result<Decimal, String>,
{
    if nav.is_zero() || nav == prv {
        return Ok(0.0);
    }
    if prv.is_sign_negative() {
        return Ok(MAX_SCORE);
    }
    if val_at_max > Decimal::ZERO {
        return Ok(0.0);
    }

    let mut max = MAX_SCORE;
    let mut min = 0.0;
    for _ in 0..MAX_SEARCH_ITERATIONS {
        if max - min <= SEARCH_PRECISION {
            break;
        }
        let mid = (max + min) / 2.0;
        let value = evaluate_at(mid)?;
        if value > Decimal::ZERO {
            min = mid;
        } else {
            max = mid;
        }
    }

    let health_score = (max + min) / 2.0;
    let hz = (health_score - 1.0) / 9.0;
    let mapped = ((hz.sqrt() + hz) * 9.0) / 2.0 + 1.0;
    Ok(MAX_SCORE - mapped)
}

fn funding_history_rate(
    client: &WorldClient,
    perp: &PerpetualPosition,
    asset: &Asset,
    time_sec: u64,
) -> Result<Decimal, String> {
    if !has_perp_elapsed_funding_interval(time_sec, perp.funding_start_time) {
        return Ok(Decimal::ZERO);
    }
    let rates = client.funding_rate_history(perp.funding_start_time, time_sec, asset.token_id)?;
    Ok(rates
        .iter()
        .map(|rate| Decimal::from(*rate) / Decimal::from(FUNDING_RATE_DIVISOR))
        .sum())
}

fn has_perp_elapsed_funding_interval(current_sec: u64, position_start_sec: u64) -> bool {
    current_sec / FUNDING_INTERVAL_SEC > position_start_sec / FUNDING_INTERVAL_SEC
}

fn compute_effective_balance(
    token: &TokenState,
    asset: &Asset,
    risk_multiplier: f64,
) -> Result<Decimal, String> {
    let balance_position = vault_to_position(
        token.balance_vault,
        asset.vault_decimals,
        asset.position_decimals,
    )?;
    let rate = Decimal::from(token.lend_rate_raw) / Decimal::from(10_000);
    let borrower = calc_borrower_obligation(
        Decimal::from(token.lend_borrower_raw) / position_scale(asset.position_decimals),
        rate,
        LEND_DURATION_DAYS,
        asset.position_decimals,
    )?;
    let lender = apply_lender_haircut(
        Decimal::from(token.lend_lender_raw) / position_scale(asset.position_decimals),
        risk_multiplier,
        LENDER_HAIRCUT,
    )?;
    Ok(balance_position - borrower + lender)
}

fn calc_spot_risk_bounds(
    effective_balance: Decimal,
    base_quantity: Decimal,
    token: &Asset,
    base: &Asset,
    risk_multiplier: f64,
) -> Result<(Decimal, Decimal), String> {
    let price_permille =
        (scale_risk_capped(f64::from(token.risk_price_percent), risk_multiplier) * 10.0) as i64;
    let slippage_permille =
        (scale_risk_capped(token.risk_slippage_percent, risk_multiplier) * 10.0) as i64;
    let (high_delta, low_delta) = if effective_balance > Decimal::ZERO {
        (
            clamp_permille(price_permille - slippage_permille),
            clamp_permille(-price_permille - slippage_permille),
        )
    } else {
        (
            clamp_permille(price_permille + slippage_permille),
            clamp_permille(-price_permille + slippage_permille),
        )
    };
    Ok((
        apply_risk_adjustment(base_quantity, high_delta, base.position_decimals)?,
        apply_risk_adjustment(base_quantity, low_delta, base.position_decimals)?,
    ))
}

fn calc_perp_risk_bounds(
    perp: &PerpetualPosition,
    token: &Asset,
    base: &Asset,
    mark_price: Decimal,
    history_rate: Decimal,
    risk_multiplier: f64,
) -> Result<(Decimal, Decimal), String> {
    let quantity = parse_decimal(&perp.quantity, "perp_quantity")
        .map_err(|verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))?;
    if quantity.is_zero() {
        return Ok((Decimal::ZERO, Decimal::ZERO));
    }
    let entry = parse_decimal(&perp.entry_price, "perp_entry_price")
        .map_err(|verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))?;
    let owed_nom = parse_decimal(&perp.owed_nom, "perp_owed_nom")
        .map_err(|verdict| format!("[world-markets] {}: {}", verdict.rule, verdict.detail))?;
    let owed_base = owed_base_decimal(
        &perp.owed_base_raw,
        token.position_decimals,
        base.position_decimals,
    )?;

    let agg_val = convert_token_to_base(entry, quantity, base.position_decimals)? - owed_base;
    let new_val = convert_token_to_base(mark_price, quantity, base.position_decimals)?;
    let price_risk = scale_risk_capped(f64::from(token.risk_price_percent), risk_multiplier);
    let high_val_perp =
        new_val * (Decimal::from(100) + decimal_from_f64(price_risk)?) / Decimal::from(100);
    let low_val_perp =
        new_val * (Decimal::from(100) - decimal_from_f64(price_risk)?) / Decimal::from(100);
    let mut high = high_val_perp - agg_val;
    let mut low = low_val_perp - agg_val;

    let f_pay_nom = owed_nom - quantity * history_rate;
    let f_pay_base = convert_token_to_base(mark_price, f_pay_nom, base.position_decimals)?;
    high += f_pay_base * (Decimal::from(100) + decimal_from_f64(price_risk)?) / Decimal::from(100);
    low += f_pay_base * (Decimal::from(100) - decimal_from_f64(price_risk)?) / Decimal::from(100);
    Ok((high, low))
}

fn owed_base_decimal(raw: &str, from_decimals: u8, to_decimals: u8) -> Result<Decimal, String> {
    if raw == "0" || raw == "-0" {
        return Ok(Decimal::ZERO);
    }
    let negative = raw.starts_with('-');
    let digits = raw.trim_start_matches('-');
    let scale = u8::try_from(u32::from(from_decimals) + 31)
        .map_err(|_| "[world-markets] owed_base scale exceeds u8".to_string())?;
    let scaled = if negative {
        format!("-{}", decimal_digits(digits.to_string(), scale))
    } else {
        decimal_digits(digits.to_string(), scale)
    };
    let value = Decimal::from_str(&scaled)
        .map_err(|e| format!("[world-markets] invalid owed_base scaled: {e}"))?;
    Ok(truncate_dp(value, u32::from(to_decimals)))
}

fn scale_risk_capped(risk_percent: f64, risk_multiplier: f64) -> f64 {
    (risk_percent * risk_multiplier).min(100.0)
}

fn clamp_permille(value: i64) -> i64 {
    value.clamp(-PERMILLE_SCALE, PERMILLE_SCALE)
}

fn calc_borrower_obligation(
    principal: Decimal,
    highest_rate: Decimal,
    lend_duration_days: u32,
    token_position_decimals: u8,
) -> Result<Decimal, String> {
    let interest =
        principal * highest_rate * Decimal::from(lend_duration_days) / Decimal::from(365);
    Ok(truncate_dp(interest, u32::from(token_position_decimals)) + principal)
}

fn apply_lender_haircut(
    lender_quantity: Decimal,
    risk_multiplier: f64,
    lender_haircut: i64,
) -> Result<Decimal, String> {
    let retained = ((PERMILLE_SCALE as f64
        - (PERMILLE_SCALE - lender_haircut) as f64 * risk_multiplier)
        / PERMILLE_SCALE as f64)
        .max(0.05);
    Ok(lender_quantity * decimal_from_f64(retained)?)
}

fn apply_risk_adjustment(
    base_quantity: Decimal,
    risk_delta_permille: i64,
    base_position_decimals: u8,
) -> Result<Decimal, String> {
    let adjusted = base_quantity
        * (Decimal::from(PERMILLE_SCALE) + Decimal::from(risk_delta_permille))
        / Decimal::from(PERMILLE_SCALE);
    Ok(truncate_dp(adjusted, u32::from(base_position_decimals)))
}

fn convert_token_to_base(
    token_price: Decimal,
    token_quantity: Decimal,
    base_position_decimals: u8,
) -> Result<Decimal, String> {
    Ok(truncate_dp(
        token_price * token_quantity,
        u32::from(base_position_decimals),
    ))
}

fn vault_to_position(
    vault_raw: u128,
    vault_decimals: u8,
    position_decimals: u8,
) -> Result<Decimal, String> {
    let value = Decimal::from(vault_raw) / Decimal::from(10u64.pow(u32::from(vault_decimals)));
    Ok(truncate_dp(value, u32::from(position_decimals)))
}

fn position_scale(decimals: u8) -> Decimal {
    Decimal::from(10u64.pow(u32::from(decimals)))
}

fn truncate_dp(value: Decimal, dp: u32) -> Decimal {
    value.round_dp_with_strategy(dp, RoundingStrategy::ToZero)
}

fn add_dec(a: Decimal, b: Decimal) -> Result<Decimal, String> {
    a.checked_add(b)
        .ok_or_else(|| "[world-markets] decimal overflow".to_string())
}

fn decimal_from_f64(value: f64) -> Result<Decimal, String> {
    Decimal::from_f64(value).ok_or_else(|| format!("[world-markets] invalid decimal: {value}"))
}

fn format_decimal(value: Decimal, decimals: u8) -> String {
    truncate_dp(value, u32::from(decimals))
        .normalize()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_risk_capped_matches_sdk() {
        assert_eq!(scale_risk_capped(10.0, 2.0), 20.0);
        assert_eq!(scale_risk_capped(50.0, 3.0), 100.0);
        assert_eq!(scale_risk_capped(0.0, 100.0), 0.0);
    }

    #[test]
    fn liquidation_risk_zero_when_nav_equals_prv() {
        let nav = Decimal::from(1000);
        let prv = Decimal::from(1000);
        let val_at_max = Decimal::from(-1);
        let risk = calculate_liquidation_risk(nav, prv, val_at_max, |_| Ok(Decimal::ZERO)).unwrap();
        assert_eq!(risk, 0.0);
    }

    #[test]
    fn liquidation_risk_max_when_prv_negative() {
        let nav = Decimal::from(1000);
        let prv = Decimal::from(-1);
        let val_at_max = Decimal::from(-1);
        let risk = calculate_liquidation_risk(nav, prv, val_at_max, |_| Ok(Decimal::ZERO)).unwrap();
        assert_eq!(risk, MAX_SCORE);
    }

    #[test]
    fn liquidation_risk_zero_when_still_positive_at_max_multiplier() {
        let nav = Decimal::from(1000);
        let prv = Decimal::from(500);
        let val_at_max = Decimal::from(1);
        let risk = calculate_liquidation_risk(nav, prv, val_at_max, |_| Ok(Decimal::ONE)).unwrap();
        assert_eq!(risk, 0.0);
    }

    #[test]
    fn risk_bands_match_composite_ui() {
        assert_eq!(risk_band(0.0), "safe");
        assert_eq!(risk_band(5.9), "safe");
        assert_eq!(risk_band(6.0), "elevated");
        assert_eq!(risk_band(7.9), "elevated");
        assert_eq!(risk_band(8.0), "high");
        assert_eq!(risk_band(9.9), "high");
        assert_eq!(risk_band(10.0), "liquidation");
    }

    #[test]
    fn owed_base_decimal_scales_without_integer_overflow() {
        let scaled = owed_base_decimal("1000000000000000000", 7, 4).unwrap();
        assert!(scaled >= Decimal::ZERO);
    }

    #[test]
    fn borrower_obligation_truncates_interest() {
        let principal = Decimal::from(1000);
        let rate = Decimal::new(10, 2);
        let obligation = calc_borrower_obligation(principal, rate, 30, 6).unwrap();
        assert!(obligation > principal);
    }
}
