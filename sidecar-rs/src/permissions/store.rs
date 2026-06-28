//! Permission store — pending requests + persistent allow-always cache.
//!
//! Thread-safe by virtue of DashMap + atomic file replacement. The
//! store is constructed once during AppState init and shared
//! Arc-wise into every handler that needs it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;
use tracing::{info, warn};

use super::types::{PermissionDecision, PermissionKey};

const PERMISSIONS_FILE: &str = "permissions.json";

#[derive(Debug)]
pub struct PermissionStore {
    /// In-flight `permission-needed` requests awaiting a /permissions/decide
    /// callback. Keyed by request-id (uuid v4 strings); the value is the
    /// oneshot sender the awaiting tool handler is parked on.
    pending: DashMap<String, oneshot::Sender<PermissionDecision>>,
    /// Persistent allow-always cache. Wrapped in Mutex<HashSet> rather
    /// than DashMap because we serialize the whole thing on write and
    /// the access pattern is read-heavy + bursty-write, so a single
    /// snapshot mutex is simpler than worrying about Hash impls in
    /// dashmap.
    allow_always: Mutex<HashSet<PermissionKey>>,
    /// Where to flush the cache. None for ephemeral / tests.
    storage_path: Option<PathBuf>,
}

impl PermissionStore {
    /// Construct an empty store with no persistence. Used in tests.
    pub fn empty() -> Self {
        Self {
            pending: DashMap::new(),
            allow_always: Mutex::new(HashSet::new()),
            storage_path: None,
        }
    }

    /// Construct from a project dir — loads the persisted allow-always
    /// list from `<project_dir>/permissions.json` if it exists.
    /// Missing file is fine (first-run). Malformed file is logged and
    /// treated as empty so the user isn't locked out.
    pub fn from_project_dir(project_dir: &Path) -> Self {
        let path = project_dir.join(PERMISSIONS_FILE);
        let allow_always = match read_disk(&path) {
            Ok(set) => {
                if !set.is_empty() {
                    info!(count = set.len(), path = %path.display(), "loaded persisted permissions");
                }
                set
            }
            Err(e) => {
                warn!(error = %e, path = %path.display(), "could not load permissions.json — starting empty");
                HashSet::new()
            }
        };
        Self {
            pending: DashMap::new(),
            allow_always: Mutex::new(allow_always),
            storage_path: Some(path),
        }
    }

    pub fn is_allow_always(&self, key: &PermissionKey) -> bool {
        self.allow_always
            .lock()
            .expect("allow_always poisoned")
            .contains(key)
    }

    /// Replace the allow-always cache wholesale. Called by
    /// /permissions/preload after the frontend has reconciled its
    /// persisted list (e.g. user revoked one via Settings). Atomically
    /// flushes the new set to disk.
    pub fn preload(&self, keys: Vec<PermissionKey>) -> Result<usize> {
        let n = keys.len();
        let set: HashSet<PermissionKey> = keys.into_iter().collect();
        *self.allow_always.lock().expect("allow_always poisoned") = set.clone();
        self.flush(&set)?;
        Ok(n)
    }

    /// Add a single allow-always decision (called when the user picks
    /// "Allow" in the modal). Flushes the updated cache to disk.
    pub fn remember(&self, key: PermissionKey) -> Result<()> {
        let snapshot = {
            let mut g = self.allow_always.lock().expect("allow_always poisoned");
            g.insert(key);
            g.clone()
        };
        self.flush(&snapshot)
    }

    fn flush(&self, set: &HashSet<PermissionKey>) -> Result<()> {
        let Some(path) = &self.storage_path else {
            return Ok(());
        };
        let mut sorted: Vec<&PermissionKey> = set.iter().collect();
        sorted.sort_by(|a, b| {
            (a.skill_id.as_str(), a.script.as_str()).cmp(&(b.skill_id.as_str(), b.script.as_str()))
        });
        let payload = DiskFormat {
            version: 1,
            permissions: sorted.iter().copied().cloned().collect(),
        };
        write_disk(path, &payload)
            .with_context(|| format!("flush permissions to {}", path.display()))
    }

