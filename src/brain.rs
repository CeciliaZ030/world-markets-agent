//! HTTP client for the unsigned brain sidecar (`brain/`).
//!
//! News, mark history, watches, preferences, and the outbound queue live there.
//! This client has no signing, submit, or order-placement path.

use std::time::Duration;

use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::{Value, json};

const DEFAULT_URL: &str = "http://127.0.0.1:8788";

#[derive(Clone)]
pub(crate) struct BrainClient {
    http: Client,
    base_url: String,
}

impl Default for BrainClient {
    fn default() -> Self {
        Self::from_env()
    }
}

impl BrainClient {
    pub(crate) fn from_env() -> Self {
        let base_url = std::env::var("WORLD_BRAIN_URL")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_URL.to_string());
        Self {
            http: Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .expect("brain HTTP client"),
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    pub(crate) fn research(&self, symbol: &str, window_secs: u64) -> Result<Value, String> {
        self.get(&format!(
            "/v1/research?symbol={symbol}&window_secs={window_secs}"
        ))
    }

    pub(crate) fn history_move(&self, symbol: &str, window_secs: u64) -> Result<Value, String> {
        self.get(&format!(
            "/v1/history/move?symbol={symbol}&window_secs={window_secs}"
        ))
    }

    pub(crate) fn tasks(&self, account_id: u64) -> Result<Value, String> {
        self.get(&format!("/v1/tasks?account_id={account_id}"))
    }

    pub(crate) fn ingest(&self, body: &Value) -> Result<Value, String> {
        self.post("/v1/history/ingest", body)
    }

    pub(crate) fn portfolio_impact(&self, body: &Value) -> Result<Value, String> {
        self.post("/v1/portfolio-impact", body)
    }

    pub(crate) fn set_watch(&self, body: &Value) -> Result<Value, String> {
        self.post("/v1/watches", body)
    }

    pub(crate) fn cancel_watch(&self, account_id: u64, id: &str) -> Result<Value, String> {
        self.post(
            "/v1/watches/cancel",
            &json!({ "account_id": account_id, "id": id }),
        )
    }

    pub(crate) fn set_preference(&self, body: &Value) -> Result<Value, String> {
        self.post("/v1/preferences", body)
    }

    pub(crate) fn cancel_preference(&self, account_id: u64, id: &str) -> Result<Value, String> {
        self.post(
            "/v1/preferences/cancel",
            &json!({ "account_id": account_id, "id": id }),
        )
    }

    pub(crate) fn seed_brief(&self, account_id: u64, brief: &Value) -> Result<Value, String> {
        self.post(
            "/v1/preferences/seed",
            &json!({ "account_id": account_id, "brief": brief }),
        )
    }

    pub(crate) fn drain_outbound(&self, limit: u32) -> Result<Value, String> {
        self.post("/v1/outbound/drain", &json!({ "limit": limit }))
    }

    pub(crate) fn ledger_summary(&self, account_id: u64) -> Result<Value, String> {
        self.get(&format!("/v1/ledger/summary?account_id={account_id}"))
    }

    pub(crate) fn ledger(&self, account_id: u64) -> Result<Value, String> {
        self.get(&format!("/v1/ledger?account_id={account_id}"))
    }

    pub(crate) fn ledger_one(&self, account_id: u64, id: &str) -> Result<Value, String> {
        let encoded = id
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect::<String>();
        self.get(&format!("/v1/ledger/{encoded}?account_id={account_id}"))
    }

    pub(crate) fn compose(&self, body: &Value) -> Result<Value, String> {
        self.post("/v1/compose", body)
    }

    pub(crate) fn pause_watch(
        &self,
        account_id: u64,
        id: Option<&str>,
        instruction_id: Option<&str>,
    ) -> Result<Value, String> {
        self.post(
            "/v1/watches/pause",
            &json!({
                "account_id": account_id,
                "id": id,
                "instruction_id": instruction_id,
            }),
        )
    }

    pub(crate) fn resume_watch(
        &self,
        account_id: u64,
        id: Option<&str>,
        instruction_id: Option<&str>,
    ) -> Result<Value, String> {
        self.post(
            "/v1/watches/resume",
            &json!({
                "account_id": account_id,
                "id": id,
                "instruction_id": instruction_id,
            }),
        )
    }

    fn get(&self, path: &str) -> Result<Value, String> {
        let url = format!("{}{path}", self.base_url);
        let response = self
            .http
            .get(&url)
            .send()
            .map_err(|error| unreachable_brain(&url, error))?;
        parse_response(response)
    }

    fn post<T: Serialize>(&self, path: &str, body: &T) -> Result<Value, String> {
        let url = format!("{}{path}", self.base_url);
        let response = self
            .http
            .post(&url)
            .json(body)
            .send()
            .map_err(|error| unreachable_brain(&url, error))?;
        parse_response(response)
    }
}

fn parse_response(response: reqwest::blocking::Response) -> Result<Value, String> {
    let status = response.status();
    let value: Value = response
        .json()
        .map_err(|error| format!("[world-markets] brain returned invalid JSON: {error}"))?;
    if !status.is_success() || value.get("ok") == Some(&Value::Bool(false)) {
        let detail = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("brain sidecar rejected the request");
        return Err(format!("[world-markets] {detail}"));
    }
    Ok(value)
}

fn unreachable_brain(url: &str, error: reqwest::Error) -> String {
    format!(
        "[world-markets] brain sidecar is not reachable at {url} ({error}). Start it with `npm start` in brain/ (scripts/dev-run.sh starts it)."
    )
}
