//! `POST /permissions/{decide,preload}` HTTP routes.
//!
//! Decide:  resolves an in-flight permission-needed request keyed
//!          by `requestId`. Body: `{ requestId, decision }`.
//! Preload: replaces the allow-always cache with the frontend's
//!          current persisted list. Body: `{ permissions: [{skillId,script}, …] }`.
//!          Atomically flushes to disk.

use std::sync::Arc;

use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::permissions::{PermissionDecision, PermissionKey};
use crate::server::AppState;

#[derive(Deserialize)]
pub struct DecideRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub decision: PermissionDecision,
}

#[derive(Serialize)]
pub struct DecideResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

pub async fn decide(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DecideRequest>,
) -> (StatusCode, Json<DecideResponse>) {
    if req.request_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(DecideResponse {
                ok: false,
                reason: Some("requestId is required"),
            }),
        );
    }
    let resolved = state
        .permissions
        .resolve_pending(&req.request_id, req.decision);
    if !resolved {
        return (
            StatusCode::NOT_FOUND,
            Json(DecideResponse {
                ok: false,
                reason: Some("unknown_or_already_resolved"),
            }),
        );
    }
    // If the user chose Allow, the tool handler is responsible for
    // calling permissions.remember() — the route handler doesn't see
    // the skill/script context for the request. The Node port did the
    // same thing.
    (
        StatusCode::OK,
        Json(DecideResponse {
            ok: true,
            reason: None,
        }),
    )
}

#[derive(Deserialize)]
pub struct PreloadRequest {
    pub permissions: Vec<PreloadEntry>,
}

#[derive(Deserialize)]
pub struct PreloadEntry {
    #[serde(rename = "skillId")]
    pub skill_id: String,
    pub script: String,
}

#[derive(Serialize)]
pub struct PreloadResponse {
    pub ok: bool,
    pub loaded: usize,
}

pub async fn preload(
    State(state): State<Arc<AppState>>,
    Json(req): Json<PreloadRequest>,
) -> (StatusCode, Json<PreloadResponse>) {
    let keys: Vec<PermissionKey> = req
        .permissions
        .into_iter()
        .map(|e| PermissionKey::new(e.skill_id, e.script))
        .collect();
    match state.permissions.preload(keys) {
        Ok(n) => (
            StatusCode::OK,
            Json(PreloadResponse {
                ok: true,
                loaded: n,
            }),
        ),
        Err(e) => {
            warn!("permissions preload failed: {e:#}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(PreloadResponse {
                    ok: false,
                    loaded: 0,
                }),
            )
        }
    }
}
