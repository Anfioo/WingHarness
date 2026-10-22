//! Opening a window's WebView inspector.

/// Opens the developer tools for the calling window.
///
/// The JavaScript API has no equivalent — `@tauri-apps/api`'s `webview` module
/// exposes no devtools call — so the window context menu's "Developer tools"
/// item reaches the inspector through this command. Debug builds have it; a
/// release build needs the `devtools` feature.
#[cfg(any(debug_assertions, feature = "devtools"))]
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// A build that cannot show an inspector still has to answer the call, so the
/// command exists in both forms. The menu item that reaches it is dev-only.
#[cfg(not(any(debug_assertions, feature = "devtools")))]
#[tauri::command]
pub fn open_devtools() -> Result<(), String> {
    Err("DevTools are not available in this build.".into())
}