//! Telegram Mini App server: portfolio snapshot, instruction ledger, charts,
//! the tradeable-product catalog, Desk context, and hold-to-talk voice notes.
//!
//! Init-data HMAC follows Telegram's WebApp algorithm (HMAC-SHA256 keyed by
//! `WebAppData`, then HMAC of the sorted data-check string). The Mini App spec's
//! shorter "HMAC with the bot token as key" does not match Telegram and would
//! reject every real session.
//!
//! `/api/v1/mini-app/ledger*` is GET-only. Compose writes go through
//! `POST /api/v1/mini-app/compose` (Telegram sendData ingress), never `/ledger*`.

mod auth;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::RngCore;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::task::spawn_blocking;
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

const SESSION_TTL: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct AppState {
    bot_token: String,
    account_id: Option<u64>,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    dev_bypass: bool,
    desk_token: String,
}

struct Session {
    telegram_user_id: u64,
    expires_at: Instant,
}

#[derive(RustEmbed)]
#[folder = "static/"]
struct Assets;

#[derive(Debug, Deserialize)]
struct AuthRequest {
    init_data: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let bot_token = std::env::var("TELEGRAM_BOT_TOKEN").unwrap_or_default();
    let dev_bypass = std::env::var("MINI_APP_DEV_BYPASS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if bot_token.is_empty() && !dev_bypass {
        eprintln!("TELEGRAM_BOT_TOKEN is required (or set MINI_APP_DEV_BYPASS=1 for local UI)");
        std::process::exit(1);
    }

    let state = AppState {
        bot_token,
        account_id: world_markets::mini_app::account_id_from_env(),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        dev_bypass,
        desk_token: std::env::var("DESK_BRIDGE_TOKEN").unwrap_or_default(),
    };

    let app = Router::new()
        .route("/api/v1/mini-app/auth", post(auth_handler))
        .route("/api/v1/mini-app/portfolio", get(portfolio_handler))
        .route("/api/v1/mini-app/products", get(products_handler))
        .route("/api/v1/mini-app/chart", get(chart_handler))
        .route(
            "/api/v1/mini-app/ledger/summary",
            get(ledger_summary_handler),
        )
        .route("/api/v1/mini-app/ledger/{id}", get(ledger_one_handler))
        .route("/api/v1/mini-app/ledger", get(ledger_handler))
        .route("/api/v1/mini-app/compose", post(compose_handler))
        .route("/api/v1/mini-app/voice", post(voice_handler))
        .route("/api/v1/desk/context", get(desk_context_handler))
        .route("/api/v1/mini-app/health", get(health_handler))
        .fallback(static_handler)
        .layer(CorsLayer::permissive())
        .with_state(state);

