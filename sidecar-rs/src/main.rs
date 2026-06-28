//! BioClaw Desktop sidecar — single Rust binary that the Tauri shell
//! spawns as an externalBin. Replaces the Phase-2 Node.js sidecar
//! (`sidecar/src/main.ts`) which required Node on the user's PATH —
//! the Rust binary is statically linked and has no external runtime
//! dependency, mirroring OmicOS's `omicos.exe` design (~23 MB).
//!
//! ## CLI surface
//!
//! The default invocation (no subcommand) runs [`commands::serve`],
//! which is what Tauri calls. Other subcommands are exposed for the
//! eventual `bioclaw` CLI binary alias and for direct user invocation
//! from a terminal:
//!
//! ```text
//! bioclaw-sidecar                   # equivalent to `serve`
//! bioclaw-sidecar serve             # explicit serve
//! bioclaw-sidecar env setup         # install / repair the bundled
//!                                   # Python env (uv-managed venv at
//!                                   # ~/.bioclaw/env)
//! bioclaw-sidecar env doctor        # diagnostics
//! bioclaw-sidecar version           # print version string
//! ```
//!
//! ## Process model
//!
//! The Tauri shell spawns this binary, reads its stdout for the
//! `PORT=NNNN\n` line, then `READY\n`. It keeps stdin open while the
//! sidecar should run; closing stdin triggers a graceful shutdown
//! (handled in the serve loop). Same contract as the Node sidecar
//! used in Phase 4 — Tauri's externalBin supervisor doesn't change.

use clap::Parser;
use tracing::error;

// Modules are owned by the library target (src/lib.rs) so unit tests
// can reach them; the binary just re-imports through the crate root.
use bioclaw_sidecar::{cli, logging, server};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = cli::Cli::parse();

    // Logging is set up FIRST so every subsequent step (including
    // workspace-lock acquisition) can emit structured logs. Filter
    // defaults to info; users override via RUST_LOG or
    // BIOCLAW_LOG_FILTER.
    logging::init(args.log_filter.as_deref());

    let result = match args
        .command
        .unwrap_or(cli::Command::Serve(Default::default()))
    {
        cli::Command::Serve(opts) => server::serve(opts).await,
        cli::Command::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        cli::Command::Env(env_cmd) => match env_cmd {
            cli::EnvCommand::Doctor => {
                // Placeholder — port from sidecar/src/env/state.ts in
                // a follow-up sub-stage.
                println!("env doctor not yet implemented");
                Ok(())
            }
            cli::EnvCommand::Setup(_) => {
                println!("env setup not yet implemented");
                Ok(())
            }
        },
    };

    if let Err(ref e) = result {
        error!("sidecar exiting with error: {e:#}");
    }
    result
}
