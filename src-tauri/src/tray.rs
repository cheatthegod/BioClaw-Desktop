//! System tray. Tauri 2 ships tray support behind the `tray-icon` Cargo
//! feature (enabled in Cargo.toml). We attach a minimal menu — Show / Quit —
//! and route left-click → focus main window.

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "Show BioClaw").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    TrayIconBuilder::with_id("bioclaw-tray")
        .menu(&menu)
        .tooltip("BioClaw")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            // Fallback: a 1x1 transparent RGBA pixel so the tray icon never
            // silently fails to register if the bundled icon is missing.
            // Real icons are wired via tauri.conf.json `bundle.icon`.
            // Using raw RGBA avoids requiring the `image-png` Cargo feature.
            tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1)
        }))
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => focus_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.unminimize();
    }
}
