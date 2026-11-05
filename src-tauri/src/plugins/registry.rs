//! Installed plugins: where they live, and the operations the settings page
//! drives.
//!
//! Layout, next to `config.json`:
//!
//! ```text
//! plugins/            one folder per plugin, exactly as the zip unpacked
//! plugins.json        the enabled flag of each installed plugin
//! ```
//!
//! Splitting the two is deliberate. `plugins/` is disposable — reinstalling a
//! plugin replaces the folder wholesale — while `plugins.json` holds the one
//! thing the user decided. Configuration values are **not** stored here: a
//! plugin's settings live in the plugin's own declared files, which the config
//! window reads and writes directly. The file is the truth, so there is nothing
//! for an upgrade to preserve beyond whether the plugin is on.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use zip::ZipArchive;

use super::config_files::{self, ConfigFileView};
use super::manifest::{self, PluginManifest};
use super::runner;
use crate::config::strip_bom;

/// Folder holding one directory per installed plugin.
const DIR_NAME: &str = "plugins";
/// State file, a sibling of `config.json`.
const STATE_FILE: &str = "plugins.json";
/// The budget each plugin's stop script gets while the app is quitting.
const EXIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// How far a plugin install has got, as the settings page shows it.
///
/// Progress is measured in **unpacked** bytes rather than the size of the zip:
/// the compressed size says nothing about how much writing is left, so a
/// percentage built from it would sit still and then jump.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    /// Bytes written so far across every file in the archive.
    pub written: u64,
    /// Total unpacked size, from the archive's central directory. Settled before
    /// any file is written, so it is a real denominator from the first event.
    pub total: u64,
}

/// Sends install progress to the caller.
///
/// `Channel::send` blocks on the webview, so the extract loop must not call this
/// per chunk: a plugin full of small files would spend its time talking to the
/// UI. The caller wraps the channel in a [`Throttle`] before passing it down.
pub type ProgressFn<'a> = &'a mut dyn FnMut(InstallProgress);

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

#[derive(Serialize, Deserialize, Default, Clone)]
struct State {
    #[serde(default)]
    plugins: BTreeMap<String, PluginState>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct PluginState {
    /// Off until the user turns it on: installing a zip must not run code.
    #[serde(default)]
    enabled: bool,
}

/// Folder holding every installed plugin.
pub fn root() -> PathBuf {
    crate::config::dir().join(DIR_NAME)
}

fn state_path() -> PathBuf {
    crate::config::dir().join(STATE_FILE)
}

/// Folder of one plugin, with the id validated so it cannot point elsewhere.
pub fn dir_of(id: &str) -> Result<PathBuf, String> {
    manifest::validate_id(id)?;
    Ok(root().join(id))
}

/// Every installed plugin, sorted by id. Never fails: a broken folder is
/// reported through [`PluginView::error`] rather than dropped.
pub fn list() -> Vec<PluginView> {
    let state = load_state();
    let Ok(entries) = fs::read_dir(root()) else {
        return Vec::new();
    };

    let mut views: Vec<PluginView> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let id = entry.file_name().to_str()?.to_string();
            // A stray folder whose name cannot be a plugin id is not ours.
            manifest::validate_id(&id).ok()?;
            Some(view_for(&id, &entry.path(), &state))
        })
        .collect();

    views.sort_by(|a, b| a.id.cmp(&b.id));
    views
}

/// One plugin's manifest and folder, read fresh from disk.
pub fn resolve(id: &str) -> Result<(PluginManifest, PathBuf), String> {
    let dir = dir_of(id)?;
    if !dir.is_dir() {
        return Err(format!("Plugin '{id}' is not installed."));
    }
    let manifest = manifest::read(&dir)?;
    Ok((manifest, dir))
}

/// Every declared key across a plugin's config files, as the `{key}` lookup
/// for its `ui` address.
///
/// Sources are searched in declaration order and the first hit wins; values are
/// never merged, because the same key in two files is two different things.
fn key_values(manifest: &PluginManifest, dir: &Path) -> Map<String, Value> {
    let mut values = Map::new();

    for source in &manifest.config_files {
        for (key, value) in config_files::values_of(dir, source) {
            values.entry(key).or_insert(value);
        }
    }

    values
}

