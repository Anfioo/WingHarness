//! Installed plugins: the Scoop apps that carry a `plugin.json`.
//!
//! The app does not install a plugin. A plugin is a Scoop app, added from a
//! bucket, and `scoop install` / `scoop update` / `scoop uninstall` are its
//! whole lifecycle. Nothing here reimplements that: the filesystem is the record
//! of what is installed, so an install registry has nothing to drift against.
//!
//! Two things do stay the app's own, both under `config::dir()`:
//!
//! ```text
//! plugins.json        the enabled flag of each installed plugin
//! logs/plugins/       one durable run log per plugin
//! ```
//!
//! Configuration values are neither. They live in Scoop's **persist folder**,
//! `<scoop>/persist/<app>`, because an app's `current` folder is replaced
//! wholesale on every update — anything the user had typed into it would be
//! gone. The persist folder is also what `scoop uninstall` keeps, so settings
//! survive a reinstall.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::config_files::{self, ConfigFileView};
use super::manifest::{self, PluginManifest};
use super::runner::{self, OutputEvent};
use crate::commands::scoop;
use crate::config::strip_bom;
use crate::proc::{forward, NoWindow, Stream};

/// Folder the app used to unpack zips into, before plugins became Scoop apps.
/// Read only to point an old install at its replacement.
const LEGACY_DIR_NAME: &str = "plugins";
/// State file, a sibling of `config.json`.
const STATE_FILE: &str = "plugins.json";
/// The budget each plugin's stop script gets while the app is quitting.
const EXIT_TIMEOUT: Duration = Duration::from_secs(10);
/// A Scoop run that produces no output for this long is treated as stuck.
///
/// Installing is bounded by the download rather than by a fixed budget, so the
/// watchdog watches silence: a run that keeps reporting is left alone, and one
/// that hangs is killed instead of holding the button forever.
const SCOOP_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// A plugin as the settings page needs it: the manifest, plus its own state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub entry: String,
    /// Script the app runs when stopping, when the plugin declares one. Shown so
    /// the UI can say how stopping works, and `null` for a plain tree kill.
    pub stop_script: Option<String>,
    /// Address of the plugin's page, with `{key}` already filled in from the
    /// config files. `None` when the plugin declares no interface — or declares
    /// one that cannot be completed, which is reported as a broken plugin instead.
    pub ui: Option<String>,
    /// Where the plugin lives on disk, so the UI can offer to open it.
    pub dir: String,
    pub enabled: bool,
    /// The plugin's declared config files, one block each in the config window.
    pub files: Vec<ConfigFileView>,
    /// Set when the folder holds no readable manifest. The plugin is still
    /// listed, so the reason is visible instead of the plugin silently missing.
    pub error: Option<String>,
}

