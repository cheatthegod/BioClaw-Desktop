//! Typed Tauri commands callable from JS via `invoke('command_name', ...)`.
//! Keep these small and side-effect-poor — anything that touches the
//! filesystem or network should go through a Tauri plugin (so capabilities
//! gate it) rather than a raw command here.

use tauri::{AppHandle, Manager, Runtime};

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
