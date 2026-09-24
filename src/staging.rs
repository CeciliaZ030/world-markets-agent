//! Venue calldata the app assembles itself and hands to the host as a routed
//! tool return. The host stages exactly these bytes, then enforces one batch
//! simulation and one atomic commit. The model never types a selector, an
//! argument, or an order word, and cannot reorder or skip the chain.

use alloy_primitives::{Address, U256, hex};
use alloy_sol_types::{SolCall, sol};
use aomi_sdk::{EnforcementPolicy, ToolReturn};
use serde_json::{Value, json};

use crate::client::WorldClient;

sol! {
    function newSpotBuyOrder(address book, uint256 word);
    function newSpotSellOrder(address book, uint256 word);
    function newPerpBuyOrder(address book, uint256 word);
    function newPerpSellOrder(address book, uint256 word);
    function cancelSpotBuyOrder(address book, uint256 word);
    function cancelSpotSellOrder(address book, uint256 word);
    function cancelPerpBuyOrder(address book, uint256 word);
    function cancelPerpSellOrder(address book, uint256 word);
    function newLendOrder(address book, uint256 word);
    function newBorrowOrder(address book, uint256 word);
    function cancelLendOrder(address book, uint256 word);
    function cancelBorrowOrder(address book, uint256 word);
    function renewLoan(uint64 user, uint64 userToPay, uint64 almostDueLendingId);
    function payInterestAndFees(uint64 positionId, uint64 reduceQuantity, bool extendPeriod);
}

/// Where a call goes: the exchange contract on the World chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Venue {
    pub(crate) exchange: String,
    pub(crate) chain_id: u64,
}

impl Venue {
    pub(crate) fn of(client: &WorldClient) -> Self {
        Self {
            exchange: client.exchange(),
            chain_id: client.chain_id(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OrderAction {
    New,
    Cancel,
}

/// One exchange call, fully encoded, plus the human description the host
/// shows beside it. Every field the stage step needs is derived here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StagedCall {
    pub(crate) exchange: String,
    pub(crate) chain_id: u64,
    pub(crate) signature: &'static str,
    pub(crate) args: Vec<String>,
    pub(crate) calldata: String,
    pub(crate) description: String,
}

impl StagedCall {
    /// A `new*Order` / `cancel*Order(address,uint256)` call. `side` is already
    /// normalised: `buy` / `sell` on a spot or perp book, `lend` / `borrow` on
    /// a lend book.
    pub(crate) fn order(
        venue: Venue,
        action: OrderAction,
        product: &str,
        side: &str,
        book: Address,
        word: U256,
        description: String,
    ) -> Result<Self, String> {
        let (signature, calldata) = match (action, product, side) {
            (OrderAction::New, "spot", "buy") => (
                "newSpotBuyOrder(address,uint256)",
                newSpotBuyOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::New, "spot", "sell") => (
                "newSpotSellOrder(address,uint256)",
                newSpotSellOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::New, "perp", "buy") => (
                "newPerpBuyOrder(address,uint256)",
                newPerpBuyOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::New, "perp", "sell") => (
                "newPerpSellOrder(address,uint256)",
                newPerpSellOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::Cancel, "spot", "buy") => (
                "cancelSpotBuyOrder(address,uint256)",
                cancelSpotBuyOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::Cancel, "spot", "sell") => (
                "cancelSpotSellOrder(address,uint256)",
                cancelSpotSellOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::Cancel, "perp", "buy") => (
                "cancelPerpBuyOrder(address,uint256)",
                cancelPerpBuyOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::Cancel, "perp", "sell") => (
                "cancelPerpSellOrder(address,uint256)",
                cancelPerpSellOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::New, "lend", "lend") => (
                "newLendOrder(address,uint256)",
                newLendOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::New, "lend", "borrow") => (
                "newBorrowOrder(address,uint256)",
                newBorrowOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::Cancel, "lend", "lend") => (
                "cancelLendOrder(address,uint256)",
                cancelLendOrderCall { book, word }.abi_encode(),
            ),
            (OrderAction::Cancel, "lend", "borrow") => (
                "cancelBorrowOrder(address,uint256)",
                cancelBorrowOrderCall { book, word }.abi_encode(),
            ),
            _ => {
                return Err(format!(
                    "[world-markets] no venue function for {product} {side} order"
                ));
            }
        };
        Ok(Self {
            exchange: venue.exchange,
            chain_id: venue.chain_id,
            signature,
            args: vec![format!("{book:#x}"), format!("0x{word:064x}")],
            calldata: hex::encode_prefixed(calldata),
            description,
        })
    }

    /// `renewLoan(user, userToPay, almostDueLendingId)`: the borrower pays for
    /// itself, so both account arguments are the bound account.
    pub(crate) fn renew_loan(
        venue: Venue,
        account_id: u64,
        position_id: u64,
        description: String,
    ) -> Self {
        Self {
            exchange: venue.exchange,
            chain_id: venue.chain_id,
            signature: "renewLoan(uint64,uint64,uint64)",
            args: vec![
                account_id.to_string(),
                account_id.to_string(),
                position_id.to_string(),
            ],
            calldata: hex::encode_prefixed(
                renewLoanCall {
                    user: account_id,
                    userToPay: account_id,
                    almostDueLendingId: position_id,
                }
                .abi_encode(),
            ),
            description,
        }
    }

    /// `payInterestAndFees(positionId, reduceQuantity, extendPeriod)`.
    pub(crate) fn pay_interest(
        venue: Venue,
        position_id: u64,
        reduce_quantity_raw: u64,
        extend_period: bool,
        description: String,
    ) -> Self {
        Self {
            exchange: venue.exchange,
            chain_id: venue.chain_id,
            signature: "payInterestAndFees(uint64,uint64,bool)",
            args: vec![
                position_id.to_string(),
                reduce_quantity_raw.to_string(),
                extend_period.to_string(),
            ],
            calldata: hex::encode_prefixed(
                payInterestAndFeesCall {
                    positionId: position_id,
                    reduceQuantity: reduce_quantity_raw,
                    extendPeriod: extend_period,
                }
                .abi_encode(),
            ),
            description,
        }
    }

    /// The transparent record of the call, kept in the tool result so the
    /// receipt can name what was staged.
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "to": self.exchange,
            "chain_id": self.chain_id,
            "signature": self.signature,
            "args": self.args,
            "calldata": self.calldata,
            "description": self.description,
            "value": "0",
        })
    }

