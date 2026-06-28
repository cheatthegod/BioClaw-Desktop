//! Workspace daemon lock.
//!
//! OmicOS keeps a `.omicos/serve.pid` file with the pid of the running
//! daemon; a second `omicos serve` for the same workspace bails with
//! `is already running in this workspace (pid X)`. BioClaw needs the
//! same guarantee — without it, two desktop windows pointed at the
//! same env race on port allocation, OS keychain reads, and uv cache
//! mutations.
//!
//! Implementation: `fs2::FileExt::try_lock_exclusive` on a path under
//! the user's data dir. The lock is held for the lifetime of the
//! `WorkspaceLock` value; dropping it (sidecar exit) releases the
//! lock via the kernel, even if we panic. Stale pid files from a
//! crashed process are auto-reclaimed because the OS lock dies with
//! the holder process.

use std::fs::{File, OpenOptions};
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use directories::ProjectDirs;
use fs2::FileExt;
use tracing::{debug, info};

/// Open handle on the workspace lock file. Holds the kernel-side
/// flock; releasing it requires dropping this value.
pub struct WorkspaceLock {
    path: PathBuf,
    // Keep the File alive — its Drop releases the lock and closes
    // the descriptor.
    _file: File,
}

impl WorkspaceLock {
    /// Acquire the lock for the given workspace key. The key
    /// distinguishes coexisting Tauri windows (e.g. different
    /// projects) — different keys get different lock files. Returns
    /// an error if a sibling sidecar already holds the lock.
    pub fn acquire(workspace: &str) -> Result<Self> {
        let lock_path = lock_path(workspace)?;
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create lock dir {}", parent.display()))?;
        }

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .with_context(|| format!("failed to open lock file {}", lock_path.display()))?;

        match file.try_lock_exclusive() {
            Ok(_) => {
                // Re-truncate + write our pid for human inspection.
                // The OS-level lock is what enforces uniqueness; the
                // pid is purely informational so `ps -p $(cat ...)`
                // helps a user identify which BioClaw instance owns
                // the workspace.
                use std::io::{Seek, SeekFrom, Write};
                let mut f = &file;
                let _ = f.set_len(0);
                let _ = f.seek(SeekFrom::Start(0));
                let _ = writeln!(f, "{}", std::process::id());
                info!(
                    path = %lock_path.display(),
                    workspace,
                    pid = std::process::id(),
                    "workspace lock acquired"
                );
                Ok(WorkspaceLock {
                    path: lock_path,
                    _file: file,
                })
            }
            Err(_) => {
                // The lock is held by another process. Best-effort
                // read of the stale pid for the user-facing error.
                let other_pid = std::fs::read_to_string(&lock_path)
                    .ok()
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|| "unknown".into());
                Err(anyhow!(
                    "BioClaw is already running for workspace {workspace:?} (pid {other_pid}). \
                     Close the other instance first, or pass --workspace <name> to use a separate \
                     workspace."
                ))
            }
        }
    }

    /// Path to the lock file — exposed for tests / diagnostics.
    #[allow(dead_code)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        // The kernel releases the flock when the File handle drops;
        // explicit unlock is belt-and-braces in case fs2 ever adds a
        // shutdown hook.
        debug!(path = %self.path.display(), "releasing workspace lock");
        let _ = fs2::FileExt::unlock(&self._file);
    }
}

fn lock_path(workspace: &str) -> Result<PathBuf> {
    let dirs = ProjectDirs::from("tech", "bioclaw", "BioClaw")
        .ok_or_else(|| anyhow!("could not resolve a per-user data dir"))?;
    let mut p = dirs.data_local_dir().to_path_buf();
    p.push("locks");
    // Path-safe: workspaces are user-controlled, so replace anything
    // that isn't alphanumeric or `-`/`_` to defend against `../`
    // traversal.
    let safe: String = workspace
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    p.push(format!("workspace-{safe}.lock"));
    Ok(p)
}
