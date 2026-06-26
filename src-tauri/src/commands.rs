//! Typed Tauri commands callable from JS via `invoke('command_name', ...)`.
//! Keep these small and side-effect-poor — anything that touches the
//! filesystem or network should go through a Tauri plugin (so capabilities
//! gate it) rather than a raw command here.

use tauri::{AppHandle, Manager, Runtime, State};

use crate::sidecar::{SidecarState, SidecarStatus};

/// Return the current app version string from Cargo.toml. The front-end uses
/// this to render the build number in the settings drawer.
#[tauri::command]
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Open a path in the host file manager (Finder / Explorer / xdg). Used by
/// the settings drawer's "Reveal log directory" button (phase 2).
#[tauri::command]
pub async fn reveal_in_finder<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(&path, None)
        .map_err(|e| format!("shell.open failed: {e}"))
}

/// Open an HTTPS URL in the user's default browser. The web UI uses this
/// for any link that should NOT load inside the BioClaw chrome (e.g. the
/// pricing page, third-party docs).
#[tauri::command]
pub async fn open_external_url<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("URL must be http(s)://".into());
    }
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(url.as_str(), None)
        .map_err(|e| format!("shell.open failed: {e}"))
}

/// Quit the application cleanly. Settings drawer "Quit BioClaw" entry.
#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}

// --- credentials ----------------------------------------------------------
//
// Thin async wrappers around the synchronous `crate::credentials` helpers.
// We mark them `async` so they're queued onto Tauri's async executor and
// don't block the UI event loop while the underlying keyring backend (which
// may dispatch a dbus call on Linux or a Keychain prompt on macOS) is
// resolving. None of these commands return secret material in their error
// strings — only the requested account name.

use crate::credentials;

#[tauri::command]
pub async fn save_credential(account: String, value: String) -> Result<(), String> {
    credentials::save_credential(&account, &value)
}

#[tauri::command]
pub async fn get_credential(account: String) -> Result<Option<String>, String> {
    credentials::get_credential(&account)
}

#[tauri::command]
pub async fn delete_credential(account: String) -> Result<(), String> {
    credentials::delete_credential(&account)
}

#[tauri::command]
pub async fn list_credential_keys() -> Result<Vec<String>, String> {
    credentials::list_credential_keys()
}

// --- sidecar lifecycle ----------------------------------------------------
//
// These three commands are the only path the renderer has to start, stop,
// and inspect the local Node-based LLM sidecar. The sidecar is NOT auto-
// started — the user opts in by toggling "local mode" in settings, at which
// point the renderer calls `start_sidecar` and uses the returned port to
// build the `http://127.0.0.1:<port>/chat` URL for direct fetch calls.
//
// Capabilities note: we don't need an extra Tauri permission to call these
// commands — they're plain `#[tauri::command]` handlers gated by the allow-
// list in capabilities/default.json (see the `core:default` permission +
// the explicit command name entries we add there).

#[tauri::command]
pub async fn start_sidecar<R: Runtime>(
    state: State<'_, SidecarState>,
    app_handle: AppHandle<R>,
) -> Result<u16, String> {
    state.start(&app_handle).await
}

#[tauri::command]
pub async fn stop_sidecar<R: Runtime>(
    state: State<'_, SidecarState>,
    _app_handle: AppHandle<R>,
) -> Result<(), String> {
    state.stop().await
}

#[tauri::command]
pub async fn sidecar_status(
    state: State<'_, SidecarState>,
) -> Result<SidecarStatus, String> {
    Ok(state.status().await)
}
