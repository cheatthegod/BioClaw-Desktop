//! Credential storage backed by the OS keychain.
//!
//! Backend selection is handled by the `keyring` crate at compile time:
//!   - macOS   → Keychain Services
//!   - Windows → Credential Manager
//!   - Linux   → Secret Service (gnome-keyring / kwallet, dbus)
//!
//! All values are stored under the single service `BIOCLAW_SERVICE`. The
//! `account` argument is the logical key name (e.g. `openrouter_api_key`).
//!
//! ## Enumeration caveat (Linux)
//!
//! The `keyring` crate intentionally does NOT expose a portable "list all
//! entries for a service" API — Windows Credential Manager and macOS
//! Keychain expose this, but Secret Service does not in a reliable way that
//! survives session locks / collection swaps. We work around it by
//! maintaining a small JSON index of "which account names we've stored" at
//! `$APPCONFIG/credential-keys.json`. The index holds ONLY key names; the
//! secret material itself never leaves the keychain.
//!
//! The index is best-effort — if it gets out of sync (user manually wipes
//! their keyring, restores a backup, etc.) the UI may show a "stored" badge
//! for a key that no longer exists. `get_credential` returns `Ok(None)` in
//! that case rather than an error, and the index self-heals on the next
//! save / delete.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use keyring::Entry;

/// Service name used for every keyring entry this app creates. Matches the
/// Tauri bundle identifier so the entries are easy to spot in Keychain
/// Access / `secret-tool search`.
pub const BIOCLAW_SERVICE: &str = "tech.bioclaw.desktop";

/// Filename for the Linux key-index fallback. Lives under `$APPCONFIG`.
const INDEX_FILE: &str = "credential-keys.json";

/// In-process mutex around the index file so concurrent Tauri commands don't
/// race on read-modify-write. The keyring crate itself is thread-safe.
static INDEX_LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();

fn index_lock() -> &'static Mutex<()> {
    INDEX_LOCK.get_or_init(|| Mutex::new(()))
}

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(BIOCLAW_SERVICE, account)
        .map_err(|e| format!("keyring: failed to open entry for {account}: {e}"))
}

/// Persist `value` under the given `account` in the OS keychain. Overwrites
/// any existing value silently — callers that need a confirmation prompt
/// should handle that in the UI.
pub fn save_credential(account: &str, value: &str) -> Result<(), String> {
    validate_account(account)?;
    let e = entry(account)?;
    e.set_password(value)
        .map_err(|err| format!("keyring: set_password failed for {account}: {err}"))?;
    add_to_index(account)?;
    Ok(())
}

/// Look up a credential. Returns `Ok(None)` if the entry doesn't exist
/// (distinct from `Err` for "the keychain is broken").
pub fn get_credential(account: &str) -> Result<Option<String>, String> {
    validate_account(account)?;
    let e = entry(account)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("keyring: get_password failed for {account}: {err}")),
    }
}

/// Remove a credential. Removing a missing entry is treated as success
/// (idempotent) so the UI "delete" flow doesn't need to special-case it.
pub fn delete_credential(account: &str) -> Result<(), String> {
    validate_account(account)?;
    let e = entry(account)?;
    match e.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(err) => {
            return Err(format!(
                "keyring: delete_credential failed for {account}: {err}"
            ));
        }
    }
    remove_from_index(account)?;
    Ok(())
}

/// List the names of credentials we believe are stored. The result is
/// derived from the JSON index file (see module docs). On macOS / Windows
/// the index is just a convenient cache; on Linux it's the only reliable
/// source of truth.
pub fn list_credential_keys() -> Result<Vec<String>, String> {
    let path = index_path()?;
    let _guard = index_lock()
        .lock()
        .map_err(|e| format!("index lock: {e}"))?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed: BTreeSet<String> =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(parsed.into_iter().collect())
}

// --- internals -------------------------------------------------------------

/// Tighten the account name so it can never escape the keyring's namespacing
/// (e.g. by embedding null bytes that some backends choke on) and so we have
/// a tidy allowlist surface to audit later if needed.
fn validate_account(account: &str) -> Result<(), String> {
    if account.is_empty() || account.len() > 128 {
        return Err("account name must be 1..=128 chars".into());
    }
    if !account
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err("account name may only contain [A-Za-z0-9_.-]".into());
    }
    Ok(())
}

fn index_path() -> Result<PathBuf, String> {
    // We deliberately use `dirs::config_dir()` rather than going through
    // `tauri::api::path` here because this module is plain Rust (no `App`
    // handle in scope). The path resolves to the same `$APPCONFIG` Tauri
    // uses (XDG_CONFIG_HOME on Linux, ~/Library/Application Support on
    // macOS, %APPDATA% on Windows).
    let base = dirs::config_dir().ok_or_else(|| "no config dir".to_string())?;
    let dir = base.join(BIOCLAW_SERVICE);
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.join(INDEX_FILE))
}

fn add_to_index(account: &str) -> Result<(), String> {
    let path = index_path()?;
    let _guard = index_lock()
        .lock()
        .map_err(|e| format!("index lock: {e}"))?;
    let mut set: BTreeSet<String> = if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        BTreeSet::new()
    };
    set.insert(account.to_string());
    let raw = serde_json::to_string_pretty(&set).map_err(|e| format!("serialise index: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

fn remove_from_index(account: &str) -> Result<(), String> {
    let path = index_path()?;
    let _guard = index_lock()
        .lock()
        .map_err(|e| format!("index lock: {e}"))?;
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut set: BTreeSet<String> = serde_json::from_str(&raw).unwrap_or_default();
    set.remove(account);
    let out = serde_json::to_string_pretty(&set).map_err(|e| format!("serialise index: {e}"))?;
    fs::write(&path, out).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}
