//! Env state machine — single source of truth for the bundled-Python
//! lifecycle.
//!
//! Three kinds of state coexist (mirroring the Node sidecar):
//! 1. Disk facts (synchronous) — does the project dir exist, is
//!    the venv populated, was the bundle source extracted?
//! 2. In-flight install — the auto-setup task that fires on
//!    `serve` start when a bundled zip exists. Held in a
//!    Mutex-guarded module-level state struct so the /env/state
//!    handler can report progress without an extra IPC mechanism.
//! 3. Composite — `read_env_state` merges the two; if an install
//!    is in progress we report `installing` regardless of disk,
//!    so the inline banner shows the right label.
//!
//! Persistence: the install bookkeeping is in-memory only — same as
//! the Node port. On sidecar restart the FS state is the truth.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;

use super::paths;

/// Coarse state for the frontend's decision tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvStatus {
    Unknown,
    NeedsSetup,
    Installing,
    Ready,
    Broken,
}

/// What the /env/state handler returns. JSON shape preserved 1:1
/// with the Node sidecar (`src/env/state.ts::EnvState`) so the
/// frontend reads it unchanged.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvState {
    pub status: EnvStatus,
    pub project_dir: PathBuf,
    pub python_path: Option<PathBuf>,
    pub project_initialized: bool,
    pub bundled_source_dir: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// Synchronous disk-side facts only. Used by both the public
/// `read_env_state` and by the install driver's "should I bail
/// because already-ready?" check.
#[derive(Debug, Clone)]
pub struct DiskFacts {
    pub project_dir: PathBuf,
    pub bundled_source_dir: Option<PathBuf>,
    pub project_initialized: bool,
    pub python_path: Option<PathBuf>,
    pub venv_ok: bool,
}

pub fn read_disk_state(
    project_dir: &std::path::Path,
    resource_dir: Option<&std::path::Path>,
) -> DiskFacts {
    let bundled_source_dir = paths::bundled_env_source_dir(resource_dir);
    let pyproject = project_dir.join("pyproject.toml");
    let lock = project_dir.join("uv.lock");
    let py_version = project_dir.join(".python-version");
    let project_initialized = pyproject.exists() && lock.exists() && py_version.exists();

    let py = paths::venv_python(project_dir);
    let venv_ok = py.exists();

    DiskFacts {
        project_dir: project_dir.to_path_buf(),
        bundled_source_dir,
        project_initialized,
        python_path: if venv_ok { Some(py) } else { None },
        venv_ok,
    }
}

// ── in-flight install bookkeeping ───────────────────────────────────

#[derive(Debug, Clone, Default)]
struct CurrentInstall {
    phase: String,
    last_error: Option<String>,
    done_at: Option<std::time::Instant>,
}

static CURRENT_INSTALL: Mutex<Option<CurrentInstall>> = Mutex::new(None);

pub fn begin_install(initial_phase: &str) {
    let mut g = CURRENT_INSTALL.lock().expect("install mutex poisoned");
    *g = Some(CurrentInstall {
        phase: initial_phase.to_string(),
        last_error: None,
        done_at: None,
    });
}

pub fn set_install_phase(phase: &str) {
    let mut g = CURRENT_INSTALL.lock().expect("install mutex poisoned");
    if let Some(ref mut c) = *g {
        c.phase = phase.to_string();
    }
}

pub fn fail_install(message: &str) {
    let mut g = CURRENT_INSTALL.lock().expect("install mutex poisoned");
    if let Some(ref mut c) = *g {
        c.last_error = Some(message.to_string());
        c.done_at = Some(std::time::Instant::now());
    }
}

pub fn complete_install() {
    let mut g = CURRENT_INSTALL.lock().expect("install mutex poisoned");
    if let Some(ref mut c) = *g {
        c.done_at = Some(std::time::Instant::now());
    }
}

pub fn clear_install() {
    let mut g = CURRENT_INSTALL.lock().expect("install mutex poisoned");
    *g = None;
}

pub fn is_installing() -> bool {
    let g = CURRENT_INSTALL.lock().expect("install mutex poisoned");
    matches!(*g, Some(ref c) if c.done_at.is_none())
}

// ── composite read ──────────────────────────────────────────────────

pub fn read_env_state(
    project_dir: &std::path::Path,
    resource_dir: Option<&std::path::Path>,
) -> EnvState {
    let disk = read_disk_state(project_dir, resource_dir);
    let (install_phase, last_error) = {
        let g = CURRENT_INSTALL.lock().expect("install mutex poisoned");
        match *g {
            Some(ref c) => (Some(c.phase.clone()), c.last_error.clone()),
            None => (None, None),
        }
    };

    // venv_ok is the truth for Ready. If no venv yet, NeedsSetup
    // covers both "fresh install" and "project files seeded but venv
    // not synced". The Unknown branch is unreachable in practice but
    // kept as a defensive default.
    let status = if is_installing() {
        EnvStatus::Installing
    } else if disk.venv_ok {
        EnvStatus::Ready
    } else {
        EnvStatus::NeedsSetup
    };

    EnvState {
        status,
        project_dir: disk.project_dir,
        python_path: disk.python_path,
        project_initialized: disk.project_initialized,
        bundled_source_dir: disk.bundled_source_dir,
        install_phase,
        last_error,
    }
}

/// Interpreter to use for `run_skill_script`. Returns None when no
/// venv exists — caller falls back to `python3` on PATH (matches
/// Phase-4 behaviour).
#[allow(dead_code)] // wired up in L.6 with run_skill_script
pub fn preferred_interpreter(project_dir: &std::path::Path) -> Option<PathBuf> {
    let disk = read_disk_state(project_dir, None);
    if disk.venv_ok {
        disk.python_path
    } else {
        None
    }
}
