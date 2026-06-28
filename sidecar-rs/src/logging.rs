//! `tracing` initialisation.
//!
//! Mirrors OmicOS's behaviour: default to `info` so the user doesn't
//! see request-level noise in the Tauri shell's stderr buffer; allow
//! override via `RUST_LOG` / `BIOCLAW_LOG_FILTER` / `--log-filter`.
//! Output goes to stderr because stdout is reserved for the
//! `PORT=NNNN` / `READY` lines the Tauri supervisor reads.

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

pub fn init(cli_filter: Option<&str>) {
    // Precedence:
    //   1. --log-filter / BIOCLAW_LOG_FILTER (explicit)
    //   2. RUST_LOG  (cargo convention)
    //   3. baked-in default
    let filter = if let Some(f) = cli_filter {
        EnvFilter::new(f)
    } else if std::env::var("RUST_LOG").is_ok() {
        EnvFilter::from_default_env()
    } else {
        EnvFilter::new("info,bioclaw_sidecar=info,tower_http=warn,hyper=warn")
    };

    let fmt_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(false)
        .with_writer(std::io::stderr)
        .with_ansi(supports_color());

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt_layer)
        .init();
}

/// Heuristic: enable ANSI escapes only if stderr is a real terminal.
/// Tauri's externalBin captures stderr to a pipe, where ANSI codes
/// would render as garbage; a terminal `bioclaw serve` invocation
/// still gets colour.
fn supports_color() -> bool {
    use std::io::IsTerminal;
    std::io::stderr().is_terminal()
}
