#[tauri::command]
pub fn update_tray_menu(
    app: tauri::AppHandle,
    show_text: String,
    quit_text: String,
) -> Result<(), String> {
    crate::plugins::system_tray::update_tray_menu(&app, &show_text, &quit_text)
}

/// Quits the app from the tray menu, the way the native menu's "Quit" did.
///
/// `update_tray_menu` cannot do this: the popup window has no menu items the
/// Rust side can listen for, so the tray menu's own actions live in the
/// frontend and reach Rust through the command layer.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
