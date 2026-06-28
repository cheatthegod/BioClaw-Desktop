//! `GET /health` — used by the Tauri shell to confirm the sidecar is
//! responsive before driving any other endpoint. Returns the version
//! string + workspace key so the frontend can correlate which
//! sidecar instance is on the line (matters once we support multiple
//! workspaces).

use std::sync::Arc;

use axum::{extract::State, Json};
use serde::Serialize;

use crate::server::AppState;

#[derive(Serialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub version: &'static str,
    pub workspace: String,
}

pub async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        version: state.version,
        workspace: state.workspace.clone(),
    })
}
