//! Heard-path for unfulfillable / near-match / unclear asks.
//! Never executes. Does not mention or call execute tools.
//! Interprets a NormalizedUtterance; does not persist voice records.

use serde_json::{Value, json};

use crate::brain::BrainClient;
use crate::mini_app::load_products;
use crate::speech_ontology::{self, Channel, LexiconEntry};

pub(crate) fn try_heard(account_id: u64, text: &str, extra: Option<&Value>) -> Option<Value> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut body = extra.cloned().unwrap_or_else(|| json!({}));
    let obj = body.as_object_mut()?;
    let has_slots = obj.get("slots").and_then(Value::as_array).is_some();
    if !has_slots {
        attach_normalized(account_id, text, obj);
    }
    obj.insert("account_id".into(), json!(account_id));
    obj.entry("text".to_string()).or_insert_with(|| json!(text));
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

fn attach_normalized(account_id: u64, text: &str, obj: &mut serde_json::Map<String, Value>) {
    let channel = obj
        .get("channel")
        .and_then(Value::as_str)
        .map(Channel::parse)
        .unwrap_or(Channel::Text);
    let catalog = catalog_symbols(obj.get("universe"));
    let lexicon = lexicon_for(account_id);
    let normalized = speech_ontology::normalize_utterance(text, channel, &catalog, &lexicon);
    obj.insert("text".into(), json!(normalized.normalized_text));
    obj.insert(
        "slots".into(),
        json!(
            normalized
                .slots
                .iter()
                .map(|row| row.to_json())
                .collect::<Vec<_>>()
        ),
    );
    obj.insert(
        "proposals".into(),
        json!(
            normalized
                .proposals
                .iter()
                .map(|row| row.to_json())
                .collect::<Vec<_>>()
        ),
    );
    obj.insert("grammar".into(), json!(normalized.grammar.as_str()));
    obj.insert(
        "action_ir".into(),
        normalized
            .action_ir
            .as_ref()
            .map(|ir| ir.to_json())
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "unknown_instruments".into(),
        json!(normalized.unknown_instruments),
    );
    obj.insert("channel".into(), json!(channel.as_str()));
    obj.insert(
        "ontology_version".into(),
        json!(normalized.ontology_version),
    );
}

fn catalog_symbols(universe: Option<&Value>) -> Vec<String> {
    if let Some(Value::Array(rows)) = universe {
        return rows
            .iter()
            .filter_map(|row| {
                row.get("symbol")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            })
            .collect();
    }
    load_products()
        .map(|catalog| catalog.products.into_iter().map(|row| row.symbol).collect())
        .unwrap_or_default()
}

fn lexicon_for(account_id: u64) -> Vec<LexiconEntry> {
    BrainClient::from_env()
        .voice_context(account_id)
        .ok()
        .and_then(|value| value.get("lexicon").and_then(Value::as_array).cloned())
        .map(|rows| rows.iter().filter_map(LexiconEntry::from_json).collect())
        .unwrap_or_default()
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
        map.entry("reply_verbatim".to_string())
            .or_insert(json!(true));
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
        let src = fs::read_to_string("src/cant.rs").expect("src/cant.rs");
        let prod = src.split("#[cfg(test)]").next().unwrap_or(&src);
        let forbidden = ["execute_", "ExecuteWorld", "stage_trade"];
        for needle in forbidden {
            assert!(!prod.contains(needle), "cant.rs must not name {needle}");
        }
    }

    #[test]
    fn wrap_forces_not_executable() {
        let value = wrap(json!({ "kind": "cant", "message": "x" }));
        assert_eq!(value["executable"], false);
        assert_eq!(value["skip_llm"], true);
        assert_eq!(value["reply_verbatim"], true);
    }

    #[test]
    fn empty_heard_falls_through() {
        assert!(try_heard(1, "   ", None).is_none());
    }
}
