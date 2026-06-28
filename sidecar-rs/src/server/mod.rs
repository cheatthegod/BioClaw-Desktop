//! HTTP server core — the `serve` subcommand.
//!
//! Responsibilities:
//!   * Acquire the workspace lock (panic if a sibling sidecar is up).
//!   * Build the axum router with all routes wired (currently
//!     `/health`; more land in subsequent sub-stages).
//!   * Bind a TCP listener on `127.0.0.1:<port>` (port = 0 → OS
//!     assigns), print `PORT=NNNN\nREADY\n` to stdout for the Tauri
//!     supervisor.
//!   * Run the axum server until either a signal arrives (SIGTERM /
//!     ctrl-C / stdin EOF) or the server task fails.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    routing::{get, post},
    Router,
};
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use crate::cli::ServeOptions;
use crate::workspace::WorkspaceLock;

mod routes;
mod state;

pub use state::AppState;

pub async fn serve(opts: ServeOptions) -> anyhow::Result<()> {
    let lock = WorkspaceLock::acquire(&opts.workspace)?;

    let state = Arc::new(AppState::new(&opts)?);

    // Fire-and-forget background install if (a) we have a bundled
    // env zip and (b) the user's venv isn't ready. Mirrors the
    // Node sidecar's auto-setup behaviour: by the time the
    // frontend hits /env/state, the install is already in
    // progress and reports `installing` status. Skipped when no
    // resource_dir is configured (dev mode without a bundle).
    maybe_auto_install(state.clone());

    let app = build_router(state.clone());

    let addr: SocketAddr = format!("{}:{}", opts.host, opts.port).parse()?;
    let listener = TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;

    // CRITICAL: this stdout contract is parsed by the Tauri Rust
    // supervisor (src-tauri/src/sidecar.rs::parse_port_line). Do NOT
    // change the prefix without updating the supervisor.
    println!("PORT={}", bound.port());
    println!("READY");

    info!(addr = %bound, "sidecar listening");

    let server =
        axum::serve(listener, app.into_make_service()).with_graceful_shutdown(shutdown_signal());

    if let Err(e) = server.await {
        warn!(error = %e, "axum server exited with error");
    }

    // Release the workspace lock explicitly so the log line shows up
    // before process exit (Drop runs in undefined order otherwise).
    drop(lock);
    Ok(())
}

fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(routes::health::health))
        .route("/skills", get(routes::skills::list_skills))
        .route("/env/state", get(routes::env::get_state))
        .route("/env/setup", post(routes::env::post_setup))
        .route("/chat", post(routes::chat::post_chat))
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}

/// Spawn a background install task when the bundled zip is present
/// and the user's venv doesn't yet exist. Idempotent — bails if the
/// venv is already populated or no resource_dir is configured.
fn maybe_auto_install(state: Arc<AppState>) {
    let Some(resource_dir) = state.resource_dir.clone() else {
        return;
    };
    let zip = resource_dir.join("bioclaw-env.zip");
    if !zip.exists() {
        return;
    }
    let disk = crate::env::state::read_disk_state(&state.project_dir, Some(&resource_dir));
    if disk.venv_ok {
        info!("auto-install skipped — venv already ready");
        return;
    }
    info!(
        zip = %zip.display(),
        project_dir = %state.project_dir.display(),
        "auto-installing bundled env in background"
    );

    let project_dir = state.project_dir.clone();
    let resource_dir_clone = resource_dir.clone();
    let uv = crate::env::setup::resolve_uv_path(Some(&resource_dir));
    crate::env::state::begin_install("Preparing local Python kernel…");

    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel(32);
        let drain = tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                if let crate::env::setup::SetupEvent::Phase { label } = ev {
                    crate::env::state::set_install_phase(&label);
                }
            }
        });
        let opts = crate::env::setup::SetupOptions {
            project_dir,
            resource_dir: Some(resource_dir_clone),
            extras: &[],
            index_url: None,
            uv_path: uv,
            abort: tokio_util::sync::CancellationToken::new(),
        };
        let result = crate::env::setup::run_setup(opts, tx).await;
        let _ = drain.await;
        match result {
            Ok(()) => {
                info!("background env install completed");
                crate::env::state::complete_install();
                tokio::spawn(async {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    crate::env::state::clear_install();
                });
            }
            Err(e) => {
                warn!("background env install failed: {e:#}");
                crate::env::state::fail_install(&format!("{e:#}"));
            }
        }
    });
}

/// Wait for any of: SIGTERM (unix), ctrl-C, or stdin EOF. Returns
/// when the first signal fires.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            let _ = sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    let stdin_closed = async {
        use tokio::io::AsyncReadExt;
        // Tauri keeps stdin open while the sidecar should run; an
        // EOF here means the parent died and we should exit gracefully.
        let mut buf = [0u8; 1];
        let mut stdin = tokio::io::stdin();
        loop {
            match stdin.read(&mut buf).await {
                Ok(0) => return,   // EOF
                Ok(_) => continue, // drain
                Err(_) => return,
            }
        }
    };

    tokio::select! {
        _ = ctrl_c => { info!("ctrl-C received, shutting down"); }
        _ = terminate => { info!("SIGTERM received, shutting down"); }
        _ = stdin_closed => { info!("stdin closed (parent died), shutting down"); }
    }
}
