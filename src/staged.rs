//! Stage a user trade on the ledger, wait the cancel window, then fill.

use std::thread;
use std::time::Duration;

use aomi_sdk::DynToolCallCtx;
use serde_json::{Map, Value, json};

use crate::brain::BrainClient;
use crate::tool::{ExecuteWorldOrderArgs, WorldMarketsApp, place_world_order};

const DELAY: Duration = Duration::from_secs(3);

pub fn stage_and_schedule(
    brain: &BrainClient,
    account_id: u64,
    args: &ExecuteWorldOrderArgs,
    sentence: &str,
    mandate: Option<&Value>,
) -> Result<Value, String> {
    let mut params = json!({
        "product": args.product,
        "side": args.side,
        "base_symbol": args.base_symbol,
        "quote_symbol": args.quote_symbol,
        "quantity": args.quantity,
        "price": args.price,
        "order_type": args.order_type,
        "slippage": args.slippage,
        "account_id": account_id,
        "wallet_address": args.wallet_address,
    });
    if let Some(mandate) = mandate {
        params["handover_mandate"] = mandate.clone();
    }
    let staged = brain.stage_trade(&json!({
        "account_id": account_id,
        "sentence": sentence,
        "delay_secs": DELAY.as_secs(),
        "instrument": args.base_symbol,
        "params": params,
    }))?;
    let instruction_id = staged
        .pointer("/instruction/instruction_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !instruction_id.is_empty() {
        thread::spawn(move || {
            thread::sleep(DELAY);
            let _ = flush_staged_trade(account_id, &instruction_id);
        });
    }
    Ok(json!({
        "source": "world-markets-ledger",
        "executable": false,
        "staged": true,
        "execute_delay_secs": DELAY.as_secs(),
        "instruction": staged.get("instruction"),
        "cancel": staged
            .pointer("/instruction/task_id")
            .and_then(Value::as_str)
            .map(|id| format!("cancel task {id}")),
        "sentence": sentence,
        "hint": "on the ledger for 3 seconds — cancel if that's wrong, then it fills",
    }))
}

pub fn flush_staged_trade(account_id: u64, instruction_id: &str) -> Result<Value, String> {
    let app = WorldMarketsApp::default();
    let brain = BrainClient::from_env();
    let begun = match brain.begin_execute(account_id, instruction_id) {
        Ok(value) => value,
        Err(err) => {
            if skippable_begin(&err) {
                return Ok(json!({ "ok": true, "skipped": true, "detail": err }));
            }
            return Err(err);
        }
    };
    if begun.get("already") == Some(&Value::Bool(true)) {
        return Ok(json!({ "ok": true, "skipped": true, "already": true }));
    }
    let params = begun.get("params").cloned().unwrap_or(json!({}));
    let args = args_from_params(&params, account_id);
    let ctx = flush_ctx(&params);
    match place_world_order(&app, args, ctx) {
        Ok(value) if value.get("executable") == Some(&Value::Bool(false)) => {
            let detail = value
                .pointer("/policy_result/detail")
                .and_then(Value::as_str)
                .unwrap_or("mandate blocked");
            let _ = brain.complete_execute(
                account_id,
                instruction_id,
                &json!({
                    "failed": true,
                    "error": detail,
                    "receipt": detail,
                }),
            );
            Ok(value)
        }
        Ok(value) => {
            let receipt = value.get("receipt").cloned().unwrap_or(json!({}));
            let _ = brain.complete_execute(
                account_id,
                instruction_id,
                &json!({
                    "receipt": receipt_line(&value, &receipt),
                    "avg_price": avg_price(&receipt),
                    "result_ref": receipt.get("transaction_hash"),
                }),
            );
            Ok(value)
        }
        Err(err) => {
            let _ = brain.complete_execute(
                account_id,
                instruction_id,
                &json!({
                    "failed": true,
                    "error": err,
                    "receipt": err,
                }),
            );
            Err(err)
        }
    }
}

fn skippable_begin(err: &str) -> bool {
    err.contains("too_soon") || err.contains("cancelled") || err.contains("not_pending")
}

fn args_from_params(params: &Value, account_id: u64) -> ExecuteWorldOrderArgs {
    ExecuteWorldOrderArgs {
        product: params
            .get("product")
            .and_then(Value::as_str)
            .unwrap_or("spot")
            .to_string(),
        side: params
            .get("side")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        base_symbol: params
            .get("base_symbol")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        quote_symbol: params
            .get("quote_symbol")
            .and_then(Value::as_str)
            .map(str::to_string),
        quantity: params
            .get("quantity")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        price: params
            .get("price")
            .and_then(Value::as_str)
            .map(str::to_string),
        order_type: params
            .get("order_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        slippage: params
            .get("slippage")
            .and_then(Value::as_str)
            .map(str::to_string),
        account_id: Some(
            params
                .get("account_id")
                .and_then(Value::as_u64)
                .unwrap_or(account_id),
        ),
        wallet_address: params
            .get("wallet_address")
            .and_then(Value::as_str)
            .map(str::to_string),
        sentence: None,
    }
}

fn flush_ctx(params: &Value) -> DynToolCallCtx {
    let mut attrs = Map::new();
    if let Some(mandate) = params.get("handover_mandate") {
        attrs.insert("handover_mandate".to_string(), mandate.clone());
    }
    let mut world = Map::new();
    if let Some(id) = params.get("account_id") {
        world.insert("account_id".to_string(), id.clone());
    }
    if let Some(wallet) = params.get("wallet_address") {
        world.insert("owner_wallet".to_string(), wallet.clone());
    }
    if !world.is_empty() {
        attrs.insert("world".to_string(), Value::Object(world));
    }
    DynToolCallCtx {
        session_id: "flush-staged".to_string(),
        tool_name: "execute_world_order".to_string(),
        call_id: "flush-staged-1".to_string(),
        state_attributes: attrs,
        secrets: Default::default(),
    }
}

fn receipt_line(value: &Value, receipt: &Value) -> String {
    receipt
        .get("transaction_hash")
        .or_else(|| value.pointer("/receipt/transaction_hash"))
        .and_then(Value::as_str)
        .filter(|hash| !hash.is_empty())
        .map(|hash| format!("filled · {hash}"))
        .or_else(|| receipt.as_str().map(str::to_string))
        .unwrap_or_else(|| "filled".to_string())
}

fn avg_price(receipt: &Value) -> Value {
    receipt
        .get("avg_price")
        .or_else(|| receipt.get("price"))
        .cloned()
        .unwrap_or(Value::Null)
}
