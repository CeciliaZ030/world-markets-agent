//! Heard-path for unfulfillable / near-match / unclear asks.
//! Never executes. Does not mention or call execute tools.

use serde_json::{Value, json};

use crate::brain::BrainClient;
use crate::mini_app::load_products;

pub(crate) fn try_heard(account_id: u64, text: &str, extra: Option<&Value>) -> Option<Value> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut body = extra.cloned().unwrap_or_else(|| json!({}));
    let obj = body.as_object_mut()?;
    obj.insert("account_id".into(), json!(account_id));
    obj.insert("text".into(), json!(text));
    obj.entry("universe".to_string())
        .or_insert_with(universe_rows);
    match BrainClient::from_env().heard(&body) {
        Ok(value) => {
            let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
            if kind == "unmatched" || kind.is_empty() {
                return None;
            }
            Some(wrap(value))
        }
        Err(_) => None,
    }
}

fn universe_rows() -> Value {
    let Ok(catalog) = load_products() else {
        return json!([]);
    };
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for product in catalog.products {
        let symbol = product.symbol.trim();
        if symbol.is_empty() {
            continue;
        }
        let key = symbol.to_ascii_uppercase();
        if !seen.insert(key) {
            continue;
        }
        rows.push(json!({
            "symbol": product.symbol,
            "name": product.name,
        }));
    }
    Value::Array(rows)
}

fn wrap(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.insert("source".into(), json!("world-markets-cant"));
        map.insert("executable".into(), json!(false));
        map.entry("skip_llm".to_string()).or_insert(json!(true));
        map.entry("reply_verbatim".to_string()).or_insert(json!(true));
        map.entry("matched".to_string()).or_insert(json!(true));
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn cant_module_never_names_execute_tools() {
        let src = fs::read_to_string(file!()).unwrap_or_else(|_| {
            fs::read_to_string("src/cant.rs").expect("src/cant.rs")
        });
        assert!(
            !src.contains("execute_world"),
            "cant.rs must not name execute tools"
        );
        assert!(!src.contains("ExecuteWorld"));
    }

    #[test]
    fn wrap_forces_not_executable() {
        let value = wrap(json!({ "kind": "cant", "message": "x" }));
        assert_eq!(value["executable"], false);
        assert_eq!(value["skip_llm"], true);
    }
}
