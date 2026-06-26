// Prevents an extra console window on Windows in release builds. Tauri's
// convention; the actual entry point lives in lib.rs so unit tests can
// import it without paying this cost.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bioclaw_desktop_lib::run();
}
