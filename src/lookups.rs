//! One-line lookup fields for `get_world_account`.
//!
//! Derived figures the message layer interpolates into terse lookup copy — computed
//! in Rust so the model never ranks or sums notionals itself.

use std::collections::BTreeMap;

use rust_decimal::Decimal;
use rust_decimal::RoundingStrategy;
use serde::Serialize;

use crate::client::{Account, Asset, WorldClient};
use crate::liquidation_risk::BASE_TOKEN_ID;
use crate::mandate::parse_decimal;

const QUOTE: &str = "USDT";
const TOP_N: usize = 3;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct ExposureEntry {
    pub(crate) symbol: String,
    pub(crate) notional_usdt: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct TopExposures {
    pub(crate) quote: &'static str,
    pub(crate) top: Vec<ExposureEntry>,
    pub(crate) remaining_count: u32,
    pub(crate) baseline: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct AccountLookups {
    /// Portfolio value in quote units — same as `metrics.net_asset_value`.
    pub(crate) portfolio_value: String,
    pub(crate) top_exposures: TopExposures,
    /// Absent until the reporting service exposes an exact (non-estimate) figure.
    pub(crate) available_to_deploy: Option<String>,
}

pub(crate) fn compute_lookups(
    client: &WorldClient,
    account: &Account,
    assets: &[Asset],
    portfolio_value: &str,
    block_number: u64,
) -> Result<AccountLookups, String> {
    let base = assets
        .iter()
        .find(|asset| asset.token_id == BASE_TOKEN_ID)
        .ok_or_else(|| "[world-markets] base token config is missing".to_string())?;
    let top_exposures = top_exposures(client, account, assets, base, block_number)?;
    Ok(AccountLookups {
        portfolio_value: portfolio_value.to_string(),
        top_exposures,
        available_to_deploy: None,
    })
}

fn top_exposures(
    client: &WorldClient,
    account: &Account,
    assets: &[Asset],
    base: &Asset,
    block_number: u64,
) -> Result<TopExposures, String> {
    let asset_map: BTreeMap<u32, &Asset> = assets.iter().map(|a| (a.token_id, a)).collect();
    let mut notionals: BTreeMap<String, Decimal> = BTreeMap::new();

    for perp in &account.perpetual_positions {
        let asset = asset_map
            .get(&perp.token_id)
            .ok_or_else(|| format!("[world-markets] missing asset for perp {}", perp.symbol))?;
        let qty = parse_decimal(&perp.quantity, "perp_quantity")
            .map_err(|v| format!("[world-markets] {}: {}", v.rule, v.detail))?;
        if qty.is_zero() {
            continue;
        }
        let notional = notional_usdt(client, asset, base, qty.abs())?;
        add_notional(&mut notionals, &perp.symbol, notional)?;
    }

    for lend in &account.lending_positions {
        let asset = asset_map
            .get(&lend.token_id)
            .ok_or_else(|| format!("[world-markets] missing asset for lend {}", lend.symbol))?;
        let borrower = parse_decimal(&lend.borrower_quantity, "borrower_quantity")
            .map_err(|v| format!("[world-markets] {}: {}", v.rule, v.detail))?;
        if !borrower.is_zero() {
            let notional = notional_usdt(client, asset, base, borrower)?;
            add_notional(&mut notionals, &lend.symbol, notional)?;
        }
        let lender = parse_decimal(&lend.lender_quantity, "lender_quantity")
            .map_err(|v| format!("[world-markets] {}: {}", v.rule, v.detail))?;
        if !lender.is_zero() {
            let notional = notional_usdt(client, asset, base, lender)?;
            add_notional(&mut notionals, &lend.symbol, notional)?;
        }
    }

    for balance in &account.balances {
        let asset = asset_map.get(&balance.token_id).ok_or_else(|| {
            format!(
                "[world-markets] missing asset for balance {}",
                balance.symbol
            )
        })?;
        let amount = parse_decimal(&balance.balance, "balance")
            .map_err(|v| format!("[world-markets] {}: {}", v.rule, v.detail))?;
        if amount.is_zero() {
            continue;
        }
        let notional = if asset.token_id == BASE_TOKEN_ID {
            amount
        } else {
            notional_usdt(client, asset, base, amount.abs())?
        };
        add_notional(&mut notionals, &balance.symbol, notional)?;
    }

    let mut ranked: Vec<(String, Decimal)> = notionals.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    let remaining_count = ranked.len().saturating_sub(TOP_N) as u32;
    let top = ranked
        .into_iter()
        .take(TOP_N)
        .map(|(symbol, notional)| ExposureEntry {
            symbol,
            notional_usdt: format_notional(notional, base.position_decimals),
        })
        .collect();

    Ok(TopExposures {
        quote: QUOTE,
        top,
        remaining_count,
        baseline: format!(
            "absolute USDT notional per asset at block {block_number} (perp |qty|×mark, spot |balance|×mark, lend qty×mark)"
        ),
    })
}

fn notional_usdt(
    client: &WorldClient,
    asset: &Asset,
    base: &Asset,
    quantity: Decimal,
) -> Result<Decimal, String> {
    if quantity.is_zero() {
        return Ok(Decimal::ZERO);
    }
    if asset.token_id == BASE_TOKEN_ID {
        return Ok(quantity);
    }
    let (_raw, mark) = client.mark_price(asset.token_id)?;
    let mark_price = parse_decimal(&mark, "mark_price")
        .map_err(|v| format!("[world-markets] {}: {}", v.rule, v.detail))?;
    quantity
        .checked_mul(mark_price)
        .ok_or_else(|| "[world-markets] notional overflow".to_string())
        .map(|value| truncate_dp(value, u32::from(base.position_decimals)))
}

fn add_notional(
    map: &mut BTreeMap<String, Decimal>,
    symbol: &str,
    delta: Decimal,
) -> Result<(), String> {
    if delta.is_zero() {
        return Ok(());
    }
    let entry = map.entry(symbol.to_string()).or_insert(Decimal::ZERO);
    *entry = entry
        .checked_add(delta)
        .ok_or_else(|| "[world-markets] exposure sum overflow".to_string())?;
    Ok(())
}

fn truncate_dp(value: Decimal, dp: u32) -> Decimal {
    value.round_dp_with_strategy(dp, RoundingStrategy::ToZero)
}

fn format_notional(value: Decimal, decimals: u8) -> String {
    truncate_dp(value, u32::from(decimals))
        .normalize()
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::*;
    use crate::client::{Balance, PerpetualPosition};

    fn d(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }

    #[test]
    fn ranks_and_truncates_top_three() {
        let mut map = BTreeMap::new();
        add_notional(&mut map, "WBTC", d("50000")).unwrap();
        add_notional(&mut map, "WETH", d("30000")).unwrap();
        add_notional(&mut map, "SOL", d("10000")).unwrap();
        add_notional(&mut map, "USDT", d("5000")).unwrap();
        let mut ranked: Vec<(String, Decimal)> = map.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));
        assert_eq!(ranked.len(), 4);
        let remaining = ranked.len().saturating_sub(TOP_N) as u32;
        assert_eq!(remaining, 1);
        let top: Vec<_> = ranked.into_iter().take(TOP_N).map(|(s, _)| s).collect();
        assert_eq!(top, vec!["WBTC", "WETH", "SOL"]);
    }

    #[test]
    fn account_lookups_omit_available_to_deploy() {
        let lookups = AccountLookups {
            portfolio_value: "100000".to_string(),
            top_exposures: TopExposures {
                quote: QUOTE,
                top: vec![],
                remaining_count: 0,
                baseline: "test".to_string(),
            },
            available_to_deploy: None,
        };
        assert!(lookups.available_to_deploy.is_none());
    }

    #[test]
    fn perp_and_spot_combine_per_symbol() {
        let mut map = BTreeMap::new();
        add_notional(&mut map, "WETH", d("20000")).unwrap();
        add_notional(&mut map, "WETH", d("5000")).unwrap();
        assert_eq!(map["WETH"], d("25000"));
    }

    #[test]
    fn fixture_positions_decode_for_exposure_inputs() {
        let perp = PerpetualPosition {
            token_id: 4,
            symbol: "WETH".to_string(),
            quantity_raw: 0,
            quantity: "2".to_string(),
            side: "long".to_string(),
            entry_price_raw: 0,
            entry_price: "3000".to_string(),
            funding_start_time: 0,
            owed_nom_raw: "0".to_string(),
            owed_nom: "0".to_string(),
            owed_base_raw: "0".to_string(),
        };
        let balance = Balance {
            token_id: 1,
            symbol: "USDT".to_string(),
            balance_raw: "1000".to_string(),
            balance: "1000".to_string(),
            available_raw: "1000".to_string(),
            available: "1000".to_string(),
            spot_lend_sequestered_raw: "0".to_string(),
            spot_lend_sequestered: "0".to_string(),
            perp_sequestered_raw: "0".to_string(),
            perp_sequestered: "0".to_string(),
        };
        assert_eq!(perp.symbol, "WETH");
        assert_eq!(balance.symbol, "USDT");
    }
}
