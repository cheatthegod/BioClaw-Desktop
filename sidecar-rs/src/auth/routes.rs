//! `POST /auth/device-code/{start,poll}` route handlers.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, Json};
use serde::Deserialize;
use serde_json::json;
use tracing::warn;

use super::device_code::{Client, PollResponse, StartResponse};
use crate::server::AppState;

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct StartRequest {
    #[serde(rename = "clientName")]
    pub client_name: Option<String>,
    /// Optional SaaS base URL override. Default
    /// `https://chat.bioclaw.tech` — used in tests / staging.
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
}

pub async fn start(
    State(_state): State<Arc<AppState>>,
    body: Option<Json<StartRequest>>,
) -> Result<Json<StartResponse>, (StatusCode, Json<serde_json::Value>)> {
    let req = body.map(|Json(r)| r).unwrap_or_default();
    let client = Client::new(req.base_url.as_deref())
        .map_err(|e| upstream_error(format!("init device-code client: {e:#}")))?;
    let resp = client
        .start(req.client_name.as_deref())
        .await
        .map_err(|e| upstream_error(format!("start device-code: {e:#}")))?;
    Ok(Json(resp))
}

#[derive(Debug, Deserialize)]
pub struct PollRequest {
    #[serde(rename = "deviceCode")]
    pub device_code: String,
    /// Optional SaaS base URL override — caller must pass the same
    /// value across start + poll for a given flow, since the device
    /// code is bound to that server.
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
}

pub async fn poll(
    State(_state): State<Arc<AppState>>,
    Json(body): Json<PollRequest>,
) -> Result<Json<PollResponse>, (StatusCode, Json<serde_json::Value>)> {
    if body.device_code.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "deviceCode is required" })),
        ));
    }
    let client = Client::new(body.base_url.as_deref())
        .map_err(|e| upstream_error(format!("init device-code client: {e:#}")))?;
    let resp = client.poll(&body.device_code).await.map_err(|e| {
        warn!("device-code poll upstream error: {e:#}");
        upstream_error(format!("poll device-code: {e:#}"))
    })?;
    Ok(Json(resp))
}

fn upstream_error(msg: String) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg })))
}
