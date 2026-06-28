//! Cross-platform path resolution for the bundled Python env.
//!
//! Three layers (same as the Node port):
//! 1. Resource dir — read-only, ships in the installer. Tauri sets
//!    `BIOCLAW_RESOURCE_DIR`; `bioclaw-env.zip` + `bioclaw-env/`
//!    source files live under here.
//! 2. Project dir — writable, under the user's home. Defaults to
//!    `~/.bioclaw/env`; `--env-dir` / `BIOCLAW_ENV_DIR` overrides.
//! 3. uv data dir — uv's own cache + downloaded interpreters,
//!    shared across BioClaw versions. uv picks this itself unless
//!    we pin it via `UV_PYTHON_INSTALL_DIR` for the offline path.

use std::path::{Path, PathBuf};

/// Default project dir. Mirrors `sidecar/src/env/paths.ts::defaultProjectDir`
/// — POSIX uses `~/.bioclaw/env` (preserving the Node sidecar's layout
/// so existing users' envs don't move); Windows uses
/// `%LOCALAPPDATA%\BioClaw\env`.
pub fn default_project_dir() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("BIOCLAW_ENV_DIR") {
        if !v.is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    if cfg!(target_os = "windows") {
        let dirs = directories::ProjectDirs::from("tech", "bioclaw", "BioClaw")?;
        Some(dirs.data_local_dir().join("env"))
    } else {
        let home = std::env::var_os("HOME")?;
        let mut p = PathBuf::from(home);
        p.push(".bioclaw");
        p.push("env");
        Some(p)
    }
}

/// Per-platform venv interpreter path inside the project dir.
/// `.venv/Scripts/python.exe` on Windows, `.venv/bin/python` elsewhere.
pub fn venv_python(project_dir: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        project_dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        project_dir.join(".venv").join("bin").join("python")
    }
}

/// Bundled env source dir under resource_dir. Returns None when no
/// resource dir is configured.
pub fn bundled_env_source_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    resource_dir.map(|r| r.join("bioclaw-env"))
}

/// Pre-baked env zip — primary install path. Tauri ships it as a
/// bundle resource at `<resource_dir>/bioclaw-env.zip`.
pub fn bundled_env_zip(resource_dir: Option<&Path>) -> Option<PathBuf> {
    resource_dir.map(|r| r.join("bioclaw-env.zip"))
}

/// Name of the bundled uv binary (extension differs on Windows).
pub fn bundled_uv_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "uv.exe"
    } else {
        "uv"
    }
}