/// One installed plugin: its manifest, the app's `current` folder, and the
/// persist folder its config files live in.
pub struct Installed {
    pub manifest: PluginManifest,
    pub dir: PathBuf,
    pub persist: PathBuf,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct State {
    #[serde(default)]
    plugins: BTreeMap<String, PluginState>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct PluginState {
    /// Off until the user turns it on: installing a plugin must not run code.
    #[serde(default)]
    enabled: bool,
}

/// `<scoop>/apps`, or `None` when Scoop has not been installed yet.
fn apps_root() -> Option<PathBuf> {
    scoop::apps_dir().ok().filter(|path| path.is_dir())
}

/// The folder holding every installed app, for the settings page's "open
/// plugins folder" button.
pub fn root() -> Result<PathBuf, String> {
    scoop::apps_dir()
}

/// One app's `current` folder, with the name validated so it cannot point
/// elsewhere.
pub fn dir_of(id: &str) -> Result<PathBuf, String> {
    manifest::validate_id(id)?;
    Ok(scoop::apps_dir()?.join(id).join("current"))
}

/// One app's persist folder: where its config files live, and what survives an
/// update or an uninstall.
pub fn persist_of(id: &str) -> Result<PathBuf, String> {
    manifest::validate_id(id)?;
    Ok(scoop::persist_dir()?.join(id))
}

/// Every installed plugin, sorted by id.
///
/// A plugin is an installed app whose `current` folder carries a `plugin.json`;
/// every other app in Scoop is simply not ours and does not appear. Never fails:
/// a plugin whose manifest will not parse is reported through
/// [`PluginView::error`] rather than dropped.
pub fn list() -> Vec<PluginView> {
    let state = load_state();
    let mut views = Vec::new();

    if let Some(apps) = apps_root() {
        if let Ok(entries) = fs::read_dir(&apps) {
            // The persist folder is a sibling of `apps`.
            let persist_root = apps.parent().map(|root| root.join("persist"));

            for entry in entries.flatten() {
                let Ok(name) = entry.file_name().into_string() else {
                    continue;
                };
                // A stray folder whose name cannot be an app name is not ours.
                if manifest::validate_id(&name).is_err() {
                    continue;
                }

                let dir = entry.path().join("current");
                if !dir.join(manifest::MANIFEST_FILE).is_file() {
                    continue;
                }

                let persist = match &persist_root {
                    Some(root) => root.join(&name),
                    None => entry.path(),
                };
                views.push(view_for(&name, &dir, &persist, &state));
            }
        }
    }

    views.extend(legacy_views(&state, &views));
    views.sort_by(|a, b| a.id.cmp(&b.id));
    views
}

/// One plugin's manifest, install folder and persist folder, read fresh from
/// disk.
pub fn resolve(id: &str) -> Result<Installed, String> {
    let dir = dir_of(id)?;
    if !dir.is_dir() {
        return Err(format!("Plugin '{id}' is not installed."));
    }

    Ok(Installed {
        manifest: manifest::read(&dir, id)?,
        dir,
        persist: persist_of(id)?,
    })
}

/// Every declared key across a plugin's config files, as the `{key}` lookup
/// for its `ui` address.
///
/// Sources are searched in declaration order and the first hit wins; values are
/// never merged, because the same key in two files is two different things.
fn key_values(manifest: &PluginManifest, persist: &Path) -> Map<String, Value> {
    let mut values = Map::new();

    for source in &manifest.config_files {
        for (key, value) in config_files::values_of(persist, source) {
            values.entry(key).or_insert(value);
        }
    }

    values
}

/// Enabled plugins with their folders, in a stable order.
pub fn enabled() -> Vec<Installed> {
    let state = load_state();
    let mut plugins: Vec<Installed> = state
        .plugins
        .iter()
        .filter(|(_, plugin)| plugin.enabled)
        .filter_map(|(id, _)| resolve(id).ok())
        .collect();

    plugins.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    plugins
}

/// Installs `app` from the added buckets and registers it as a plugin.
///
/// The install itself is Scoop's: this runs `scoop install <app>` and streams
/// what it prints, then reads the `plugin.json` the app brought. An app without
/// one installed fine — it is just not a plugin, and saying so beats a card that
/// never appears.
///
/// The plugin arrives **disabled**: installing must not run code.
pub fn install(app: &str, on_event: &mut dyn FnMut(OutputEvent)) -> Result<PluginView, String> {
    manifest::validate_id(app)?;
    if !manifest::is_plugin_app(app) {
        return Err(format!(
            "'{app}' is not a WingHarness plugin: plugins are Scoop apps named '{}<name>'.",
            manifest::PLUGIN_PREFIX
        ));
    }
    let dir = dir_of(app)?;
    if dir.join(manifest::MANIFEST_FILE).is_file() {
        return Err(format!("'{app}' is already installed."));
    }

    run_scoop("install", app, on_event)?;

    manifest::read(&dir, app).map_err(|error| {
        format!(
            "'{app}' is installed, but it is not a plugin: {error} Plugins are Scoop apps named '{}<name>' with a plugin.json at the root.",
            manifest::PLUGIN_PREFIX
        )
    })?;

    let persist = persist_of(app)?;
    fs::create_dir_all(&persist)
        .map_err(|error| format!("Failed to create {}: {error}", persist.display()))?;

    let mut state = load_state();
    // An existing record keeps its flag, so reinstalling does not quietly turn a
    // plugin the user had switched off back on.
    state.plugins.entry(app.to_string()).or_default();
    save_state(&state)?;

    Ok(view_for(app, &dir, &persist, &state))
}

/// Updates one plugin to the version its bucket now names.
pub fn update(id: &str, on_event: &mut dyn FnMut(OutputEvent)) -> Result<(), String> {
    if !dir_of(id)?.is_dir() {
        return Err(format!("Plugin '{id}' is not installed."));
    }
    run_scoop("update", id, on_event)
}

/// Uninstalls a plugin through Scoop and drops the state stored about it.
///
/// The persist folder is left alone: it holds the user's settings, and Scoop's
/// own uninstall keeps it for exactly that reason.
pub fn uninstall(id: &str, on_event: &mut dyn FnMut(OutputEvent)) -> Result<(), String> {
    manifest::validate_id(id)?;

    // A running plugin holds the files Scoop is about to remove.
    if let Ok(installed) = resolve(id) {
        let _ = runner::stop(
            id,
            &installed.dir,
            &installed.persist,
            installed.manifest.stop_script.as_deref(),
            EXIT_TIMEOUT,
        );
    }

    let app = scoop::apps_dir()?.join(id);
    if app.is_dir() {
        run_scoop("uninstall", id, on_event)?;
    } else {
        // A copy the old zip installer left behind: its folder was the whole
        // install, so removing it is the uninstall.
        let legacy = crate::config::dir().join(LEGACY_DIR_NAME).join(id);
        if legacy.is_dir() {
            fs::remove_dir_all(&legacy)
                .map_err(|error| format!("Failed to remove {}: {error}", legacy.display()))?;
        }
    }

    let mut state = load_state();
    state.plugins.remove(id);
    save_state(&state)
}

/// Runs `<subcommand> <app>` through the same generated script the Scoop page
/// uses, streaming its output to `on_event`.
///
/// Captured rather than shown in a terminal: installing a plugin is one step of
/// work the settings page drives, not a shell session.
fn run_scoop(
    subcommand: &str,
    app: &str,
    on_event: &mut dyn FnMut(OutputEvent),
) -> Result<(), String> {
    let prepared = scoop::prepare_scoop_command(subcommand, app)?;

    let mut command = Command::new("cmd");
    command
        .arg("/C")
        .arg(&prepared.script)
        .creation_flags_no_window()
        // A prompt nobody can answer must not hang the run.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for var in &prepared.env {
        command.env(&var.name, &var.value);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start scoop: {error}"))?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");

    let (sender, receiver) = mpsc::channel();
    forward(stdout, Stream::Stdout, sender.clone());
    forward(stderr, Stream::Stderr, sender.clone());
    // Drop our own handle so the loop ends once both readers hit EOF.
    drop(sender);

    loop {
        match receiver.recv_timeout(SCOOP_IDLE_TIMEOUT) {
            Ok((stream, text)) => on_event(OutputEvent::Line {
                stream: stream_name(stream).to_string(),
                text,
            }),
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let pid = child.id();
                let _ = crate::proc::kill_tree_of(pid);
                let _ = child.wait();
                return Err(format!(
                    "scoop {subcommand} {app} stopped responding and was killed."
                ));
            }
        }
    }