    let bind = std::env::var("MINI_APP_BIND").unwrap_or_else(|_| "127.0.0.1:8080".to_string());
    let addr: SocketAddr = bind.parse().expect("MINI_APP_BIND must be host:port");
    tracing::info!("mini app listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind mini-app port");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("mini-app server");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health_handler() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn auth_handler(State(state): State<AppState>, Json(body): Json<AuthRequest>) -> Response {
    if state.dev_bypass && (body.init_data.is_empty() || body.init_data == "dev") {
        return issue_session(&state, 0);
    }
    if state.bot_token.is_empty() {
        return json_error(StatusCode::UNAUTHORIZED, "invalid_init_data");
    }
    match auth::verify_init_data(&body.init_data, &state.bot_token) {
        Ok(user_id) => issue_session(&state, user_id),
        Err(err) => {
            tracing::info!(error = %err, "initData rejected");
            json_error(StatusCode::UNAUTHORIZED, "invalid_init_data")
        }
    }
}

fn issue_session(state: &AppState, telegram_user_id: u64) -> Response {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = hex::encode(bytes);
    {
        let mut sessions = state.sessions.lock().expect("session lock");
        sessions.retain(|_, session| session.expires_at > Instant::now());
        sessions.insert(
            token.clone(),
            Session {
                telegram_user_id,
                expires_at: Instant::now() + SESSION_TTL,
            },
        );
    }
    (
        StatusCode::OK,
        Json(json!({
            "token": token,
            "expires_at": unix_now() + SESSION_TTL.as_secs(),
        })),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
struct ChartQuery {
    symbol: String,
    #[serde(default = "default_period")]
    period: String,
}

fn default_period() -> String {
    "d".to_string()
}

async fn portfolio_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !session_ok(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Some(account_id) = state.account_id else {
        tracing::error!("WORLD_ACCOUNT_ID is not set");
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed");
    };
    match spawn_blocking(move || {
        let mut portfolio = world_markets::mini_app::load_portfolio(account_id)?;
        if let Ok(ledger) = world_markets::mini_app::load_ledger(account_id)
            && let Some(counts) = ledger.get("watch_counts").and_then(Value::as_object)
        {
            world_markets::mini_app::apply_watch_counts(&mut portfolio, counts);
        }
        Ok::<_, String>(portfolio)
    })
    .await
    {
        Ok(Ok(portfolio)) => Json(portfolio).into_response(),
        Ok(Err(err)) => {
            tracing::error!(error = %err, "portfolio fetch failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
        Err(err) => {
            tracing::error!(error = %err, "portfolio task join failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
    }
}

async fn products_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !session_ok(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    match spawn_blocking(world_markets::mini_app::load_products).await {
        Ok(Ok(products)) => Json(products).into_response(),
        Ok(Err(err)) => {
            tracing::error!(error = %err, "products fetch failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
        Err(err) => {
            tracing::error!(error = %err, "products task join failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
    }
}

async fn chart_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ChartQuery>,
) -> Response {
    if !session_ok(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let symbol = query.symbol.clone();
    let period = query.period.clone();
    match spawn_blocking(move || world_markets::mini_app::load_chart(&symbol, &period)).await {
        Ok(Ok(chart)) => Json(chart).into_response(),
        Ok(Err(world_markets::mini_app::ChartError::BadRequest(_))) => {
            json_error(StatusCode::BAD_REQUEST, "bad_request")
        }
        Ok(Err(world_markets::mini_app::ChartError::NotFound(_))) => {
            json_error(StatusCode::NOT_FOUND, "not_found")
        }
        Ok(Err(err)) => {
            tracing::error!(error = %err, "chart fetch failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
        Err(err) => {
            tracing::error!(error = %err, "chart task join failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
    }
}

async fn ledger_summary_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !session_ok(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Some(account_id) = state.account_id else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed");
    };
    match spawn_blocking(move || world_markets::mini_app::load_ledger_summary(account_id)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => {
            tracing::error!(error = %err, "ledger summary failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
        Err(err) => {
            tracing::error!(error = %err, "ledger summary join failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
    }
}

async fn ledger_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !session_ok(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Some(account_id) = state.account_id else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed");
    };
    match spawn_blocking(move || world_markets::mini_app::load_ledger(account_id)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => {
            tracing::error!(error = %err, "ledger fetch failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
        Err(err) => {
            tracing::error!(error = %err, "ledger join failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
    }
}

async fn ledger_one_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !session_ok(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Some(account_id) = state.account_id else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed");
    };
    match spawn_blocking(move || world_markets::mini_app::load_instruction(account_id, &id)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) if err.contains("not_found") => json_error(StatusCode::NOT_FOUND, "not_found"),
        Ok(Err(err)) => {
            tracing::error!(error = %err, "ledger item failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
        Err(err) => {
            tracing::error!(error = %err, "ledger item join failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
    }
}

#[derive(Debug, Deserialize)]
struct ComposeRequest {
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    message: String,
    #[serde(default)]
    instruction_id: Option<String>,
    #[serde(default)]
    fire_kind: Option<String>,
    #[serde(default)]
    instrument: Option<String>,
}

async fn compose_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ComposeRequest>,
) -> Response {
    if !session_ok(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Some(account_id) = state.account_id else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed");
    };
    let chat_id = session_telegram_user(&state, &headers);
    let bot_token = state.bot_token.clone();
    let kind = body.kind.clone().unwrap_or_default();
    let payload = json!({
        "account_id": account_id,
        "correlation_id": body.correlation_id,
        "kind": body.kind,
        "message": body.message,
        "instruction_id": body.instruction_id,
        "fire_kind": body.fire_kind,
        "instrument": body.instrument,
    });
    match spawn_blocking(move || -> Result<Value, String> {
        let value = world_markets::mini_app::submit_compose(&payload)?;
        if kind == "cancel" {
            let command = value
                .pointer("/thread/command")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| payload_message(&payload));
            let mut lines = vec![command];
            if let Some(reply) = value
                .pointer("/thread/reply")
                .or_else(|| value.get("reply"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                lines.push(reply.to_string());
            }
            if let Some(chat_id) = chat_id {
                if let Err(err) =
                    world_markets::mini_app::post_chat_lines(&bot_token, chat_id, &lines)
                {
                    tracing::warn!(error = %err, "cancel chat echo failed");
                }
            }
        }
        Ok(value)
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => {
            tracing::error!(error = %err, "compose failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
        Err(err) => {
            tracing::error!(error = %err, "compose join failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
    }
}

#[derive(Debug, Deserialize)]
struct VoiceRequest {
    #[serde(default)]
    audio_base64: Option<String>,
    #[serde(default)]
    mime: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

async fn desk_context_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !desk_or_session_ok(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let Some(account_id) = state.account_id else {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed");
    };
    match spawn_blocking(move || world_markets::mini_app::load_desk_context(account_id)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => {
            tracing::error!(error = %err, "desk context failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
        Err(err) => {
            tracing::error!(error = %err, "desk context join failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
    }
}

async fn voice_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<VoiceRequest>,
) -> Response {
    if !session_ok(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let chat_id = session_telegram_user(&state, &headers);
    let bot_token = state.bot_token.clone();
    let session_id = chat_id
        .map(|id| format!("tg-{id}"))
        .unwrap_or_else(|| "mini".to_string());
    let payload = json!({
        "session_id": session_id,
        "audio_base64": body.audio_base64,
        "mime": body.mime,
        "text": body.text,
        "complete_tts": true,
    });
    match spawn_blocking(move || -> Result<Value, String> {
        let value = world_markets::mini_app::post_desk_voice(&payload)?;
        let mut lines = Vec::new();
        if let Some(transcript) = value.get("transcript").and_then(|v| v.as_str()) {
            if !transcript.is_empty() {
                lines.push(format!("Voice note: {transcript}"));
            }
        }
        if let Some(speech) = value.get("speech").and_then(|v| v.as_str()) {
            if !speech.is_empty() {
                lines.push(speech.to_string());
            }
        }
        if let Some(chat_id) = chat_id {
            if let Err(err) = world_markets::mini_app::post_chat_lines(&bot_token, chat_id, &lines) {
                tracing::warn!(error = %err, "voice chat echo failed");
            }
        }
        Ok(value)
    })
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => {
            tracing::error!(error = %err, "voice note failed");
            let code = if err.contains("not reachable") {
                StatusCode::BAD_GATEWAY
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(code, "desk_unavailable")
        }
        Err(err) => {
            tracing::error!(error = %err, "voice note join failed");
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed")
        }
    }
}

fn payload_message(payload: &Value) -> String {
    payload
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("cancel task")
        .to_string()
}

fn session_ok(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(token) = bearer_token(headers) else {
        return false;
    };
    let mut sessions = state.sessions.lock().expect("session lock");
    sessions.retain(|_, session| session.expires_at > Instant::now());
    sessions.contains_key(&token)
}

fn desk_or_session_ok(state: &AppState, headers: &HeaderMap) -> bool {
    if session_ok(state, headers) {
        return true;
    }
    let presented = desk_token(headers);
    if !state.desk_token.is_empty() {
        return presented.as_deref() == Some(state.desk_token.as_str());
    }
    state.dev_bypass
}

fn desk_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-desk-token")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn session_telegram_user(state: &AppState, headers: &HeaderMap) -> Option<u64> {
    let token = bearer_token(headers)?;
    let mut sessions = state.sessions.lock().expect("session lock");
    sessions.retain(|_, session| session.expires_at > Instant::now());
    let id = sessions.get(&token)?.telegram_user_id;
    (id != 0).then_some(id)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn bearer_token(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    raw.strip_prefix("Bearer ")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn json_error(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() || path == "portfolio" || path == "chart" {
        "index.html"
    } else {
        path
    };
    match Assets::get(path) {
        Some(file) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime_for(path))
            .body(axum::body::Body::from(file.data.into_owned()))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        None => {
            if let Some(index) = Assets::get("index.html") {
                Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(axum::body::Body::from(index.data.into_owned()))
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
            } else {
                StatusCode::NOT_FOUND.into_response()
            }
        }
    }
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ledger_routes_are_get_only() {
        let src = include_str!("main.rs");
        assert!(src.contains("get(ledger_summary_handler)"));
        assert!(src.contains("get(ledger_one_handler)"));
        assert!(src.contains("get(ledger_handler)"));
        for line in src.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("//") || trimmed.starts_with("//!") {
                continue;
            }
            if !trimmed.contains("/api/v1/mini-app/ledger") && !trimmed.contains("ledger_") {
                continue;
            }
            assert!(
                !trimmed.contains("post(")
                    && !trimmed.contains("put(")
                    && !trimmed.contains("patch(")
                    && !trimmed.contains("delete("),
                "ledger route must not mutate: {trimmed}"
            );
        }
    }

    #[test]
    fn products_route_is_get() {
        let src = include_str!("main.rs");
        assert!(src.contains(r#".route("/api/v1/mini-app/products", get(products_handler))"#));
    }

    #[test]
    fn voice_is_not_a_ledger_route() {
        let src = include_str!("main.rs");
        assert!(src.contains(r#".route("/api/v1/mini-app/voice", post(voice_handler))"#));
        assert!(src.contains(r#".route("/api/v1/desk/context", get(desk_context_handler))"#));
    }
}