    /// The exact `evm_stage_tx` arguments. Raw calldata: an empty signature
    /// with empty args tells the host to take `raw` verbatim.
    pub(crate) fn stage_args(&self) -> Value {
        json!({
            "to": self.exchange,
            "description": self.description,
            "data": { "signature": "", "args": [], "raw": self.calldata },
            "chain_id": self.chain_id,
            "value": "0",
            "kind": "contract_call",
            "protocol": "world-markets",
        })
    }

    /// Attach every call to `value` and route them in order: the host stages
    /// each leg, and after the last must simulate the whole batch and commit
    /// it once, stopping on any failure. One call is the single-leg route.
    pub(crate) fn routed_batch(calls: Vec<StagedCall>, mut value: Value) -> ToolReturn {
        if calls.len() <= 1 {
            return match calls.into_iter().next() {
                Some(call) => call.routed(value),
                None => ToolReturn::value(value),
            };
        }
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "staged".to_string(),
                Value::Array(calls.iter().map(StagedCall::to_json).collect()),
            );
            obj.insert("executable".to_string(), json!(true));
        }
        let total = calls.len();
        let stages: Vec<Value> = calls.iter().map(StagedCall::stage_args).collect();
        ToolReturn::route(value)
            .next(|next| {
                for (index, stage) in stages.into_iter().enumerate() {
                    let step = next.add_named("evm_stage_tx", stage).note(format!(
                        "Stage leg {} of {total} exactly as given, in this order. After the last leg the host simulates the whole batch and commits it atomically; never edit a field, never add a leg.",
                        index + 1
                    ));
                    if index + 1 == total {
                        step.enforce(EnforcementPolicy::Stop, |enforce| {
                            enforce.add_named("simulate_batch", json!({}));
                            enforce
                                .add_named("evm_commit_txs", json!({}))
                                .bind_as("transaction_hash");
                        });
                    }
                }
            })
            .build()
    }

    /// Attach this call to `value` and route it: the host stages it next,
    /// then must simulate the batch and commit it, stopping on any failure.
    pub(crate) fn routed(self, mut value: Value) -> ToolReturn {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("staged".to_string(), self.to_json());
            obj.insert("executable".to_string(), json!(true));
        }
        let stage = self.stage_args();
        ToolReturn::route(value)
            .next(|next| {
                next.add_named("evm_stage_tx", stage)
                    .note(
                        "Stage this exact World transaction now. The host then simulates the batch and commits it atomically under the bound execution policy; never edit a field, never stage anything else with it.",
                    )
                    .enforce(EnforcementPolicy::Stop, |enforce| {
                        enforce.add_named("simulate_batch", json!({}));
                        enforce
                            .add_named("evm_commit_txs", json!({}))
                            .bind_as("transaction_hash");
                    });
            })
            .build()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    const EXCHANGE: &str = "0xf6b54e033bb45a583aa642924bcef78b804588ae";

    fn venue() -> Venue {
        Venue {
            exchange: EXCHANGE.to_string(),
            chain_id: 2092151908,
        }
    }

    fn book() -> Address {
        Address::from_str("0x6666666666666666666666666666666666666666").unwrap()
    }

    #[test]
    fn order_call_encodes_the_venue_selector_and_word() {
        let word = U256::from(0x6290000000000000064u128);
        let call = StagedCall::order(
            venue(),
            OrderAction::New,
            "spot",
            "sell",
            book(),
            word,
            "sell 0.01 WETH".to_string(),
        )
        .unwrap();
        assert_eq!(call.signature, "newSpotSellOrder(address,uint256)");
        let expected = newSpotSellOrderCall { book: book(), word }.abi_encode();
        assert_eq!(call.calldata, hex::encode_prefixed(expected));
        assert!(call.calldata.starts_with("0x"));
        assert_eq!(call.calldata.len(), 2 + 8 + 64 * 2);
        assert_eq!(call.args[0], format!("{:#x}", book()));

        let cancel = StagedCall::order(
            venue(),
            OrderAction::Cancel,
            "perp",
            "buy",
            book(),
            word,
            String::new(),
        )
        .unwrap();
        assert_eq!(cancel.signature, "cancelPerpBuyOrder(address,uint256)");
        let lend = StagedCall::order(
            venue(),
            OrderAction::New,
            "lend",
            "borrow",
            book(),
            word,
            String::new(),
        )
        .unwrap();
        assert_eq!(lend.signature, "newBorrowOrder(address,uint256)");
        assert_eq!(
            StagedCall::order(
                venue(),
                OrderAction::Cancel,
                "lend",
                "lend",
                book(),
                word,
                String::new()
            )
            .unwrap()
            .signature,
            "cancelLendOrder(address,uint256)"
        );
        assert!(
            StagedCall::order(
                venue(),
                OrderAction::New,
                "lend",
                "buy",
                book(),
                word,
                String::new()
            )
            .is_err()
        );
    }

    #[test]
    fn loan_calls_use_the_bound_account_twice_and_encode_the_bool() {
        let renew = StagedCall::renew_loan(venue(), 1577, 42, "".into());
        assert_eq!(renew.args, ["1577", "1577", "42"]);
        assert_eq!(
            renew.calldata,
            hex::encode_prefixed(
                renewLoanCall {
                    user: 1577,
                    userToPay: 1577,
                    almostDueLendingId: 42
                }
                .abi_encode()
            )
        );
        let pay = StagedCall::pay_interest(venue(), 42, 0, true, "".into());
        assert_eq!(pay.args, ["42", "0", "true"]);
        assert!(pay.calldata.ends_with(&format!("{:064x}", 1)));
    }

    #[test]
    fn a_batch_stages_every_leg_in_order_and_enforces_once_after_the_last() {
        let first = StagedCall::renew_loan(venue(), 1577, 42, "first".into());
        let second = StagedCall::pay_interest(venue(), 43, 0, false, "second".into());
        let routed = StagedCall::routed_batch(vec![first.clone(), second.clone()], json!({}));
        assert_eq!(routed.value["staged"].as_array().unwrap().len(), 2);
        assert_eq!(routed.value["executable"], true);
        assert_eq!(routed.routes.len(), 2);
        assert_eq!(routed.routes[0].args["data"]["raw"], first.calldata);
        assert_eq!(routed.routes[1].args["data"]["raw"], second.calldata);
        assert!(routed.routes[0].enforcement.is_none());
        let enforcement = routed.routes[1].enforcement.as_ref().unwrap();
        assert_eq!(enforcement.steps[0].tool, "simulate_batch");
        assert_eq!(enforcement.steps[1].tool, "evm_commit_txs");
        assert!(
            StagedCall::routed_batch(vec![], json!({ "x": 1 }))
                .routes
                .is_empty()
        );
    }

    #[test]
    fn routed_return_stages_then_enforces_simulate_and_commit() {
        let call = StagedCall::renew_loan(venue(), 1577, 42, "renew".into());
        let routed = call.clone().routed(json!({ "source": "test" }));
        assert_eq!(routed.value["staged"]["signature"], call.signature);
        assert_eq!(routed.value["executable"], true);
        assert_eq!(routed.routes.len(), 1);
        let stage = &routed.routes[0];
        assert_eq!(stage.tool, "evm_stage_tx");
        assert_eq!(stage.args["to"], EXCHANGE);
        assert_eq!(stage.args["data"]["raw"], call.calldata);
        assert_eq!(stage.args["data"]["signature"], "");
        assert_eq!(stage.args["chain_id"], 2092151908u64);
        let enforcement = stage.enforcement.as_ref().expect("enforced follow-up");
        assert_eq!(enforcement.on_failure, EnforcementPolicy::Stop);
        assert_eq!(enforcement.steps[0].tool, "simulate_batch");
        assert_eq!(enforcement.steps[1].tool, "evm_commit_txs");
        assert!(enforcement.binds_alias("transaction_hash"));
    }
}