    let code = child
        .wait()
        .map(|status| status.code().unwrap_or(-1))
        .unwrap_or(-1);
    if code == 0 {
        Ok(())
    } else {
        Err(format!("scoop {subcommand} {app} exited with code {code}."))
    }
}

fn stream_name(stream: Stream) -> &'static str {
    match stream {
        Stream::Stdout => "stdout",
        Stream::Stderr => "stderr",
    }
}

/// Turns a plugin on or off. Nothing else about it changes.
pub fn set_enabled(id: &str, enabled: bool) -> Result<(), String> {
    manifest::validate_id(id)?;
    let mut state = load_state();
    state.plugins.entry(id.to_string()).or_default().enabled = enabled;
    save_state(&state)
}

/// The config source `path` names, which the manifest must declare.
///
/// Matching on the declared path is what keeps a write limited to the keys and
/// the file the manifest lists — a caller cannot aim one at a path of its own.
fn declared_source<'a>(
    manifest: &'a PluginManifest,
    id: &str,
    path: &str,
) -> Result<&'a manifest::ConfigFileSource, String> {
    manifest
        .config_files
        .iter()
        .find(|source| source.path == path)
        .ok_or_else(|| format!("Plugin '{id}' declares no config file '{path}'."))
}

/// Writes the user's values into one of a plugin's config files.
pub fn save_file_config(id: &str, path: &str, values: Map<String, Value>) -> Result<(), String> {
    let installed = resolve(id)?;
    let source = declared_source(&installed.manifest, id, path)?;

    config_files::write(&installed.persist, source, &values)
}

