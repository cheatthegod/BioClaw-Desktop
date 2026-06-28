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
use tracing::info;

use std::sync::Arc;

use crate::cli::ServeOptions;
use crate::permissions::PermissionStore;
use crate::skills::{self, SkillCatalog};

#[derive(Debug)]
pub struct AppState {
    pub version: &'static str,
    pub workspace: String,
    pub project_dir: PathBuf,
    pub resource_dir: Option<PathBuf>,
    /// Loaded once at boot, then served as an Arc-shared snapshot.
    pub skills: SkillCatalog,
    /// Pending + persistent permission decisions for the script-runner
    /// tool. Wrapped in Arc so handlers can clone it cheaply.
    pub permissions: Arc<PermissionStore>,
}

impl AppState {
    pub fn new(opts: &ServeOptions) -> Result<Self> {
        let project_dir = match &opts.env_dir {
            Some(p) => p.clone(),
            None => default_project_dir()?,
        };
        // Resolve skills dir: BIOCLAW_SKILLS_DIR env (set by Tauri),
        // else <resource_dir>/skills, else ./skills relative to cwd.
        let skills_dir = std::env::var("BIOCLAW_SKILLS_DIR")
            .ok()
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| opts.resource_dir.as_ref().map(|p| p.join("skills")))
            .or_else(skills::resolve_skills_dir);
        let catalog = skills::load(skills_dir.as_deref());
        info!(count = catalog.len(), "skill catalog loaded");

        let permissions = Arc::new(PermissionStore::from_project_dir(&project_dir));

        Ok(AppState {
            version: env!("CARGO_PKG_VERSION"),
            workspace: opts.workspace.clone(),
            project_dir,
            resource_dir: opts.resource_dir.clone(),
            skills: catalog,
            permissions,
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
        let home = std::env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("HOME unset"))?;
        let mut p = PathBuf::from(home);
        p.push(".bioclaw");
        p.push("env");
        Ok(p)
    }
}
