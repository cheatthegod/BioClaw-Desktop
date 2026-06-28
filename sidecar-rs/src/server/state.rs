//! Shared application state held by the axum router.
//!
//! Kept intentionally small at this scaffolding stage — currently
//! just the resolved paths. Later sub-stages will add:
//!   * `SkillCatalog` (load from the resource dir)
//!   * `PermissionStore` (persistent allow-once decisions)
//!   * `Auth` (process_token + cookie cache)
//!   * `Http` (reqwest::Client for the chat proxy)

use std::path::PathBuf;

use anyhow::Result;
use directories::ProjectDirs;

use crate::cli::ServeOptions;

#[derive(Debug, Clone)]
pub struct AppState {
    pub version: &'static str,
    pub workspace: String,
    /// Populated for later sub-stages (env routes, run_skill_script).
    /// Suppress dead-code warning until those routes land.
    #[allow(dead_code)]
    pub project_dir: PathBuf,
    #[allow(dead_code)]
    pub resource_dir: Option<PathBuf>,
}

impl AppState {
    pub fn new(opts: &ServeOptions) -> Result<Self> {
        let project_dir = match &opts.env_dir {
            Some(p) => p.clone(),
            None => default_project_dir()?,
        };
        Ok(AppState {
            version: env!("CARGO_PKG_VERSION"),
            workspace: opts.workspace.clone(),
            project_dir,
            resource_dir: opts.resource_dir.clone(),
        })
    }
}

/// Mirrors sidecar/src/env/paths.ts::defaultProjectDir for parity:
/// `~/.bioclaw/env` on POSIX, `%LOCALAPPDATA%\BioClaw\env` on Windows.
fn default_project_dir() -> Result<PathBuf> {
    // Try the env-var override first so tests / power users can pin
    // a different location without reconfiguring.
    if let Ok(v) = std::env::var("BIOCLAW_ENV_DIR") {
        if !v.is_empty() {
            return Ok(PathBuf::from(v));
        }
    }
    // Otherwise: ~/.bioclaw/env (linux/mac) or
    // %LOCALAPPDATA%\BioClaw\env (windows). We don't use ProjectDirs's
    // canonical `data_local_dir` here because the Node sidecar
    // historically used `~/.bioclaw` on every OS — preserving that
    // layout means existing users' envs don't move.
    if cfg!(target_os = "windows") {
        let dirs = ProjectDirs::from("tech", "bioclaw", "BioClaw")
            .ok_or_else(|| anyhow::anyhow!("no per-user data dir"))?;
        Ok(dirs.data_local_dir().join("env"))
    } else {
        let home =
            std::env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("HOME unset"))?;
        let mut p = PathBuf::from(home);
        p.push(".bioclaw");
        p.push("env");
        Ok(p)
    }
}
