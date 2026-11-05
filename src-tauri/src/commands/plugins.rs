//! Plugin management, driven by Settings → 插件.
//!
//! Installing and uninstalling touch the filesystem, so they hop to a blocking
//! thread; running a plugin spawns its script and streams the output back.

use serde_json::{Map, Value};
use tauri::ipc::Channel;

use crate::plugins::log;
use crate::plugins::probe;
use crate::plugins::registry::{self, PluginView};
use crate::plugins::runner::{self, OutputEvent, Started, STOP_TIMEOUT};

/// Every installed plugin, including folders whose manifest will not parse.
#[tauri::command]
pub fn plugins_list() -> Vec<PluginView> {
    registry::list()
}

/// Unpacks a dropped zip and registers the plugin inside it.
///
/// The plugin arrives disabled, so a stray drop cannot run anything. Progress
/// is streamed on `on_progress` as the archive is unpacked, so a large plugin
/// shows a moving bar instead of a frozen window.
#[tauri::command]
pub async fn plugins_install(
    zip: String,
    on_progress: Channel<registry::InstallProgress>,
) -> Result<PluginView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // The channel is throttled here rather than inside the unpack loop: a
        // plugin of many small files would otherwise spend more time sending
        // events than writing files. The final value is let through regardless,
        // so the bar always lands on 100%.
        let mut last = std::time::Instant::now();
        let mut on_progress = |progress: registry::InstallProgress| {
            let finished = progress.written >= progress.total;
            if finished || last.elapsed() >= PROGRESS_INTERVAL {
                last = std::time::Instant::now();
                let _ = on_progress.send(progress);
            }
        };
        registry::install(&zip, &mut on_progress)
    })
    .await
    .map_err(|error| format!("Install task failed: {error}"))?
}

/// Minimum gap between install-progress events.
///
/// The unpack loop can report far faster than the UI needs; capping the rate
/// keeps the channel from becoming the bottleneck. The loop also reports the
/// final value unconditionally, so the bar still lands on 100%.
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

#[tauri::command]
pub async fn plugins_uninstall(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || registry::uninstall(&id))
        .await
        .map_err(|error| format!("Uninstall task failed: {error}"))?
}

#[tauri::command]
pub fn plugins_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    registry::set_enabled(&id, enabled)
}

/// Writes the user's edits into one of a plugin's config files.
///
/// Only keys the manifest declares are touched; everything else in the file —
/// comments included — survives.
#[tauri::command]
pub async fn plugins_save_file_config(
    id: String,
    path: String,
    values: Map<String, Value>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || registry::save_file_config(&id, &path, values))
        .await
        .map_err(|error| format!("Save task failed: {error}"))?
}

/// Opens one of a plugin's config files in its default editor.
///
/// A relative source the plugin has not generated yet gets an empty file: the
/// folder is the plugin's own, and an empty starting point beats "not found".
/// An absolute one is only opened — the plugin creates it on its first run, and
/// an empty stand-in would be a file that run could not overwrite.
#[tauri::command]
pub async fn plugins_open_file(id: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || registry::open_file_config(&id, &path))
        .await
        .map_err(|error| format!("Open task failed: {error}"))?
}

/// Opens the durable log the app keeps of a plugin's runs.
///
/// The file is created when it is not there yet: the button is usually pressed
/// to see what went wrong, and "not found" would be a poor answer.
#[tauri::command]
pub async fn plugins_open_log(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Validated first, so a malformed id cannot become a file name.
        registry::dir_of(&id)?;
        let path = log::touch(&id)?;

        // `/select,` highlights the file in its folder, which beats opening a
        // `.log` with whatever program happens to claim the extension.
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Open task failed: {error}"))?
}

/// Opens a plugin's folder — or the plugins folder itself — in File Explorer.
///
/// The folder is created first: the button is usually pressed to put something
/// there, and Explorer refuses a path that does not exist yet.
#[tauri::command]
pub async fn plugins_open_dir(id: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = match id.as_deref() {
            Some(id) => registry::dir_of(id)?,
            None => registry::root(),
        };

        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;

        // `explorer` opens the folder rather than highlighting it in its parent,
        // which "reveal in folder" would do.
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|error| format!("Failed to open {}: {error}", dir.display()))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Open task failed: {error}"))?
}