/// Enabled plugins with their folders, in a stable order.
pub fn enabled() -> Vec<(PluginManifest, PathBuf)> {
    let state = load_state();
    let mut plugins = Vec::new();

    for (id, plugin) in &state.plugins {
        if !plugin.enabled {
            continue;
        }
        let dir = root().join(id);
        if let Ok(manifest) = manifest::read(&dir) {
            plugins.push((manifest, dir));
        }
    }

    plugins.sort_by(|a, b| a.0.id.cmp(&b.0.id));
    plugins
}

/// Unpacks `zip_path` and registers the plugin inside it.
///
/// Installing an already-installed id replaces the folder but keeps the stored
/// values, which is what makes re-dropping a zip an upgrade.
///
/// Progress is reported through `on_progress` as the archive is unpacked; the
/// caller throttles it (see [`ProgressFn`]).
pub fn install(zip_path: &str, on_progress: ProgressFn) -> Result<PluginView, String> {
    let path = Path::new(zip_path.trim());
    if !path.is_file() {
        return Err(format!("Not a file: {}", path.display()));
    }

    let file = fs::File::open(path)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Not a readable zip file: {error}"))?;

    // Read the manifest before touching disk, so a bad zip cannot leave a
    // half-written folder behind.
    let (manifest_index, prefix) = find_manifest(&mut archive)?;
    let manifest = read_manifest_entry(&mut archive, manifest_index)?;

    let target = dir_of(&manifest.id)?;
    let staging = root().join(format!(".{}.installing", manifest.id));

    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Failed to create {}: {error}", staging.display()))?;

    if let Err(error) = extract(&mut archive, &staging, prefix.as_deref(), on_progress) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    // The entry has to have arrived, or every run would fail later on.
    if !staging.join(&manifest.entry).is_file() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "The zip does not contain the declared entry '{}'.",
            manifest.entry
        ));
    }

    // Swap the extracted copy into place. `rename` cannot replace a non-empty
    // directory, so the previous copy goes first.
    let _ = fs::remove_dir_all(&target);
    fs::create_dir_all(root())
        .map_err(|error| format!("Failed to create {}: {error}", root().display()))?;
    fs::rename(&staging, &target)
        .map_err(|error| format!("Failed to install into {}: {error}", target.display()))?;

    let mut state = load_state();
    // `or_default` keeps an existing record, so an upgrade preserves both the
    // enabled flag and the values.
    state.plugins.entry(manifest.id.clone()).or_default();
    save_state(&state)?;

    Ok(view_for(&manifest.id, &target, &state))
}

/// Removes a plugin's folder and its stored state.
pub fn uninstall(id: &str) -> Result<(), String> {
    let dir = dir_of(id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|error| format!("Failed to remove {}: {error}", dir.display()))?;
    }

    let mut state = load_state();
    state.plugins.remove(id);
    save_state(&state)
}

/// Turns a plugin on or off. Nothing else about it changes.
pub fn set_enabled(id: &str, enabled: bool) -> Result<(), String> {
    dir_of(id)?;
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
    let (manifest, dir) = resolve(id)?;
    let source = declared_source(&manifest, &id, path)?;

    config_files::write(&dir, source, &values)
}

/// The file behind a declared source, for the config window's "open" button.
///
/// A relative source is created when it is missing, because the plugin owns its
/// own folder and an empty file is a fine starting point for the editor it is
/// about to open in. An absolute one is only opened: it belongs to the plugin,
/// which writes it on its first run, and an empty stand-in would be a file that
/// run could not overwrite.
pub fn open_file_config(id: &str, path: &str) -> Result<(), String> {
    let (manifest, dir) = resolve(id)?;
    let source = declared_source(&manifest, &id, path)?;
    let target = config_files::resolve_for_open(&dir, source)?;

    if !target.exists() {
        if source.absolute {
            return Err(format!(
                "{} does not exist yet; start the plugin once to create it.",
                target.display()
            ));
        }
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;
        std::fs::write(&target, b"")
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
            Ok((manifest, dir)) => {
                // Failures are already logged; at exit there is nobody to tell.
                let _ = runner::stop(&id, &dir, manifest.stop_script.as_deref(), EXIT_TIMEOUT);
            }
            Err(_) => {
                let _ = runner::stop(&id, Path::new("."), None, EXIT_TIMEOUT);
            }
        }
    }
}

