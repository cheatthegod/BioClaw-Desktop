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

use axum::{routing::get, Router};
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

    let server = axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal());

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
        .with_state(state)
        .layer(TraceLayer::new_for_http())
}

/// Wait for any of: SIGTERM (unix), ctrl-C, or stdin EOF. Returns
/// when the first signal fires.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = tokio::signal::unix::signal(
            tokio::signal::unix::SignalKind::terminate(),
        ) {
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
                Ok(0) => return,           // EOF
                Ok(_) => continue,          // drain
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
