// Only the platforms that keep a native menu build one.
#[cfg(not(target_os = "windows"))]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};


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
            // Only the main window hides on close, so the app keeps living in
            // the tray. Every other window — a settings pane, the tray menu —
            // is a thing the user can close for good, and hiding one would
            // leave it alive but invisible.
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
