pub mod ccs;
mod commands;
pub mod config;
mod invoke;
pub mod logging;
mod mcphub;
mod plugins;
pub mod proc;
pub mod projects;
mod shaic;
mod sidebar;
mod theme;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .setup(|app| {
            // Hand the std-only modules the real config directory, so they do
            // not have to guess at `%APPDATA%`. MCP Hub hangs its own files off
            // `config::dir()/.mcphub` on demand — no separate init.
            if let Ok(dir) = app.path().app_config_dir() {
                config::init(dir);
                // The proxy has to reach the environment before the first HTTP
                // client is built anywhere in the app, and before any child
                // process is spawned, so it is applied right after the config
                // directory is known.
                config::apply_proxy_env(&config::load().proxy);
                // The git engine keeps everything it persists — recent repos,
                // hosting accounts, and the window's own stores — under
                // `<data dir>/.git-repo`, next to `ccs/` and `.mcphub/`, so the
                // whole directory stays migratable. This must come after
                // `config::init`, which is what resolves the data directory.
                let _ = git_core::accounts::CONFIG_DIR.set(config::dir().join(".git-repo"));
                // The API client keeps its workspaces under
                // `<data dir>/.api-client`, resolved the same way and for the
                // same reason: everything the feature persists stays inside the
                // one directory that can be moved between machines.
                let _ = api_core::store::CONFIG_DIR.set(config::dir().join(".api-client"));
                // The SVN workspace keeps its recent-copies list and its
                // status snapshot cache under `<data dir>/.svn-workspace`, for
                // the same reason: one directory holds everything the feature
                // persists, and it can be moved between machines as a unit.
                let _ = svn_core::store::CONFIG_DIR.set(config::dir().join(".svn-workspace"));
                // Clash keeps its profiles, Prism patches and compiled output
                // in `<data dir>/clash` — the same folder the user drops
                // `mihomo.exe` into.
                let _ = prism_core::store::CONFIG_DIR.set(config::dir().join("clash"));
                let _ = prism_core::profiles::ensure_default();
                // The systools engine keeps its preferences (scan exclusions)
                // under `<data dir>/systools` — one directory that can move
                // between machines as a unit, like the features above.
                let _ = systools_core::paths::CONFIG_DIR.set(config::dir().join("systools"));
                // The server manager keeps its profiles and known-host records
                // under `<data dir>/server`; credentials go to the OS keychain
                // instead, so this directory is safe to copy between machines.
                let _ = server_core::paths::CONFIG_DIR.set(config::dir().join("server"));
                // The FRP console keeps `frp.json`, one generated `frpc.toml`
                // per profile, pid records and rolled logs under
                // `<data dir>/frp`, so the whole feature moves with the data
                // directory.
                let _ = frp_core::paths::CONFIG_DIR.set(config::dir().join("frp"));
                // The Markdown editor keeps `settings.json`, `recent.json` and
                // `session.json` under `<data dir>/md-editor`, so the whole
                // feature moves with the data directory.
                let _ = md_editor_core::paths::CONFIG_DIR.set(config::dir().join("md-editor"));
                // The ports page keeps `settings.json` under `<data dir>/ports`,
                // so the whole feature moves with the data directory.
                let _ = ports_core::paths::CONFIG_DIR.set(config::dir().join("ports"));
                // The database tools keep the data sources, the saved passwords
                // and the query history under `<data dir>/db`, so the whole
                // feature moves with the data directory. The app-wide manager
                // caches a project root for relative SQLite paths; the commands
                // refresh it per call, so a project window needs no restart. A
                // project scoped engine is built on demand under
                // `<project>/.wh/db` and kept per root; its saved passwords
                // still go in the app's `secrets.json`.
                let dir = config::dir().join("db");
                let db = commands::db::DbState::new(
                    db_core::DbManager::new(dir.clone()),
                    db_core::Workspace::new(dir.clone()),
                    dir.join("secrets.json"),
                );
                app.manage(db);
                // `frpc` children outlive an abnormal exit; reap the ones a
                // previous run recorded before this one can spawn new ones.
                frp_core::orphan::cleanup_startup();
            }
            // Registered unconditionally: the page must open (and say the data
            // directory is unavailable) rather than fail to resolve state.
            app.manage(prism_core::ClashState::new(app.handle().clone()));
            app.manage(server_core::ServerState::new(app.handle().clone()));
            app.manage(frp_core::FrpState::new(app.handle().clone()));
            // The identifier is not asserted against `config::IDENTIFIER`: dev
            // builds override it (see `src-tauri/tauri.dev.conf.json`) so they
            // can run next to an installed build.
            // 首次运行：补齐可见应用默认值，并把本机已有的 CLI 配置导入为
            // 供应商、补官方条目。
            ccs::settings::ensure_initialized();
            tauri::async_runtime::block_on(ccs::seed::init());
            Ok(())
        })
        .manage(commands::updater::UpdateDownloadState::default())
        .manage(commands::claude_chat::ClaudeRuns::default())
        .manage(mcphub::McpHubState::default())
        .manage(git_core::terminal::TerminalState::default())
        .manage(git_core::watcher::WatcherState::default())
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

    app.run(|app, event| {
        // A plugin started for the page it serves has no other owner: if it is
        // not stopped here it keeps running, and keeps the port it holds, long
        // after the window is gone.
        if let tauri::RunEvent::Exit = event {
            plugins::registry::stop_all_running();
            // The Clash core is our child process: left alone it keeps the
            // proxy ports and the controller long after the window is gone.
            if let Some(clash) = app.try_state::<prism_core::ClashState>() {
                clash.shutdown();
            }
            // Gracefully shut down the MCP Hub gateway: abort the SSE accept
            // loop and kill any child MCP processes we spawned.
            let hub = app.state::<mcphub::McpHubState>();
            tauri::async_runtime::block_on(async move {
                hub.stop().await;
            });
            // SSH connections outlive their window: without this the app exits
            // with live sockets and keepalive tasks the OS has to reap.
            if let Some(servers) = app.try_state::<server_core::ServerState>() {
                tauri::async_runtime::block_on(servers.connections.close_all());
            }
            // `frpc` child processes hold the remote ports they were given:
            // leaving them running after the window is gone makes the next
            // start fail with "port already in use".
            if let Some(frp) = app.try_state::<frp_core::FrpState>() {
                frp.shutdown();
            }
            // Database pools hold sockets, and a manual-commit transaction is
            // still open on the server: close both before the process goes.
            if let Some(db) = app.try_state::<commands::db::DbState>() {
                tauri::async_runtime::block_on(db.shutdown());
            }
        }
    });
}