/// Runs one plugin, streaming its output.
///
/// Returns as soon as the script is started; progress arrives on `on_event` and
/// always ends with either `done` or `failed`.
#[tauri::command]
pub fn plugins_run(id: String, on_event: Channel<OutputEvent>) -> Result<(), String> {
    let (manifest, dir) = registry::resolve(&id)?;
    ensure_config_present(&id)?;
    runner::spawn(id, dir, manifest.entry, on_event);
    Ok(())
}

/// Starts a plugin in the background, for the page it serves.
///
/// Returns whether this call started it: `false` means a copy was already up,
/// which is the normal answer when the plugin page is opened a second time and
/// is not an error.
///
/// Nothing is streamed back. A plugin that serves a page has its own display
/// for whatever it wants to say, and a caller that had to keep a channel open
/// for the lifetime of a server would be waiting forever.
#[tauri::command]
pub fn plugins_start(id: String) -> Result<bool, String> {
    if !registry::is_enabled(&id) {
        return Err(format!("Plugin '{id}' is turned off."));
    }

    let (manifest, dir) = registry::resolve(&id)?;
    ensure_config_present(&id)?;

    match runner::start(&id, &dir, &manifest.entry)? {
        Started::Now => Ok(true),
        Started::AlreadyRunning => Ok(false),
    }
}

/// Refuses a start while a `startmust` file is missing.
///
/// `startmust: false` sources are left alone: a plugin generating its own file
/// on first boot is a normal pattern, not a missing configuration.
fn ensure_config_present(id: &str) -> Result<(), String> {
    let missing = registry::missing_config(id)?;
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Missing config: {} does not exist.",
        missing.join(", ")
    ))
}

/// Stops a plugin: its declared stop script, then whatever process the app holds.
///
/// Works on a plugin the app did not start — one left over from an earlier run,
/// or launched by hand — because the stop script is the manifest's, not the
/// process table's. Returns whether anything was done; an `Err` is the stop
/// script failing, reported after the process has been killed either way.
#[tauri::command]
pub async fn plugins_stop(id: String) -> Result<bool, String> {
    let (manifest, dir) = registry::resolve(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        runner::stop(&id, &dir, manifest.stop_script.as_deref(), STOP_TIMEOUT)
    })
    .await
    .map_err(|error| format!("Stop task failed: {error}"))?
}

/// Ids of the plugins the app currently has running.
#[tauri::command]
pub fn plugins_running() -> Vec<String> {
    runner::running()
}

/// Whether a plugin's page answers yet.
///
/// The page waits on this after starting a plugin, because a server needs a
/// moment before its socket accepts connections.
#[tauri::command]
pub async fn plugins_probe(url: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || probe::reachable(&url))
        .await
        .map_err(|error| format!("Probe task failed: {error}"))
}

/// Runs every enabled plugin in turn, streaming their combined output.
///
/// One plugin failing does not stop the rest: the run reports a non-zero code
/// at the end instead, so a single broken plugin cannot block the others.
#[tauri::command]
pub fn plugins_run_all(on_event: Channel<OutputEvent>) -> Result<(), String> {
    let plugins = registry::enabled();
    if plugins.is_empty() {
        return Err("No plugin is enabled.".to_string());
    }

    std::thread::spawn(move || {
        let mut failed = 0;

        for (manifest, dir) in plugins {
            let _ = on_event.send(OutputEvent::Line {
                stream: "stdout".to_string(),
                text: format!("=== {} ===", manifest.display_name()),
            });

            if let Err(message) = registry::missing_config(&manifest.id) {
                let _ = on_event.send(OutputEvent::Line {
                    stream: "stderr".to_string(),
                    text: message,
                });
                failed += 1;
                continue;
            }
            if let Err(message) = runner::run(&manifest.id, &dir, &manifest.entry, &on_event) {
                let _ = on_event.send(OutputEvent::Line {
                    stream: "stderr".to_string(),
                    text: message,
                });
                failed += 1;
            }
        }

        let _ = on_event.send(OutputEvent::Done {
            code: if failed == 0 { 0 } else { 1 },
        });
    });

    Ok(())
}
