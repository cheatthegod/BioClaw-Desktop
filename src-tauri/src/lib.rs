// BioClaw Desktop — Tauri main.
//
// Phase 1 (this file): minimal shell — open the main window, wire plugins,
// expose a couple of typed commands the React side uses (open external URL,
// check app version). All chat behaviour lives in the loaded web UI for now.
//
// Phase 2 will add: agent-runner sidecar lifecycle, MCP client commands,
// secure-store backed credential commands. We keep the surface area small
// here so the security review for v0.1 is short.

use tauri::Manager;

mod commands;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
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
        ])
        .setup(|app| {
            tray::setup_tray(app.handle())?;
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running BioClaw Desktop");
}
