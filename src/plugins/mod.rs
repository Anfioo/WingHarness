//! The app's own tray: the native tray icon and, on Windows, its themed
//! right-click menu.
//!
//! Not to be confused with Tauri plugins (the `tauri-plugin-*` crates), which
//! are Rust dependencies compiled into the app. These two modules are the
//! template's tray feature.

pub mod system_tray;
/// Windows only: the tray's themed right-click menu. Everywhere else the
/// native menu is the platform-correct form — see the module docs.
#[cfg(target_os = "windows")]
pub mod tray_popup;