/// A plugin's page address, `{key}` already filled in — `None` when it declares
/// no page, or declares one that cannot be completed.
pub fn ui_of(id: &str) -> Result<Option<String>, String> {
    let (manifest, dir) = resolve(id)?;
    Ok(resolve_ui(&manifest, &dir))
}

/// The `startmust` files a plugin is missing, if any. Empty means it may start.
pub fn missing_config(id: &str) -> Result<Vec<String>, String> {
    let (manifest, dir) = resolve(id)?;
    Ok(manifest
        .config_files
        .iter()
        .filter(|source| source.startmust)
        .filter_map(|source| config_files::missing_required(&dir, std::slice::from_ref(source)))
        .collect())
}

fn view_for(id: &str, dir: &Path, state: &State) -> PluginView {
    let stored = state.plugins.get(id).cloned().unwrap_or_default();

    match manifest::read(dir) {
        Ok(manifest) => {
            // A declared-but-unfillable UI is a broken manifest, not a plugin
            // without one: reporting it as `error` beats a tab that silently
            // points nowhere.
            let ui = match resolve_ui(&manifest, dir) {
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
                .map(|source| config_files::view(dir, source))
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

/// Fills `{key}` in the manifest's ui address from the plugin's config files.
///
/// Returns `None` when the address cannot be completed: an unclosed brace, or a
/// placeholder naming a key no config field declares. Half-substituted addresses
/// are refused rather than returned, because `http://127.0.0.1:{port}/` would
/// otherwise be handed to the webview as a host named `{port}`.
fn resolve_ui(manifest: &PluginManifest, dir: &Path) -> Option<String> {
    let template = manifest.ui.trim();
    if template.is_empty() {
        return None;
    }

    let values = key_values(manifest, dir);
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

/// Locates `plugin.json`, returning its entry index and the folder to strip
/// while extracting.
///
/// Windows' "Send to → Compressed folder" wraps everything in a folder named
/// after the selection, so the manifest is usually one level down. Both layouts
/// have to work, or half of what users zip would be rejected.
///
/// The index is returned rather than the name because archives written by
/// different tools disagree on the separator inside entry names — PowerShell's
/// `Compress-Archive` has historically written `folder\plugin.json`. Names are
/// normalized for the layout check, which would no longer match what
/// `ZipArchive::by_name` looks up.
fn find_manifest<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<(usize, Option<String>), String> {
    let mut nested: Option<(usize, Option<String>)> = None;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Damaged zip entry #{index}: {error}"))?;
        if entry.is_dir() {
            continue;
        }

        let name = entry.name().replace('\\', "/");
        if name == manifest::MANIFEST_FILE {
            return Ok((index, None));
        }

        // Exactly one level down: `folder/plugin.json`. Deeper is not a plugin.
        if let Some(folder) = name.strip_suffix(&format!("/{}", manifest::MANIFEST_FILE)) {
            if !folder.is_empty() && !folder.contains('/') && nested.is_none() {
                nested = Some((index, Some(folder.to_string())));
            }
        }
    }

    nested.ok_or_else(|| format!("No {} at the root of the zip.", manifest::MANIFEST_FILE))
}

fn read_manifest_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    index: usize,
) -> Result<PluginManifest, String> {
    let mut text = String::new();
    // Reading by index starts a fresh read from the central directory, so it is
    // safe to call after the scan above.
    archive
        .by_index(index)
        .map_err(|error| format!("Cannot read {}: {error}", manifest::MANIFEST_FILE))?
        .read_to_string(&mut text)
        .map_err(|error| format!("Cannot read {}: {error}", manifest::MANIFEST_FILE))?;

    let manifest: PluginManifest = serde_json::from_slice(strip_bom(text.as_bytes()))
        .map_err(|error| format!("Invalid {}: {error}", manifest::MANIFEST_FILE))?;
    manifest::validate(&manifest)?;
    Ok(manifest)
}

/// Unpacks the archive into `into`, dropping `prefix` from every path.
///
/// Reports progress in unpacked bytes as it goes. The total is summed from the
/// archive's central directory up front, so the first event already carries a
/// real denominator, and the loop reports the final value on the way out.
fn extract<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    into: &Path,
    prefix: Option<&str>,
    on_progress: ProgressFn,
) -> Result<(), String> {
    // Summed only as the progress denominator: there is no size limit on what a
    // plugin may unpack to. Bundled runtimes and their exes push a real plugin
    // well past any figure that would still be useful as a guard, so a limit
    // here would reject legitimate plugins far more often than it stopped an
    // attack — and the user is dropping their own zip, not a stranger's.
    let total = total_unpacked(archive, prefix)?;

    let mut written = 0u64;
    on_progress(InstallProgress { written, total });

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Damaged zip entry #{index}: {error}"))?;

        // `enclosed_name` rejects `..` and absolute paths. Without it a hostile
        // zip could write anywhere the app can reach.
        let Some(name) = entry.enclosed_name() else {
            return Err(format!(
                "Zip entry escapes the plugin folder: {}",
                entry.name()
            ));
        };

        let relative = match prefix {
            Some(prefix) => match name.strip_prefix(prefix) {
                Ok(stripped) => stripped.to_path_buf(),
                // A sibling of the folder the manifest lives in: not ours.
                Err(_) => continue,
            },
            None => name,
        };
        if relative.as_os_str().is_empty() {
            continue;
        }

        let out = into.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&out)
                .map_err(|error| format!("Failed to create {}: {error}", out.display()))?;
            continue;
        }

        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let mut file = fs::File::create(&out)
            .map_err(|error| format!("Failed to create {}: {error}", out.display()))?;

        // Copied in chunks rather than with `io::copy`, so a single large file
        // reports its own progress instead of jumping from nothing to done.
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|error| format!("Failed to unpack {}: {error}", out.display()))?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])
                .map_err(|error| format!("Failed to write {}: {error}", out.display()))?;
            written += read as u64;
            on_progress(InstallProgress { written, total });
        }
    }

    // The last per-chunk event may have been throttled away; make sure the
    // caller ends on the finished value.
    on_progress(InstallProgress { written, total });
    Ok(())
}

