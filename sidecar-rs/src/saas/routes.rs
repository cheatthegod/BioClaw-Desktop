//! `/auth/session` + `/saas/{*path}` route handlers.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{OriginalUri, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use tracing::{debug, warn};

use crate::server::AppState;

// ── session routes ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct SetSessionRequest {
    pub token: String,
}

pub async fn set_session(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SetSessionRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    if req.token.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "empty token" })),
        );
    }
    state.saas.set_token(req.token);
    (StatusCode::OK, Json(json!({ "ok": true })))
}

pub async fn get_session(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(json!({ "authenticated": state.saas.is_authenticated() }))
}

pub async fn clear_session(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    state.saas.clear_token();
    Json(json!({ "ok": true }))
}

// ── /saas/{*path} proxy ─────────────────────────────────────────────

/// Headers we never forward upstream (hop-by-hop) or that reqwest/axum must
/// set themselves.
fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "content-length"
            | "cookie" // we set our own session cookie
    )
}

/// `ANY /saas/{*path}` → `<base>/api/{path}` (the keystone proxy).
pub async fn proxy(
    state: State<Arc<AppState>>,
    method: Method,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    proxy_with_prefix(state, method, uri, headers, body, "/saas", "/api").await
}

/// `GET /saas-files/{*path}` → `<base>/files/{path}`.
///
/// GPU job outputs (and other workspace files) are served by the SaaS at the
/// top-level `/files/…` route, NOT under `/api/…`, so the keystone proxy above
/// can't reach them. This sibling forwards to `/files/` with the same
/// cookie-attach + streaming behaviour, letting the desktop download FASTA/CIF
/// results in-app. `outputFiles` paths are workspace-root-relative, so the
/// renderer requests `/saas-files/chat/<chatJid>/<path>`.
pub async fn proxy_files(
    state: State<Arc<AppState>>,
    method: Method,
    uri: OriginalUri,
    headers: HeaderMap,
    body: Body,
) -> Response {
    proxy_with_prefix(state, method, uri, headers, body, "/saas-files", "/files").await
}

async fn proxy_with_prefix(
    State(state): State<Arc<AppState>>,
    method: Method,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Body,
    strip: &str,
    upstream_prefix: &str,
) -> Response {
    // Strip our local prefix; everything after maps onto `<base><upstream_prefix>/...`.
    let full_path = uri.path();
    let rest = full_path.strip_prefix(strip).unwrap_or(full_path);
    let rest = if rest.is_empty() { "/" } else { rest };
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let target = format!("{}{}{}{}", state.saas.base(), upstream_prefix, rest, query);

    // Collect the request body (request payloads are small — uploads go
    // through dedicated endpoints). Streaming the request body is possible
    // but unnecessary here and complicates reqwest construction.
    let body_bytes = match axum::body::to_bytes(body, 64 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "bad request body", "detail": e.to_string() })),
            )
                .into_response();
        }
    };

    let reqwest_method = match reqwest::Method::from_bytes(method.as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad method").into_response(),
    };

    let mut builder = state.saas.http().request(reqwest_method, &target);

    // Forward non-hop-by-hop request headers.
    for (name, value) in headers.iter() {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            builder = builder.header(name.as_str(), v);
        }
    }
    // Attach the session cookie if we have a token.
    if let Some(cookie) = state.saas.cookie_header() {
        builder = builder.header(header::COOKIE, cookie);
    }
    if !body_bytes.is_empty() {
        builder = builder.body(body_bytes.to_vec());
    }

    debug!(method = %method, target = %target, "proxying to SaaS");
    let upstream = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            warn!(target = %target, error = %e, "SaaS proxy upstream error");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "upstream", "detail": e.to_string() })),
            )
                .into_response();
        }
    };

    let status = upstream.status();

    // 401 → typed auth error so the UI can trigger re-login. We DON'T pass the
    // SaaS login HTML through; the renderer just needs to know to re-auth.
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "auth", "loginUrl": "/login" })),
        )
            .into_response();
    }

    // Build the response: copy status + safe headers, stream the body through
    // (so text/event-stream and large downloads don't buffer).
    let mut resp_headers = HeaderMap::new();
    for (name, value) in upstream.headers().iter() {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            axum::http::HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            resp_headers.insert(n, v);
        }
    }

    let axum_status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let stream = upstream.bytes_stream();
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = axum_status;
    *response.headers_mut() = resp_headers;
    response
}