    /// Register a pending request. Returns a Receiver the caller awaits;
    /// `/permissions/decide` resolves it.
    pub fn register_pending(&self, request_id: String) -> oneshot::Receiver<PermissionDecision> {
        let (tx, rx) = oneshot::channel();
        self.pending.insert(request_id, tx);
        rx
    }

    /// Resolve a pending request. Returns true if the request was
    /// pending; false if already resolved or unknown.
    pub fn resolve_pending(&self, request_id: &str, decision: PermissionDecision) -> bool {
        if let Some((_, tx)) = self.pending.remove(request_id) {
            // Send may fail if the receiver dropped (caller cancelled).
            tx.send(decision).is_ok()
        } else {
            false
        }
    }

    pub fn arc(self) -> Arc<Self> {
        Arc::new(self)
    }
}

// ── disk format ────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct DiskFormat {
    version: u32,
    permissions: Vec<PermissionKey>,
}

fn read_disk(path: &Path) -> Result<HashSet<PermissionKey>> {
    if !path.exists() {
        return Ok(HashSet::new());
    }
    let raw = std::fs::read_to_string(path)?;
    let parsed: DiskFormat = serde_json::from_str(&raw)?;
    if parsed.version != 1 {
        anyhow::bail!("unsupported permissions.json version: {}", parsed.version);
    }
    Ok(parsed.permissions.into_iter().collect())
}

fn write_disk(path: &Path, payload: &DiskFormat) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(payload)?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preload_roundtrips_through_disk() {
        let tmp = tempdir();
        let store = PermissionStore::from_project_dir(tmp.path());
        store
            .preload(vec![
                PermissionKey::new("uniprot", "scripts/get.py"),
                PermissionKey::new("alphafold", "scripts/run.py"),
            ])
            .unwrap();

        let reloaded = PermissionStore::from_project_dir(tmp.path());
        assert!(reloaded.is_allow_always(&PermissionKey::new("uniprot", "scripts/get.py")));
        assert!(reloaded.is_allow_always(&PermissionKey::new("alphafold", "scripts/run.py")));
        assert!(!reloaded.is_allow_always(&PermissionKey::new("uniprot", "scripts/other.py")));
    }

    #[test]
    fn remember_appends_then_persists() {
        let tmp = tempdir();
        let store = PermissionStore::from_project_dir(tmp.path());
        store.remember(PermissionKey::new("foo", "bar.py")).unwrap();
        let reloaded = PermissionStore::from_project_dir(tmp.path());
        assert!(reloaded.is_allow_always(&PermissionKey::new("foo", "bar.py")));
    }

    #[test]
    fn pending_resolve_unblocks_receiver() {
        let store = PermissionStore::empty();
        let rx = store.register_pending("req-1".into());
        assert!(store.resolve_pending("req-1", PermissionDecision::Allow));
        let decision = futures::executor::block_on(rx).unwrap();
        assert_eq!(decision, PermissionDecision::Allow);
    }

    #[test]
    fn resolve_unknown_request_is_a_noop() {
        let store = PermissionStore::empty();
        assert!(!store.resolve_pending("nope", PermissionDecision::Allow));
    }

    #[test]
    fn malformed_disk_falls_back_to_empty() {
        let tmp = tempdir();
        std::fs::write(tmp.path().join(PERMISSIONS_FILE), "not json").unwrap();
        let store = PermissionStore::from_project_dir(tmp.path());
        assert!(!store.is_allow_always(&PermissionKey::new("x", "y.py")));
    }

    /// Self-contained tempdir without pulling in the `tempfile` crate
    /// — we just want a unique scratch path under /tmp.
    fn tempdir() -> TempDir {
        let pid = std::process::id();
        let n = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("bioclaw-perm-test-{pid}-{n}"));
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }
    static TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