/// Total unpacked size of the entries [`extract`] would write.
///
/// Mirrors `extract`'s filtering — the same `enclosed_name` rejection and the
/// same `prefix` drop — so the number matches what is actually unpacked.
fn total_unpacked<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    prefix: Option<&str>,
) -> Result<u64, String> {
    let mut total = 0u64;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Damaged zip entry #{index}: {error}"))?;
        if entry.is_dir() {
            continue;
        }

        let Some(name) = entry.enclosed_name() else {
            return Err(format!(
                "Zip entry escapes the plugin folder: {}",
                entry.name()
            ));
        };

        let keep = match prefix {
            Some(prefix) => name.strip_prefix(prefix).is_ok(),
            None => true,
        };
        if keep {
            total += entry.size();
        }
    }

    Ok(total)
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

    /// A plugin folder of its own, so these tests can write config files.
    fn plugin_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("plugin-registry-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_placeholder_in_the_ui_takes_the_value_from_a_config_file() {
        let dir = plugin_dir("ui-env");
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
        let dir = plugin_dir("ui-path-segment");
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
        let dir = plugin_dir("ui-plain");
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
        let dir = plugin_dir("ui-default");

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
        let dir = plugin_dir("ui-broken");
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
    fn dir_of_refuses_ids_that_are_not_plain_names() {
        assert!(dir_of("../evil").is_err());
        assert!(dir_of("a/b").is_err());
        assert!(dir_of("ok-id").is_ok());
    }

    /// Builds a zip in memory from `(entry name, contents)` pairs.
    ///
    /// Entry names reach the archive exactly as written — `start_file` does no
    /// separator normalization — which is what lets the test below reproduce
    /// what PowerShell writes.
    fn archive_of(entries: &[(&str, &str)]) -> ZipArchive<std::io::Cursor<Vec<u8>>> {
        use std::io::Cursor;
        use zip::write::SimpleFileOptions;
        use zip::{CompressionMethod, ZipWriter};

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, contents) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(contents.as_bytes()).unwrap();
        }

        ZipArchive::new(writer.finish().unwrap()).unwrap()
    }

    /// The progress denominator sums the entries `extract` would write, and
    /// counts stored (uncompressed) sizes — not the zip's own byte length.
    #[test]
    fn total_unpacked_sums_the_entries_a_prefix_would_write() {
        // `Stored` compression, so each entry's unpacked size is its text length.
        let mut flat = archive_of(&[("a.txt", "hello"), ("b.txt", "world!")]);
        assert_eq!(total_unpacked(&mut flat, None).unwrap(), 11);

        // With a wrapper folder, only the entries inside it count.
        let mut wrapped = archive_of(&[
            ("plug/a.txt", "hello"),
            ("plug/b.txt", "world!"),
            ("other", "x"),
        ]);
        assert_eq!(total_unpacked(&mut wrapped, Some("plug")).unwrap(), 11);
    }

    #[test]
    fn extract_reports_progress_ending_on_the_total() {
        let dir = plugin_dir("progress");
        let mut archive = archive_of(&[("a.txt", "hello"), ("b.txt", "world!")]);

        let mut events = Vec::new();
        let mut on_progress = |progress: InstallProgress| events.push(progress);
        extract(&mut archive, &dir, None, &mut on_progress).unwrap();

        // Opens at zero of a settled total, and the last event is the finish.
        assert_eq!(events.first().unwrap().written, 0);
        let last = events.last().unwrap();
        assert_eq!(last.written, 11);
        assert_eq!(last.total, 11);

        // Monotonic: the bar must never go backwards.
        assert!(events
            .windows(2)
            .all(|pair| pair[0].written <= pair[1].written));
    }

    const MANIFEST: &str = r#"{"id":"demo","name":"Demo","entry":"run.cmd"}"#;

    #[test]
    fn finds_a_manifest_at_the_root() {
        let mut archive = archive_of(&[("plugin.json", MANIFEST), ("run.cmd", "")]);

        let (index, prefix) = find_manifest(&mut archive).unwrap();
        assert_eq!(prefix, None);
        assert_eq!(read_manifest_entry(&mut archive, index).unwrap().id, "demo");
    }

    #[test]
    fn finds_a_manifest_inside_one_wrapper_folder() {
        let mut archive = archive_of(&[
            ("hello-plugin/plugin.json", MANIFEST),
            ("hello-plugin/run.cmd", ""),
        ]);

        let (index, prefix) = find_manifest(&mut archive).unwrap();
        assert_eq!(prefix.as_deref(), Some("hello-plugin"));
        assert_eq!(read_manifest_entry(&mut archive, index).unwrap().id, "demo");
    }

    /// PowerShell's `Compress-Archive` has written entry names as
    /// `folder\plugin.json`. Normalizing separators for the layout check and
    /// then looking the entry up by that normalized name missed the manifest.
    #[test]
    fn finds_a_manifest_behind_backslash_separators() {
        let mut archive = archive_of(&[
            (r"hello-plugin\plugin.json", MANIFEST),
            (r"hello-plugin\run.cmd", ""),
        ]);

        let (index, prefix) = find_manifest(&mut archive).unwrap();
        assert_eq!(prefix.as_deref(), Some("hello-plugin"));
        assert_eq!(read_manifest_entry(&mut archive, index).unwrap().id, "demo");
    }

    #[test]
    fn a_manifest_below_the_wrapper_folder_is_not_a_plugin() {
        let mut archive = archive_of(&[("a/b/plugin.json", MANIFEST)]);
        assert!(find_manifest(&mut archive).is_err());
    }

    #[test]
    fn a_zip_without_a_manifest_is_rejected() {
        let mut archive = archive_of(&[("src/run.cmd", "")]);
        assert!(find_manifest(&mut archive).is_err());
    }
}
