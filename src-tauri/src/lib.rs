// BioClaw Desktop — Tauri main.
//
// Phase 1 (this file): minimal shell — open the main window, wire plugins,
// expose a couple of typed commands the React side uses (open external URL,
// check app version). All chat behaviour lives in the loaded web UI for now.
//
// Phase 2 will add: agent-runner sidecar lifecycle, MCP client commands,
// secure-store backed credential commands. We keep the surface area small
// here so the security review for v0.1 is short.

use tauri::{Emitter, Manager};

mod commands;
mod credentials;
mod sidecar;
mod tray;

use crate::sidecar::SidecarState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is needed under #[cfg(not(debug_assertions))] below; the
    // dev build never executes that branch so clippy sees it as
    // unused. Suppress the warning so `cargo clippy -D warnings`
    // passes in both profiles.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build());

    // Tauri 2 ships the updater plugin separately; only register it in
    // release builds so local `tauri dev` doesn't try to hit the update
    // endpoint and warn on every reload.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::reveal_in_finder,
            commands::open_external_url,
            commands::quit_app,
            commands::save_credential,
            commands::get_credential,
            commands::delete_credential,
            commands::list_credential_keys,
            commands::start_sidecar,
            commands::stop_sidecar,
            commands::sidecar_status,
        ])
        .setup(|app| {
            // Phase-2 default is CLOUD mode (chat.bioclaw.tech in webview);
            // the sidecar starts on demand when the user toggles to local
            // mode in settings via `invoke('start_sidecar')`. We register
            // empty state so the command handlers have a State<SidecarState>
            // to grab from app.state(). Do NOT spawn the child here.
            app.manage(SidecarState::new());
            tray::setup_tray(app.handle())?;
            setup_deep_links(app.handle());
            // Temporary: auto-open the WebView2 console in this preview so the
            // sidecar-connectivity error (CSP / PNA / mixed-content) is visible
            // without needing a debug build. Remove once confirmed fixed.
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Best-effort graceful shutdown of the sidecar on close. We
                // run blocking inside a tokio runtime block_on so the close
                // is synchronous from Tauri's POV (otherwise the process can
                // exit before we send /shutdown, leaving an orphan node).
                let app = window.app_handle().clone();
                let state = app.state::<SidecarState>();
                // We hold a clone of the Arc<Mutex<Inner>> indirectly via
                // SidecarState; stop() awaits internally.
                tauri::async_runtime::block_on(async {
                    let _ = state.stop().await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running BioClaw Desktop");
}

/// M3.3 deep links: handle `bioclaw://…` URLs (e.g. an auth callback or a
/// share link). On Linux/Windows the runtime registration makes the dev build
/// resolvable; the production scheme is registered by the bundler from
/// tauri.conf.json `plugins.deep-link`. When a URL arrives we focus the main
/// window and forward it to the webview as a `deep-link` event so the React
/// side can route it. Best-effort: failures are logged, never fatal.
fn setup_deep_links(app: &tauri::AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;

    // Register schemes at runtime so dev builds resolve `bioclaw://` without a
    // reinstall (no-op / harmless error if the OS lacks per-user registration).
    if let Err(e) = app.deep_link().register_all() {
        log::warn!("deep-link register_all failed (non-fatal): {e}");
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
        log::info!("deep link opened: {urls:?}");
        if let Some(win) = handle.get_webview_window("main") {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
            let _ = win.emit("deep-link", urls);
        }
    });
}
