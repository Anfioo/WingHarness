// Only the platforms that keep a native menu build one.
#[cfg(not(target_os = "windows"))]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Emitter, Manager, Runtime,
};

/// Label prefix of a plugin's own window. A window with this label is one the
/// plugins page may be showing as a greyed-out tab, so its destruction has to be
/// announced — see [`init`].
const PLUGIN_WINDOW_PREFIX: &str = "plugin-window-";

/// Emitted when a plugin's own window is destroyed. Payload: the plugin id.
///
/// The plugins page greys out a plugin's tab while that plugin's window is open,
/// and has no other reliable way to learn the window is gone: a webview torn
/// down natively does not always finish its own `pagehide` work, so the frontend
/// cannot announce the close itself. This comes from the window system, which
/// always knows.
const PLUGIN_WINDOW_CLOSED_EVENT: &str = "plugin-window-closed";

// Update tray menu with localized text
//
// Windows no longer has a native tray menu — right-clicks pop the themed popup
// window instead (`tray_popup`), and its labels come from the frontend's i18n.
// This stays for the platforms that still use the native menu.
pub fn update_tray_menu(app: &AppHandle, show_text: &str, quit_text: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Attaching a menu here would suppress the popup, so do nothing at all.
        let _ = (app, show_text, quit_text);
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let menu = Menu::with_id_and_items(
            app,
            "system-tray",
            &[
                &MenuItem::with_id(app, "show", show_text, true, None::<&str>)
                    .map_err(|e| e.to_string())?,
                &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
                &MenuItem::with_id(app, "quit", quit_text, true, None::<&str>)
                    .map_err(|e| e.to_string())?,
            ],
        )
        .map_err(|e| e.to_string())?;

        if let Some(tray) = app.tray_by_id("main-tray") {
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        }

        Ok(())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("system-tray")
        .setup(|app, _| {
            let builder = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("WingHarness")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            // Left click to show main window
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        #[cfg(target_os = "windows")]
                        TrayIconEvent::Click {
                            button: MouseButton::Right,
                            button_state: MouseButtonState::Up,
                            position,
                            rect,
                            ..
                        } => crate::plugins::tray_popup::on_tray_right_click(
                            tray.app_handle(),
                            &rect,
                            position,
                        ),
                        _ => {}
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                });

            // Windows draws its own themed menu instead; on the platforms that
            // keep the native one, this is what it shows.
            #[cfg(not(target_os = "windows"))]
            let builder = {
                let menu = Menu::with_id_and_items(
                    app,
                    "system-tray",
                    &[
                        &MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?,
                        &PredefinedMenuItem::separator(app)?,
                        &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
                    ],
                )?;
                builder.menu(&menu)
            };

            builder.build(app)?;
            Ok(())
        })
        .on_window_ready(move |window| {
            // A plugin's own window announces its destruction, so the plugins
            // page stops showing that plugin's tab as greyed out. Registered
            // for every label, since the window system — not the page — is what
            // reliably knows the window is gone.
            if let Some(encoded) = window.label().strip_prefix(PLUGIN_WINDOW_PREFIX) {
                // The label carries the encoded id; the frontend matches the
                // event payload against the real id, so decode it back.
                let id = crate::plugins::decode_label_id(encoded);
                let app = window.app_handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed = event {
                        let _ =
                            app.emit(PLUGIN_WINDOW_CLOSED_EVENT, serde_json::json!({ "id": id }));
                    }
                });
            }

            // Only the main window hides on close, so the app keeps living in
            // the tray. Every other window is a thing the user can close for
            // good — a settings pane, a plugin's page — and hiding one would
            // leave it alive but invisible, which for a plugin window also
            // means its tab stays greyed out forever.
            if window.label() != "main" {
                return;
            }

            let window_clone = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Hide window instead of exiting when close is requested
                    let _ = window_clone.hide();
                    api.prevent_close();
                }
            });
        })
        .build()
}
