mod commands;
pub mod config;
mod invoke;
mod fonts;
mod plugins;
mod theme;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|app| {
            // Hand the std-only modules the real config directory, so they do
            // not have to guess at `%APPDATA%`.
            if let Ok(dir) = app.path().app_config_dir() {
                config::init(dir);
            }
            // The preview backend is its own crate and knows nothing of the
            // config; hand it the one thing it needs. The provider resolves the
            // path per call, so a settings change is picked up without a restart.
            file_preview::provide_root(commands::project_fs::repo_root);
            // The identifier is not asserted against `config::IDENTIFIER`: dev
            // builds override it (see `src-tauri/tauri.dev.conf.json`) so they
            // can run next to an installed build.
            Ok(())
        })
        .manage(commands::updater::UpdateDownloadState::default())
        // The tray popup is show/hide-only and positioned on every open, so it
        // must not be tracked here: a run that exits while the menu is open
        // would save it as visible and pop it up on the next start.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_denylist(&["tray-menu"])
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
                let _ = window.show();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(plugins::system_tray::init());

    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let _builder = all_commands!(builder);
    let app = _builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_, _| {});
}