/// The file behind a declared source, for the config window's "open" button.
///
/// A relative source is created when it is missing, because a plugin's settings
/// have to start somewhere and an empty file is a fine beginning for the editor
/// it is about to open in. An absolute one is only opened: it belongs to the
/// plugin, which writes it on its first run, and an empty stand-in would be a
/// file that run could not overwrite.
pub fn open_file_config(id: &str, path: &str) -> Result<(), String> {
    let installed = resolve(id)?;
    let source = declared_source(&installed.manifest, id, path)?;
    let target = config_files::resolve_for_open(&installed.persist, source)?;

    if !target.exists() {
        if source.absolute {
            return Err(format!(
                "{} does not exist yet; start the plugin once to create it.",
                target.display()
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        fs::write(&target, b"")
            .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
    }

    tauri_plugin_opener::open_path(target.to_string_lossy().to_string(), None::<String>)
        .map_err(|error| format!("Failed to open {}: {error}", target.display()))
}

/// Stops every plugin the app has running, on the way out.
///
/// Lives here rather than in `runner` because it needs each plugin's manifest —
/// the declared stop script is what ends an instance the app did not start, or
/// one whose helpers outlive the process tree. A plugin that cannot be resolved
/// any more (uninstalled while running) still gets its process killed.
///
/// Budgeted short: the user is waiting for the app to quit.
pub fn stop_all_running() {
    for id in runner::running() {
        match resolve(&id) {
            Ok(installed) => {
                // Failures are already logged; at exit there is nobody to tell.
                let _ = runner::stop(
                    &id,
                    &installed.dir,
                    &installed.persist,
                    installed.manifest.stop_script.as_deref(),
                    EXIT_TIMEOUT,
                );
            }
            Err(_) => {
                let _ = runner::stop(&id, Path::new("."), Path::new("."), None, EXIT_TIMEOUT);
            }
        }
    }
}

/// A plugin's page address, `{key}` already filled in — `None` when it declares
/// no page, or declares one that cannot be completed.
pub fn ui_of(id: &str) -> Result<Option<String>, String> {
    let installed = resolve(id)?;
    Ok(resolve_ui(&installed.manifest, &installed.persist))
}

/// The `startmust` files a plugin is missing, if any. Empty means it may start.
pub fn missing_config(id: &str) -> Result<Vec<String>, String> {
    let installed = resolve(id)?;
    Ok(installed
        .manifest
        .config_files
        .iter()
        .filter(|source| source.startmust)
        .filter_map(|source| {
            config_files::missing_required(&installed.persist, std::slice::from_ref(source))
        })
        .collect())
}

fn view_for(id: &str, dir: &Path, persist: &Path, state: &State) -> PluginView {
    let stored = state.plugins.get(id).cloned().unwrap_or_default();

    match manifest::read(dir, id) {
        Ok(manifest) => {
            // A declared-but-unfillable UI is a broken manifest, not a plugin
            // without one: reporting it as `error` beats a tab that silently
            // points nowhere.
            let ui = match resolve_ui(&manifest, persist) {
                Some(address) => Some(address),
                None if manifest.ui.trim().is_empty() => None,
                None => {
                    return PluginView {
                        id: id.to_string(),
                        name: manifest.display_name(),
                        version: manifest.version.clone(),
                        description: manifest.description.clone(),
                        entry: manifest.entry.clone(),
                        stop_script: manifest.stop_script.clone(),
                        ui: None,
                        dir: dir.display().to_string(),
                        enabled: stored.enabled,
                        files: Vec::new(),
                        error: Some(
                            "The ui address has a {key} that no config field fills.".to_string(),
                        ),
                    };
                }
            };

            let files = manifest
                .config_files
                .iter()
                .map(|source| config_files::view(persist, source))
                .collect();

            PluginView {
                id: id.to_string(),
                name: manifest.display_name(),
                version: manifest.version.clone(),
                description: manifest.description.clone(),
                entry: manifest.entry.clone(),
                stop_script: manifest.stop_script.clone(),
                ui,
                dir: dir.display().to_string(),
                enabled: stored.enabled,
                files,
                error: None,
            }
        }
        Err(error) => PluginView {
            id: id.to_string(),
            name: id.to_string(),
            version: String::new(),
            description: String::new(),
            entry: String::new(),
            stop_script: None,
            ui: None,
            dir: dir.display().to_string(),
            enabled: false,
            files: Vec::new(),
            error: Some(error),
        },
    }
}

/// Why an old zip install is listed: it is still on disk, but Scoop does not
/// know about it, so nothing can update or remove it.
const LEGACY_ERROR: &str =
    "Installed by the old zip installer. Install it from the Scoop bucket, then remove this copy.";

/// Plugins installed by the old zip installer, marked so their owner knows to
/// replace them.
///
/// They are not migrated: a folder dropped into the data directory is an app
/// Scoop never installed, so `scoop update` and `scoop uninstall` would both fail
/// on it. Showing the folder with the reason is the useful thing.
fn legacy_views(state: &State, known: &[PluginView]) -> Vec<PluginView> {
    let root = crate::config::dir().join(LEGACY_DIR_NAME);
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let id = entry.file_name().to_str()?.to_string();
            if manifest::validate_id(&id).is_err() || known.iter().any(|view| view.id == id) {
                return None;
            }

            let manifest = manifest::read(&entry.path(), &id).ok();
            let stored = state.plugins.get(&id).cloned().unwrap_or_default();

            Some(PluginView {
                id: id.clone(),
                name: manifest
                    .as_ref()
                    .map(PluginManifest::display_name)
                    .unwrap_or_else(|| id.clone()),
                version: manifest
                    .as_ref()
                    .map(|manifest| manifest.version.clone())
                    .unwrap_or_default(),
                description: manifest
                    .as_ref()
                    .map(|manifest| manifest.description.clone())
                    .unwrap_or_default(),
                entry: manifest
                    .as_ref()
                    .map(|manifest| manifest.entry.clone())
                    .unwrap_or_default(),
                stop_script: manifest
                    .as_ref()
                    .and_then(|manifest| manifest.stop_script.clone()),
                ui: None,
                dir: entry.path().display().to_string(),
                enabled: stored.enabled,
                files: Vec::new(),
                error: Some(LEGACY_ERROR.to_string()),
            })
        })
        .collect()
}

/// Fills `{key}` in the manifest's ui address from the plugin's config files.
///
/// Returns `None` when the address cannot be completed: an unclosed brace, or a
/// placeholder naming a key no config field declares. Half-substituted addresses
/// are refused rather than returned, because `http://127.0.0.1:{port}/` would
/// otherwise be handed to the webview as a host named `{port}`.
fn resolve_ui(manifest: &PluginManifest, persist: &Path) -> Option<String> {
    let template = manifest.ui.trim();
    if template.is_empty() {
        return None;
    }

    let values = key_values(manifest, persist);
    let mut out = String::new();
    let mut rest = template;

    while let Some(start) = rest.find('{') {
        let end = rest[start..].find('}').map(|offset| start + offset)?;
        let Some(value) = values.get(&rest[start + 1..end]) else {
            return None;
        };
        let Some(text) = scalar_text(value) else {
            return None;
        };

        out.push_str(&rest[..start]);
        out.push_str(&text);
        rest = &rest[end + 1..];
    }

    out.push_str(rest);
    Some(out)
}

/// A value written into a URL. Everything without a single-line form is
/// unusable there, which is what the `None` reports.
fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Null => Some(String::new()),
        Value::Array(_) | Value::Object(_) => None,
    }
}

