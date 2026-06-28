//! Env routes — `GET /env/state`, `POST /env/setup` (SSE).
//!
//! Frontend contract (mirrors `sidecar/src/routes/env.ts`):
//!
//! * `GET /env/state` — returns the composite `EnvState` JSON. The
//!   SetupWizard banner polls this on mount and on visibility-change.
//!
//! * `POST /env/setup` — streams `text/event-stream` events:
//!   `event: phase  data: {"label": "..."}`,
//!   `event: log    data: {"stream":"stdout","line":"..."}`,
//!   `event: done   data: {}`,
//!   `event: error  data: {"message":"..."}`.
//!   Body (JSON, optional): `{ "extras": [...], "indexUrl": "..." }`.
//!   Client disconnect aborts the in-flight uv subprocess via the
//!   per-request CancellationToken.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::sse::{Event, Sse},
    Json,
};
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::env::{
    setup::{self, LogStream, SetupEvent, SetupOptions},
    state as env_state,
};
use crate::server::AppState;

// ── GET /env/state ──────────────────────────────────────────────────

pub async fn get_state(State(state): State<Arc<AppState>>) -> Json<env_state::EnvState> {
    Json(env_state::read_env_state(
        &state.project_dir,
        state.resource_dir.as_deref(),
    ))
}

// ── POST /env/setup ─────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SetupRequest {
    pub extras: Vec<String>,
    #[serde(rename = "indexUrl")]
    pub index_url: Option<String>,
    /// Force a re-sync even if a working env already exists. Without
    /// this the handler short-circuits to a done event.
    #[serde(default)]
    pub force: bool,
}

/// SSE handler. Returns immediately with the stream; the install runs
/// in a background task that writes events to a channel.
pub async fn post_setup(
    State(state): State<Arc<AppState>>,
    body: Option<Json<SetupRequest>>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, (StatusCode, String)>
{
    let req = body.map(|Json(r)| r).unwrap_or_default();

    // Refuse to start a second install if one is already running. The
    // frontend treats 409 as "subscribe to the existing one"; for now
    // we just say "busy" — same as the Node sidecar.
    if env_state::is_installing() {
        return Err((StatusCode::CONFLICT, "install already in progress".into()));
    }

    // Quick disk check: if the env is already ready and `force` is
    // false, emit a `done` event immediately so the frontend banner
    // can clear without spawning uv.
    let disk = env_state::read_disk_state(&state.project_dir, state.resource_dir.as_deref());
    if disk.venv_ok && !req.force {
        let (tx, rx) = mpsc::channel::<SetupEvent>(4);
        tokio::spawn(async move {
            let _ = tx
                .send(SetupEvent::Phase {
                    label: "Already up to date".into(),
                })
                .await;
            let _ = tx.send(SetupEvent::Done).await;
        });
        return Ok(Sse::new(channel_to_sse(rx)));
    }

    let uv = setup::resolve_uv_path(state.resource_dir.as_deref());
    let project_dir = state.project_dir.clone();
    let resource_dir = state.resource_dir.clone();
    let abort = CancellationToken::new();
    let abort_for_task = abort.clone();

    let (tx, rx) = mpsc::channel::<SetupEvent>(64);
    let tx_progress = tx.clone();
    let tx_for_task = tx.clone();
    let tx_for_watcher = tx;

    env_state::begin_install("Starting…");

    tokio::spawn(async move {
        // Mirror progress phases into the install-state bookkeeping
        // so polling /env/state shows the same label as the SSE stream.
        let (phase_tx, mut phase_rx) = mpsc::channel::<SetupEvent>(64);
        let progress_task = tokio::spawn(async move {
            while let Some(ev) = phase_rx.recv().await {
                if let SetupEvent::Phase { ref label } = ev {
                    env_state::set_install_phase(label);
                }
                if tx_progress.send(ev).await.is_err() {
                    break;
                }
            }
        });

        let opts = SetupOptions {
            project_dir,
            resource_dir,
            extras: &req.extras,
            index_url: req.index_url,
            uv_path: uv,
            abort: abort_for_task,
        };
        let result = setup::run_setup(opts, phase_tx).await;
        let _ = progress_task.await;

        match result {
            Ok(()) => {
                info!("env setup completed successfully");
                env_state::complete_install();
                // Clear bookkeeping shortly after so /env/state reverts
                // to a pure disk-based read.
                tokio::spawn(async {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    env_state::clear_install();
                });
            }
            Err(e) => {
                warn!("env setup failed: {e:#}");
                env_state::fail_install(&format!("{e:#}"));
                let _ = tx_for_task
                    .send(SetupEvent::Error {
                        message: format!("{e:#}"),
                    })
                    .await;
            }
        }
    });

    // When the client disconnects, axum drops the Sse response, which
    // drops the receiver. The watcher below detects that via
    // `Sender::closed()` and fires the abort token so the in-flight
    // uv subprocess is killed instead of running to completion in the
    // background.
    let abort_watcher = abort.clone();
    tokio::spawn(async move {
        tx_for_watcher.closed().await;
        abort_watcher.cancel();
    });

    Ok(Sse::new(channel_to_sse(rx)))
}

/// Convert the typed `SetupEvent` channel into an axum SSE stream.
fn channel_to_sse(
    rx: mpsc::Receiver<SetupEvent>,
) -> impl Stream<Item = Result<Event, std::convert::Infallible>> {
    futures::stream::unfold(rx, |mut rx| async move {
        let ev = rx.recv().await?;
        let (name, payload) = match &ev {
            SetupEvent::Phase { label } => ("phase", json!({ "label": label })),
            SetupEvent::Log { stream, line } => (
                "log",
                json!({
                    "stream": match stream { LogStream::Stdout => "stdout", LogStream::Stderr => "stderr" },
                    "line": line,
                }),
            ),
            SetupEvent::Done => ("done", json!({})),
            SetupEvent::Error { message } => ("error", json!({ "message": message })),
        };
        let event = Event::default().event(name).data(payload.to_string());
        Some((Ok(event), rx))
    })
}
