//! Telegram Mini App server for the World Markets portfolio snapshot.
//!
//! Init-data HMAC follows Telegram's WebApp algorithm (HMAC-SHA256 keyed by
//! `WebAppData`, then HMAC of the sorted data-check string). The Mini App spec's
//! shorter "HMAC with the bot token as key" does not match Telegram and would
//! reject every real session.

mod auth;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::State;
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
}

struct Session {
    #[allow(dead_code)]
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
    };

    let app = Router::new()
        .route("/api/v1/mini-app/auth", post(auth_handler))
        .route("/api/v1/mini-app/portfolio", get(portfolio_handler))
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

async fn portfolio_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(token) = bearer_token(&headers) else {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    {
        let mut sessions = state.sessions.lock().expect("session lock");
        sessions.retain(|_, session| session.expires_at > Instant::now());
        if !sessions.contains_key(&token) {
            return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
        }
    }
    let Some(account_id) = state.account_id else {
        tracing::error!("WORLD_ACCOUNT_ID is not set");
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "fetch_failed");
    };
    match spawn_blocking(move || world_markets::mini_app::load_portfolio(account_id)).await {
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
    let path = if path.is_empty() || path == "portfolio" {
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