/// Whether one plugin is turned on.
pub fn is_enabled(id: &str) -> bool {
    load_state()
        .plugins
        .get(id)
        .map(|plugin| plugin.enabled)
        .unwrap_or(false)
}

fn load_state() -> State {
    fs::read(state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(strip_bom(&bytes)).ok())
        .unwrap_or_default()
}

fn state_path() -> PathBuf {
    crate::config::dir().join(STATE_FILE)
}

/// Persists the state atomically, the same way `config::save` does: a crash
/// mid-write must not cost the user every plugin's settings.
fn save_state(state: &State) -> Result<(), String> {
    let dir = crate::config::dir();
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;

    let json = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("Failed to serialize plugin state: {error}"))?;

    let target = state_path();
    let temp = target.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&temp)
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        file.write_all(&json)
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("Failed to flush {}: {error}", temp.display()))?;
    }

    fs::rename(&temp, &target)
        .map_err(|error| format!("Failed to replace {}: {error}", target.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(key: &str, default: Value) -> manifest::ConfigField {
        manifest::ConfigField {
            key: key.to_string(),
            label: key.to_string(),
            field_type: manifest::FieldType::String,
            default,
            hint: None,
            options: Vec::new(),
            true_value: None,
            min: None,
            max: None,
        }
    }

    fn manifest_with(ui: &str, config_files: Vec<manifest::ConfigFileSource>) -> PluginManifest {
        PluginManifest {
            id: "a".to_string(),
            name: String::new(),
            version: String::new(),
            description: String::new(),
            entry: "run.cmd".to_string(),
            stop_script: None,
            ui: ui.to_string(),
            config_files,
        }
    }

    fn env_source(path: &str, fields: Vec<manifest::ConfigField>) -> manifest::ConfigFileSource {
        manifest::ConfigFileSource {
            file_type: manifest::ConfigFileType::Env,
            path: path.to_string(),
            absolute: false,
            startmust: false,
            fields,
        }
    }

    /// A persist folder of its own, so these tests can write config files.
    fn persist_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("plugin-registry-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_placeholder_in_the_ui_takes_the_value_from_a_config_file() {
        let dir = persist_dir("ui-env");
        std::fs::write(dir.join(".env"), "PORT=11212\n").unwrap();

        let manifest = manifest_with(
            "http://127.0.0.1:{PORT}/",
            vec![env_source(
                ".env",
                vec![field("PORT", serde_json::json!(0))],
            )],
        );

        assert_eq!(
            resolve_ui(&manifest, &dir).as_deref(),
            Some("http://127.0.0.1:11212/")
        );
    }

    #[test]
    fn a_placeholder_in_the_path_segment_resolves_like_any_other() {
        // A key may sit anywhere in the address — a path segment is no different
        // from the host or port position.
        let dir = persist_dir("ui-path-segment");
        std::fs::write(
            dir.join(".env"),
            "WEB_HOST=127.0.0.1\nWEB_PORT=7864\nWEB_TITLE=demo\n",
        )
        .unwrap();

        let manifest = manifest_with(
            "http://{WEB_HOST}:{WEB_PORT}/abc/{WEB_TITLE}",
            vec![env_source(
                ".env",
                vec![
                    field("WEB_HOST", serde_json::json!("")),
                    field("WEB_PORT", serde_json::json!(0)),
                    field("WEB_TITLE", serde_json::json!("")),
                ],
            )],
        );

        assert_eq!(
            resolve_ui(&manifest, &dir).as_deref(),
            Some("http://127.0.0.1:7864/abc/demo")
        );
    }

    #[test]
    fn a_ui_can_use_several_placeholders_or_none() {
        let dir = persist_dir("ui-plain");
        let plain = manifest_with("http://127.0.0.1:11212/", Vec::new());
        assert_eq!(
            resolve_ui(&plain, &dir).as_deref(),
            Some("http://127.0.0.1:11212/")
        );

        std::fs::write(dir.join(".env"), "HOST=127.0.0.1\nPORT=8080\n").unwrap();
        let two = manifest_with(
            "http://{HOST}:{PORT}/app",
            vec![env_source(
                ".env",
                vec![
                    field("HOST", serde_json::json!("")),
                    field("PORT", serde_json::json!(0)),
                ],
            )],
        );
        assert_eq!(
            resolve_ui(&two, &dir).as_deref(),
            Some("http://127.0.0.1:8080/app")
        );
    }

    #[test]
    fn a_missing_file_falls_back_to_the_declared_default() {
        // The reference plugin has no `.env` until its first boot, yet its ui
        // still has to resolve — from the defaults.
        let dir = persist_dir("ui-default");

        let manifest = manifest_with(
            "http://{WB_MANAGER_HOST}:{WB_MANAGER_PORT}/",
            vec![env_source(
                ".env",
                vec![
                    field("WB_MANAGER_HOST", serde_json::json!("127.0.0.1")),
                    field("WB_MANAGER_PORT", serde_json::json!(7864)),
                ],
            )],
        );

        assert_eq!(
            resolve_ui(&manifest, &dir).as_deref(),
            Some("http://127.0.0.1:7864/")
        );
    }

    #[test]
    fn a_ui_that_cannot_be_completed_has_none() {
        let dir = persist_dir("ui-broken");
        let manifest = manifest_with("http://127.0.0.1:{port}/", Vec::new());
        // No field declares `port`, so the address can never be finished.
        assert!(resolve_ui(&manifest, &dir).is_none());

        let unclosed = manifest_with("http://127.0.0.1:{port/", Vec::new());
        assert!(resolve_ui(&unclosed, &dir).is_none());

        // A plugin with no interface is not an error, just nothing to show.
        assert!(resolve_ui(&manifest_with("  ", Vec::new()), &dir).is_none());
    }

    #[test]
    fn state_round_trips_through_json() {
        let mut state = State::default();
        state.plugins.entry("a".to_string()).or_default().enabled = true;

        let json = serde_json::to_string(&state).unwrap();
        let parsed: State = serde_json::from_str(&json).unwrap();
        assert!(parsed.plugins["a"].enabled);
    }

    /// The legacy state file carried per-plugin config values; it must still
    /// load, simply ignoring them.
    #[test]
    fn state_from_the_legacy_format_still_loads() {
        let parsed: State =
            serde_json::from_str(r#"{"plugins":{"a":{"enabled":true,"config":{"x":1}}}}"#).unwrap();
        assert!(parsed.plugins["a"].enabled);
    }

    #[test]
    fn a_missing_state_file_reads_as_empty() {
        // The default must be usable without any file having been written.
        let state = State::default();
        assert!(state.plugins.is_empty());
        assert!(state.plugins.get("nothing").is_none());
    }

    #[test]
    fn ids_that_are_not_plain_app_names_are_refused() {
        assert!(manifest::validate_id("../evil").is_err());
        assert!(manifest::validate_id("a/b").is_err());
        assert!(manifest::validate_id("ok-id").is_ok());
    }
}
