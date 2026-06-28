//! CLI surface — clap derives. Matches OmicOS's `omicos serve` /
//! `omicos env setup` / `omicos doctor` shape so the operational
//! patterns (and any future docs we share with users) translate 1:1.

use clap::{Args, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "bioclaw-sidecar",
    version,
    about = "BioClaw Desktop local HTTP sidecar",
    long_about = None,
)]
pub struct Cli {
    /// Tracing filter directive. Equivalent to setting `RUST_LOG=...`
    /// before launch, but lets us override from the Tauri shell
    /// without exporting an env var. e.g. `info,bioclaw_sidecar=debug`.
    #[arg(long, env = "BIOCLAW_LOG_FILTER", global = true)]
    pub log_filter: Option<String>,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Run the HTTP server (default — what the Tauri shell invokes).
    Serve(ServeOptions),

    /// Manage the bundled Python analysis environment.
    #[command(subcommand)]
    Env(EnvCommand),

    /// Print the sidecar binary version and exit.
    Version,
}

#[derive(Args, Debug, Default)]
pub struct ServeOptions {
    /// Host to bind to. Default 127.0.0.1 — never bind to a public
    /// interface; the Tauri shell talks loopback only.
    #[arg(long, env = "BIOCLAW_HOST", default_value = "127.0.0.1")]
    pub host: String,

    /// Port to bind. 0 (default) means OS-assigned and we print the
    /// chosen port to stdout for the Tauri supervisor to read.
    #[arg(long, env = "BIOCLAW_PORT", default_value_t = 0)]
    pub port: u16,

    /// Directory containing read-only bundled resources (skills,
    /// bioclaw-env.zip, etc.). Tauri passes this via
    /// BIOCLAW_RESOURCE_DIR; for `bioclaw serve` outside Tauri we
    /// fall back to looking next to the binary.
    #[arg(long, env = "BIOCLAW_RESOURCE_DIR")]
    pub resource_dir: Option<std::path::PathBuf>,

    /// Override the project dir (~/.bioclaw/env by default). Tests
    /// and CI use this to isolate from a real user install.
    #[arg(long, env = "BIOCLAW_ENV_DIR")]
    pub env_dir: Option<std::path::PathBuf>,

    /// Optional workspace key. Different keys get separate workspace
    /// locks, so two Tauri windows pointed at different projects can
    /// coexist. Defaults to "default".
    #[arg(long, env = "BIOCLAW_WORKSPACE", default_value = "default")]
    pub workspace: String,
}

#[derive(Subcommand, Debug)]
pub enum EnvCommand {
    /// Install (or repair) the bundled kernel environment into
    /// ~/.bioclaw/env via `uv sync --offline` against the bundled
    /// wheel cache.
    Setup(EnvSetupOptions),

    /// Report which Python the kernel would use and whether it works.
    Doctor,
}

#[derive(Args, Debug, Default)]
pub struct EnvSetupOptions {
    /// Don't prompt for confirmation; assume yes.
    #[arg(short = 'y', long, default_value_t = false)]
    pub yes: bool,

    /// Re-sync even if a working env already exists.
    #[arg(long, default_value_t = false)]
    pub force: bool,

    /// Optional uv extras to add, comma-separated. e.g.
    /// `--extras scientific,phylo`. Matches the SetupWizard UI from
    /// Stage I.
    #[arg(long, value_delimiter = ',')]
    pub extras: Vec<String>,
}
