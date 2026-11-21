// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use crate::error::{MiseError, MiseResult};
use crate::models::{
    MiseConfigAlias, MiseConfigDocument, MiseConfigDocumentKind, MiseConfigEdit,
    MiseConfigProjectRef, MiseConfigProxySetting, MiseConfigProxySettings,
    MiseConfigRuntimeSetting, MiseConfigRuntimeSettings, MiseConfigSavePreview,
    MiseConfigSaveResult, MiseConfigToolEntry, MiseConfigToolsSection, MiseConfigValueType,
    MiseConfigWorkspace,
};
use crate::paths;

/// The editor refuses to load or write a document larger than this.
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

/// Config files that are TOML and may therefore be opened in the editor.
const TOML_CONFIG_FILE_NAMES: [&str; 3] = ["mise.toml", ".mise.local.toml", "mise.local.toml"];

/// Files the save command accepts below a project or scan root.
const WHITELIST_FILE_NAMES: [&str; 11] = [
    "mise.toml",
    ".mise.local.toml",
    "mise.local.toml",
    ".tool-versions",
    ".node-version",
    ".nvmrc",
    ".python-version",
    ".ruby-version",
    ".java-version",
    ".go-version",
    ".terraform-version",
];

/// A save target may sit at most this many levels below a project or scan root.
const MAX_CONFIG_DEPTH: usize = 3;

/// One row of the runtime settings card in the global `[settings]` section.
struct RuntimeSettingDefinition {
    key: &'static str,
    value_type: MiseConfigValueType,
    default_value: &'static str,
}

const RUNTIME_SETTINGS: [RuntimeSettingDefinition; 5] = [
    RuntimeSettingDefinition {
        key: "http_timeout",
        value_type: MiseConfigValueType::String,
        default_value: "30s",
    },
    RuntimeSettingDefinition {
        key: "fetch_remote_versions_timeout",
        value_type: MiseConfigValueType::String,
        default_value: "20s",
    },
    RuntimeSettingDefinition {
        key: "http_retries",
        value_type: MiseConfigValueType::Integer,
        default_value: "3",
    },
    RuntimeSettingDefinition {
        key: "offline",
        value_type: MiseConfigValueType::Boolean,
        default_value: "false",
    },
    RuntimeSettingDefinition {
        key: "terminal_progress",
        value_type: MiseConfigValueType::Boolean,
        default_value: "true",
    },
];

/// One row of the proxy card; both spellings are written on save.
struct ProxySettingDefinition {
    key: &'static str,
    aliases: [&'static str; 2],
    placeholder: &'static str,
    requires_uri: bool,
}

const PROXY_SETTINGS: [ProxySettingDefinition; 4] = [
    ProxySettingDefinition {
        key: "http_proxy",
        aliases: ["http_proxy", "HTTP_PROXY"],
        placeholder: "http://127.0.0.1:7890",
        requires_uri: true,
    },
    ProxySettingDefinition {
        key: "https_proxy",
        aliases: ["https_proxy", "HTTPS_PROXY"],
        placeholder: "http://127.0.0.1:7890",
        requires_uri: true,
    },
    ProxySettingDefinition {
        key: "all_proxy",
        aliases: ["all_proxy", "ALL_PROXY"],
        placeholder: "socks5://127.0.0.1:7890",
        requires_uri: true,
    },
    ProxySettingDefinition {
        key: "no_proxy",
        aliases: ["no_proxy", "NO_PROXY"],
        placeholder: "localhost,127.0.0.1,*.local",
        requires_uri: false,
    },
];

/// A project whose TOML document the workspace exposes.
struct ProjectTarget {
    root: PathBuf,
    config_path: PathBuf,
    name: String,
}

/// One configuration file as it exists on disk.
#[derive(Debug)]
struct LoadedConfig {
    content: String,
    exists: bool,
}

/// Run blocking file IO off the async workers.
async fn run_blocking<T, F>(work: F) -> MiseResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> MiseResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| {
            MiseError::internal(format!("The mise configuration task failed: {error}."))
        })?
}

/// Read the global configuration and, when a project is selected, that
/// project's TOML document plus the structured sections the page edits.
pub async fn workspace(
    project_path: Option<&str>,
    project_config_path: Option<&str>,
    project_name: Option<&str>,
) -> MiseResult<MiseConfigWorkspace> {
    let global_path = paths::global_config_path().ok_or_else(|| {
        MiseError::invalid_input("home", "The user home directory could not be resolved.")
    })?;
    let project = resolve_project(project_path, project_config_path, project_name);
    run_blocking(move || load_workspace(&global_path, project.as_ref())).await
}

/// Compute the next document content and its unified diff without writing.
pub async fn preview_edit(path: &str, edit: &MiseConfigEdit) -> MiseResult<MiseConfigSavePreview> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(MiseError::invalid_input(
            "path",
            "The configuration path is required.",
        ));
    }

    let target = PathBuf::from(trimmed);
    let preview_path = path.to_string();
    let edit = edit.clone();
    run_blocking(move || {
        let loaded = load_config(&target)?;
        Ok(build_preview(
            &preview_path,
            &loaded.content,
            loaded.exists,
            &edit,
        ))
    })
    .await
}

/// Back up the existing document, then replace it atomically.
pub async fn save(
    app: &tauri::AppHandle,
    path: &str,
    next_content: &str,
) -> MiseResult<MiseConfigSaveResult> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(MiseError::invalid_input(
            "path",
            "The configuration path is required.",
        ));
    }

    let normalized = normalize_content(next_content);
    if normalized.len() as u64 > MAX_CONFIG_BYTES {
        return Err(MiseError::invalid_input(
            "content",
            "The configuration content is larger than 1 MiB.",
        ));
    }

    let target = PathBuf::from(trimmed);
    if !is_allowed_config_path(app, &target) {
        return Err(MiseError::invalid_input(
            "path",
            "The configuration path is not allowed.",
        ));
    }

    run_blocking(move || write_config_file(&target, &normalized)).await
}

fn resolve_project(
    project_path: Option<&str>,
    project_config_path: Option<&str>,
    project_name: Option<&str>,
) -> Option<ProjectTarget> {
    let config_candidate = project_config_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| is_toml_config_path(path));
    let root = project_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| config_candidate.as_ref().and_then(|path| path.parent().map(Path::to_path_buf)))?;
    let config_path = config_candidate.unwrap_or_else(|| root.join("mise.toml"));
    let name = project_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| {
            root.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default();

    Some(ProjectTarget {
        root,
        config_path,
        name,
    })
}

fn is_toml_config_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| TOML_CONFIG_FILE_NAMES.contains(&name))
        .unwrap_or(false)
}

fn load_workspace(
    global_path: &Path,
    project: Option<&ProjectTarget>,
) -> MiseResult<MiseConfigWorkspace> {
    let global = load_config(global_path)?;
    let global_content = global.content;
    let mut documents = vec![MiseConfigDocument {
        kind: MiseConfigDocumentKind::Global,
        path: display_path(global_path),
        content: global_content.clone(),
        exists: global.exists,
    }];

    let mut project_content = None;
    if let Some(project) = project {
        let loaded = load_config(&project.config_path)?;
        documents.push(MiseConfigDocument {
            kind: MiseConfigDocumentKind::Project,
            path: display_path(&project.config_path),
            content: loaded.content.clone(),
            exists: loaded.exists,
        });
        project_content = Some(loaded.content);
    }

    let global_path_text = display_path(global_path);
    let mut tools_sections = vec![build_tools_section(
        MiseConfigDocumentKind::Global,
        &global_content,
    )];
    if let Some(content) = project_content.as_deref() {
        tools_sections.push(build_tools_section(
            MiseConfigDocumentKind::Project,
            content,
        ));
    }

    Ok(MiseConfigWorkspace {
        documents,
        project: project.map(|project| MiseConfigProjectRef {
            path: display_path(&project.root),
            name: project.name.clone(),
            config_path: display_path(&project.config_path),
        }),
        tools_sections,
        runtime_settings: build_runtime_settings(&global_path_text, &global_content),
        proxy_settings: build_proxy_settings(&global_path_text, &global_content),
        java_aliases: build_java_aliases(&global_content),
    })
}

fn load_config(path: &Path) -> MiseResult<LoadedConfig> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LoadedConfig {
                content: String::new(),
                exists: false,
            });
        }
        Err(error) => {
            log::warn!(
                "mise_config_read_failed path={} error={error}",
                path.display()
            );
            return Err(MiseError::io("The configuration file could not be read."));
        }
    };

    if !metadata.is_file() {
        return Err(MiseError::invalid_input(
            "path",
            "The configuration path is not a file.",
        ));
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(MiseError::invalid_input(
            "content",
            "The configuration file is larger than 1 MiB.",
        ));
    }

    let bytes = std::fs::read(path).map_err(|error| {
        log::warn!(
            "mise_config_read_failed path={} error={error}",
            path.display()
        );
        MiseError::io("The configuration file could not be read.")
    })?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(MiseError::invalid_input(
            "content",
            "The configuration file is larger than 1 MiB.",
        ));
    }

    let content = String::from_utf8(bytes).map_err(|_| {
        MiseError::invalid_input("content", "The configuration file is not valid UTF-8.")
    })?;

    Ok(LoadedConfig {
        content,
        exists: true,
    })
}

fn build_tools_section(
    kind: MiseConfigDocumentKind,
    content: &str,
) -> MiseConfigToolsSection {
    let entries = extract_section(content, "tools")
        .map(|section| parse_assignments(&section))
        .unwrap_or_default()
        .into_iter()
        .map(|(tool, version)| MiseConfigToolEntry { tool, version })
        .collect();

    MiseConfigToolsSection { kind, entries }
}

fn build_runtime_settings(path: &str, content: &str) -> MiseConfigRuntimeSettings {
    let settings = extract_section(content, "settings")
        .map(|section| parse_assignments(&section))
        .unwrap_or_default();

    MiseConfigRuntimeSettings {
        path: path.to_string(),
        settings: RUNTIME_SETTINGS
            .iter()
            .map(|definition| MiseConfigRuntimeSetting {
                key: definition.key.to_string(),
                value_type: definition.value_type,
                value: settings.get(definition.key).cloned().unwrap_or_default(),
                default_value: definition.default_value.to_string(),
                is_set: settings.contains_key(definition.key),
            })
            .collect(),
    }
}

fn build_proxy_settings(path: &str, content: &str) -> MiseConfigProxySettings {
    let env = extract_section(content, "env")
        .map(|section| parse_assignments(&section))
        .unwrap_or_default();

    MiseConfigProxySettings {
        path: path.to_string(),
        settings: PROXY_SETTINGS
            .iter()
            .map(|definition| {
                let value = definition
                    .aliases
                    .iter()
                    .find_map(|alias| {
                        env.get(*alias)
                            .map(|value| value.trim())
                            .filter(|value| !value.is_empty())
                    })
                    .unwrap_or_default()
                    .to_string();

                MiseConfigProxySetting {
                    key: definition.key.to_string(),
                    is_set: !value.is_empty(),
                    value,
                    placeholder: definition.placeholder.to_string(),
                    requires_uri: definition.requires_uri,
                }
            })
            .collect(),
    }
}

fn build_java_aliases(content: &str) -> Vec<MiseConfigAlias> {
    extract_section(content, "tool_alias.java.versions")
        .map(|section| parse_assignments(&section))
        .unwrap_or_default()
        .into_iter()
        .map(|(alias, target)| MiseConfigAlias { alias, target })
        .collect()
}

fn build_preview(
    path: &str,
    current: &str,
    exists: bool,
    edit: &MiseConfigEdit,
) -> MiseConfigSavePreview {
    let next_content = match edit {
        MiseConfigEdit::Document { content } => normalize_content(content),
        MiseConfigEdit::Settings { values } => build_settings_content(current, values),
        MiseConfigEdit::Proxy { values } => build_proxy_content(current, values),
        MiseConfigEdit::Aliases { values } => build_aliases_content(current, values),
    };
    let normalized_current = normalize_content(current);
    let has_changes = normalized_current != next_content;

    MiseConfigSavePreview {
        path: path.to_string(),
        exists,
        current_content: current.to_string(),
        diff: build_diff(&normalized_current, &next_content, path),
        next_content,
        has_changes,
        creates_file: !exists,
    }
}

fn is_allowed_config_path(app: &tauri::AppHandle, path: &Path) -> bool {
    let roots = allowed_config_roots(app);
    is_allowed_path(path, paths::global_config_path().as_deref(), &roots)
}

fn allowed_config_roots(app: &tauri::AppHandle) -> Vec<String> {
    let mut roots = crate::projects::opened_project_roots(app);
    match crate::projects::list_scan_dirs() {
        Ok(directories) => roots.extend(
            directories
                .into_iter()
                .filter(|directory| directory.enabled)
                .map(|directory| directory.path),
        ),
        Err(error) => log::warn!("mise_config_scan_roots_failed error={error}"),
    }
    roots
}

fn is_allowed_path(path: &Path, global: Option<&Path>, roots: &[String]) -> bool {
    let candidate = normalize_path(path);
    if let Some(global) = global {
        if normalize_path(global) == candidate {
            return true;
        }
    }

    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if !WHITELIST_FILE_NAMES.contains(&file_name) {
        return false;
    }

    let Some(parent) = path.parent() else {
        return false;
    };
    let parent = normalize_path(parent);

    roots
        .iter()
        .any(|root| is_within_root(&parent, &normalize_path(Path::new(root))))
}

fn is_within_root(candidate: &str, root: &str) -> bool {
    if candidate == root {
        return true;
    }
    let prefix = if root.ends_with('/') {
        root.to_string()
    } else {
        format!("{root}/")
    };
    match candidate.strip_prefix(&prefix) {
        Some(rest) => rest.split('/').filter(|part| !part.is_empty()).count() <= MAX_CONFIG_DEPTH,
        None => false,
    }
}

fn write_config_file(path: &Path, content: &str) -> MiseResult<MiseConfigSaveResult> {
    let created = !path.exists();

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            log::warn!(
                "mise_config_create_dir_failed path={} error={error}",
                parent.display()
            );
            MiseError::io("The configuration directory could not be created.")
        })?;
    }

    let backup = paths::backup_existing(path)?;
    let bytes = content.as_bytes();
    paths::atomic_write(path, bytes)?;

    Ok(MiseConfigSaveResult {
        path: display_path(path),
        backup_path: backup.as_deref().map(display_path),
        bytes_written: bytes.len() as u64,
        created,
    })
}

/// `[name]` through the line before the next table header, trailing whitespace
/// removed. Lines and their indentation are kept as written.
///
/// The project scan reuses this parser, so both helpers stay crate-visible.
pub(crate) fn extract_section(content: &str, name: &str) -> Option<String> {
    if content.trim().is_empty() {
        return None;
    }

    let lines: Vec<&str> = content.split('\n').collect();
    let start = section_start(&lines, name)?;
    let end = section_end(&lines, start).unwrap_or(lines.len());
    let section = lines[start..end].join("\n");
    let trimmed = section.trim_end();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The `key = value` pairs of an extracted section, sorted by key.
pub(crate) fn parse_assignments(section: &str) -> BTreeMap<String, String> {
    let mut assignments = BTreeMap::new();

    for line in section.split('\n') {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed.starts_with('[')
            || !trimmed.contains('=')
        {
            continue;
        }
        let Some(separator) = trimmed.find('=') else {
            continue;
        };
        let key = trimmed[..separator].trim().replace('"', "");
        let value = strip_toml_quotes(&trimmed[separator + 1..]);
        assignments.insert(key, value);
    }

    assignments
}

fn strip_toml_quotes(value: &str) -> String {
    let trimmed = value.trim();
    let characters: Vec<char> = trimmed.chars().collect();
    if characters.len() < 2 {
        return trimmed.to_string();
    }
    let quote = characters[0];
    if (quote != '"' && quote != '\'') || characters[characters.len() - 1] != quote {
        return trimmed.to_string();
    }
    characters[1..characters.len() - 1]
        .iter()
        .collect::<String>()
        .replace("\\\"", "\"")
        .replace("\\'", "'")
}

fn build_settings_content(
    current: &str,
    values: &BTreeMap<String, Option<String>>,
) -> String {
    let normalized = normalize_content(current);
    let mut lines = content_lines(&normalized);

    let Some(start) = section_start(&lines, "settings") else {
        if !lines.is_empty() && !lines.last().map(|line| line.trim().is_empty()).unwrap_or(true) {
            lines.push(String::new());
        }
        lines.push("[settings]".to_string());
        for definition in RUNTIME_SETTINGS.iter() {
            if let Some(value) = value_for(values, definition.key) {
                lines.push(format!(
                    "{} = {}",
                    definition.key,
                    format_setting_value(definition, value)
                ));
            }
        }
        return normalize_content(&lines.join("\n"));
    };

    let end = section_end(&lines, start).unwrap_or(lines.len());
    let mut handled = HashSet::new();
    let mut next_lines: Vec<String> = lines[..=start].to_vec();

    for line in &lines[start + 1..end] {
        if let Some(key) = assignment_key(line) {
            if values.contains_key(&key) {
                handled.insert(key.clone());
                if let Some(definition) = runtime_definition(&key) {
                    if let Some(value) = value_for(values, &key) {
                        next_lines.push(format!(
                            "{} = {}",
                            key,
                            format_setting_value(definition, value)
                        ));
                    }
                }
                continue;
            }
        }
        next_lines.push(line.clone());
    }

    for definition in RUNTIME_SETTINGS.iter() {
        if handled.contains(definition.key) {
            continue;
        }
        if let Some(value) = value_for(values, definition.key) {
            next_lines.push(format!(
                "{} = {}",
                definition.key,
                format_setting_value(definition, value)
            ));
        }
    }

    next_lines.extend_from_slice(&lines[end..]);
    normalize_content(&next_lines.join("\n"))
}

fn build_proxy_content(
    current: &str,
    values: &BTreeMap<String, Option<String>>,
) -> String {
    let normalized = normalize_content(current);
    let mut lines = content_lines(&normalized);
    let has_any_value = PROXY_SETTINGS
        .iter()
        .any(|definition| value_for(values, definition.key).is_some());

    let Some(start) = section_start(&lines, "env") else {
        if !has_any_value {
            return normalized;
        }
        if !lines.is_empty() && !lines.last().map(|line| line.trim().is_empty()).unwrap_or(true) {
            lines.push(String::new());
        }
        lines.push("[env]".to_string());
        append_proxy_lines(&mut lines, values);
        return normalize_content(&lines.join("\n"));
    };

    let end = section_end(&lines, start).unwrap_or(lines.len());
    let aliases: HashSet<&str> = PROXY_SETTINGS
        .iter()
        .flat_map(|definition| definition.aliases)
        .collect();
    let mut next_lines: Vec<String> = lines[..=start].to_vec();

    for line in &lines[start + 1..end] {
        if let Some(key) = assignment_key(line) {
            if aliases.contains(key.as_str()) {
                continue;
            }
        }
        next_lines.push(line.clone());
    }

    append_proxy_lines(&mut next_lines, values);
    next_lines.extend_from_slice(&lines[end..]);
    normalize_content(&next_lines.join("\n"))
}

fn append_proxy_lines(lines: &mut Vec<String>, values: &BTreeMap<String, Option<String>>) {
    for definition in PROXY_SETTINGS.iter() {
        let Some(value) = value_for(values, definition.key) else {
            continue;
        };
        let escaped = escape_toml_string(value);
        for alias in definition.aliases {
            lines.push(format!("{alias} = \"{escaped}\""));
        }
    }
}

fn build_aliases_content(
    current: &str,
    values: &BTreeMap<String, Option<String>>,
) -> String {
    let normalized = normalize_content(current);
    let lines = content_lines(&normalized);

    let mut next_lines = match section_start(&lines, "tool_alias.java.versions") {
        Some(start) => {
            let end = section_end(&lines, start).unwrap_or(lines.len());
            let mut next = lines[..start].to_vec();
            next.extend_from_slice(&lines[end..]);
            next
        }
        None => lines,
    };

    let entries: Vec<(String, String)> = values
        .iter()
        .filter_map(|(alias, target)| {
            let target = target
                .as_deref()
                .map(str::trim)
                .filter(|target| !target.is_empty())?;
            let alias = alias.trim();
            if alias.is_empty() {
                return None;
            }
            Some((alias.to_string(), target.to_string()))
        })
        .collect();

    if !entries.is_empty() {
        while next_lines
            .last()
            .map(|line| line.trim().is_empty())
            .unwrap_or(false)
        {
            next_lines.pop();
        }
        if !next_lines.is_empty() {
            next_lines.push(String::new());
        }
        next_lines.push("[tool_alias.java.versions]".to_string());
        for (alias, target) in entries {
            next_lines.push(format!("{alias} = \"{}\"", escape_toml_string(&target)));
        }
    }

    normalize_content(&next_lines.join("\n"))
}

fn normalize_content(value: &str) -> String {
    let normalized = value.replace("\r\n", "\n");
    let trimmed = normalized.trim_end();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\n")
    }
}

fn build_diff(before: &str, after: &str, path: &str) -> String {
    if before == after {
        return format!("--- {path}\n+++ {path}\n# Content is unchanged");
    }

    let before_lines = content_lines(before);
    let after_lines = content_lines(after);

    let mut prefix = 0;
    while prefix < before_lines.len()
        && prefix < after_lines.len()
        && before_lines[prefix] == after_lines[prefix]
    {
        prefix += 1;
    }

    let mut suffix = 0;
    while suffix < before_lines.len() - prefix
        && suffix < after_lines.len() - prefix
        && before_lines[before_lines.len() - 1 - suffix]
            == after_lines[after_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let changed_before = &before_lines[prefix..before_lines.len() - suffix];
    let changed_after = &after_lines[prefix..after_lines.len() - suffix];

    let mut diff = vec![format!("--- {path}"), format!("+++ {path}")];
    if prefix > 0 {
        diff.push(format!("@@ ... {prefix} lines unchanged before @@"));
    }
    for line in changed_before {
        diff.push(format!("- {line}"));
    }
    for line in changed_after {
        diff.push(format!("+ {line}"));
    }
    if suffix > 0 {
        diff.push(format!("@@ ... {suffix} lines unchanged after @@"));
    }

    diff.join("\n")
}

fn content_lines(content: &str) -> Vec<String> {
    if content.is_empty() {
        Vec::new()
    } else {
        content.lines().map(str::to_string).collect()
    }
}

fn section_start<S: AsRef<str>>(lines: &[S], name: &str) -> Option<usize> {
    let header = format!("[{name}]");
    lines
        .iter()
        .position(|line| line.as_ref().trim() == header)
}

fn section_end<S: AsRef<str>>(lines: &[S], start: usize) -> Option<usize> {
    lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, line)| {
            let trimmed = line.as_ref().trim();
            trimmed.starts_with('[') && trimmed.ends_with(']')
        })
        .map(|(index, _)| index)
}

fn assignment_key(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let end = trimmed.find(|character: char| {
        !(character.is_ascii_alphanumeric()
            || character == '.'
            || character == '_'
            || character == '-')
    })?;
    if end == 0 {
        return None;
    }
    let rest = trimmed[end..].trim_start();
    rest.starts_with('=')
        .then(|| trimmed[..end].to_string())
}

fn value_for<'a>(
    values: &'a BTreeMap<String, Option<String>>,
    key: &str,
) -> Option<&'a str> {
    values
        .get(key)
        .and_then(|value| value.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn runtime_definition(key: &str) -> Option<&'static RuntimeSettingDefinition> {
    RUNTIME_SETTINGS
        .iter()
        .find(|definition| definition.key == key)
}

fn format_setting_value(definition: &RuntimeSettingDefinition, value: &str) -> String {
    match definition.value_type {
        MiseConfigValueType::String => format!("\"{}\"", escape_toml_string(value)),
        MiseConfigValueType::Integer | MiseConfigValueType::Boolean => value.to_string(),
    }
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn normalize_path(path: &Path) -> String {
    let mut normalized = path.to_string_lossy().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    #[cfg(windows)]
    {
        normalized = normalized.to_lowercase();
    }
    normalized
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEMP_COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let unique = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "mise-config-{tag}-{}-{unique}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn values(entries: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.map(str::to_string)))
            .collect()
    }

    #[test]
    fn extract_section_keeps_lines_and_stops_at_next_table() {
        let content = "[tools]\nnode = \"20\"\n  python = \"3.12\"\n\n[env]\nA = \"1\"\n";

        assert_eq!(
            extract_section(content, "tools").as_deref(),
            Some("[tools]\nnode = \"20\"\n  python = \"3.12\"")
        );
        assert_eq!(
            extract_section(content, "env").as_deref(),
            Some("[env]\nA = \"1\"")
        );
        assert_eq!(extract_section(content, "settings"), None);
        assert_eq!(extract_section("   \n", "tools"), None);
    }

    #[test]
    fn parse_assignments_skips_comments_and_blank_lines() {
        let section = "[tools]\n# comment\nnode = \"20\"\n  python = '3.12'  \nflag = true\nnot an assignment\n";

        let assignments = parse_assignments(section);

        assert_eq!(assignments.get("node").map(String::as_str), Some("20"));
        assert_eq!(assignments.get("python").map(String::as_str), Some("3.12"));
        assert_eq!(assignments.get("flag").map(String::as_str), Some("true"));
        assert_eq!(assignments.len(), 3);
    }

    #[test]
    fn parse_assignments_strips_quoted_keys_and_escaped_quotes() {
        let section = "\"node\" = \"20\"\nname = \"a\\\"b\"\nother = 'c\\'d'\n";

        let assignments = parse_assignments(section);

        assert_eq!(assignments.get("node").map(String::as_str), Some("20"));
        assert_eq!(assignments.get("name").map(String::as_str), Some("a\"b"));
        assert_eq!(assignments.get("other").map(String::as_str), Some("c'd"));
    }

    #[test]
    fn strip_toml_quotes_only_removes_matching_pairs() {
        assert_eq!(strip_toml_quotes("\"20\""), "20");
        assert_eq!(strip_toml_quotes("'20'"), "20");
        assert_eq!(strip_toml_quotes("\"20'"), "\"20'");
        assert_eq!(strip_toml_quotes("latest"), "latest");
        assert_eq!(strip_toml_quotes(""), "");
    }

    #[test]
    fn normalize_content_unifies_newlines_and_trailing_space() {
        assert_eq!(normalize_content("a = 1\r\nb = 2\r\n\r\n"), "a = 1\nb = 2\n");
        assert_eq!(normalize_content("   \n\n"), "");
        assert_eq!(normalize_content("a = 1"), "a = 1\n");
    }

    #[test]
    fn settings_content_appends_a_new_section() {
        let current = "[tools]\nnode = \"20\"\n";
        let edit = values(&[
            ("http_retries", Some("5")),
            ("offline", Some("true")),
            ("http_timeout", None),
        ]);

        assert_eq!(
            build_settings_content(current, &edit),
            "[tools]\nnode = \"20\"\n\n[settings]\nhttp_retries = 5\noffline = true\n"
        );
    }

    #[test]
    fn settings_content_replaces_and_deletes_existing_keys() {
        let current = "[tools]\nnode = \"20\"\n\n[settings]\n# keep me\nhttp_timeout = \"10s\"\nhttp_retries = 7\n\n[env]\nA = \"1\"\n";
        let edit = values(&[("http_timeout", Some("30s")), ("http_retries", None)]);

        assert_eq!(
            build_settings_content(current, &edit),
            "[tools]\nnode = \"20\"\n\n[settings]\n# keep me\nhttp_timeout = \"30s\"\n\n[env]\nA = \"1\"\n"
        );
    }

    #[test]
    fn settings_content_escapes_strings_and_keeps_other_lines() {
        let current = "[settings]\nhttp_timeout = \"10s\"\n";
        let edit = values(&[("fetch_remote_versions_timeout", Some("a\"b\\c"))]);

        let content = build_settings_content(current, &edit);

        assert_eq!(
            content,
            "[settings]\nhttp_timeout = \"10s\"\nfetch_remote_versions_timeout = \"a\\\"b\\\\c\"\n"
        );
    }

    #[test]
    fn proxy_content_appends_env_section_with_both_spellings() {
        let current = "[tools]\nnode = \"20\"\n";
        let edit = values(&[("http_proxy", Some("http://127.0.0.1:7890"))]);

        assert_eq!(
            build_proxy_content(current, &edit),
            "[tools]\nnode = \"20\"\n\n[env]\nhttp_proxy = \"http://127.0.0.1:7890\"\nHTTP_PROXY = \"http://127.0.0.1:7890\"\n"
        );
    }

    #[test]
    fn proxy_content_without_env_and_without_values_is_unchanged() {
        let current = "[tools]\nnode = \"20\"\n";
        let edit = values(&[("http_proxy", None), ("no_proxy", Some("  "))]);

        assert_eq!(build_proxy_content(current, &edit), current);
    }

    #[test]
    fn proxy_content_removes_all_aliases_and_keeps_other_env_keys() {
        let current = "[tools]\nnode = \"20\"\n\n[env]\nHTTP_PROXY = \"http://old\"\nhttp_proxy = \"http://old\"\nOTHER = \"keep\"\n";

        assert_eq!(
            build_proxy_content(current, &values(&[("http_proxy", None)])),
            "[tools]\nnode = \"20\"\n\n[env]\nOTHER = \"keep\"\n"
        );
    }

    #[test]
    fn proxy_content_replaces_existing_aliases_in_place() {
        let current = "[env]\nhttp_proxy = \"http://old\"\nNO_PROXY = \"old\"\n";
        let edit = values(&[
            ("http_proxy", Some("http://new")),
            ("no_proxy", Some("localhost")),
        ]);

        assert_eq!(
            build_proxy_content(current, &edit),
            "[env]\nhttp_proxy = \"http://new\"\nHTTP_PROXY = \"http://new\"\nno_proxy = \"localhost\"\nNO_PROXY = \"localhost\"\n"
        );
    }

    #[test]
    fn alias_content_appends_a_section_in_alias_order() {
        let current = "[tools]\nnode = \"20\"\n";
        let edit = values(&[
            ("17", Some("corretto-17")),
            ("8", Some("corretto-8")),
            ("21", Some("  ")),
        ]);

        assert_eq!(
            build_aliases_content(current, &edit),
            "[tools]\nnode = \"20\"\n\n[tool_alias.java.versions]\n17 = \"corretto-17\"\n8 = \"corretto-8\"\n"
        );
    }

    #[test]
    fn alias_content_replaces_the_existing_section() {
        let current = "[tools]\nnode = \"20\"\n\n[tool_alias.java.versions]\n17 = \"temurin-17\"\n\n[env]\nA = \"1\"\n";
        let edit = values(&[("21", Some("corretto-21"))]);

        assert_eq!(
            build_aliases_content(current, &edit),
            "[tools]\nnode = \"20\"\n\n[env]\nA = \"1\"\n\n[tool_alias.java.versions]\n21 = \"corretto-21\"\n"
        );
    }

    #[test]
    fn alias_content_with_only_empty_values_removes_the_section() {
        let current = "[tools]\nnode = \"20\"\n\n[tool_alias.java.versions]\n17 = \"temurin-17\"\n\n[env]\nA = \"1\"\n";
        let edit = values(&[("21", None), ("17", None)]);

        assert_eq!(
            build_aliases_content(current, &edit),
            "[tools]\nnode = \"20\"\n\n[env]\nA = \"1\"\n"
        );
    }

    #[test]
    fn diff_reports_unchanged_contents() {
        assert_eq!(
            build_diff("a = 1\n", "a = 1\n", "/tmp/mise.toml"),
            "--- /tmp/mise.toml\n+++ /tmp/mise.toml\n# Content is unchanged"
        );
    }

    #[test]
    fn diff_counts_unchanged_lines_around_a_change() {
        assert_eq!(
            build_diff("a\nb\nc\n", "a\nB\nc\n", "mise.toml"),
            "--- mise.toml\n+++ mise.toml\n@@ ... 1 lines unchanged before @@\n- b\n+ B\n@@ ... 1 lines unchanged after @@"
        );
    }

    #[test]
    fn diff_without_common_lines_omits_count_markers() {
        assert_eq!(
            build_diff("a\n", "b\n", "mise.toml"),
            "--- mise.toml\n+++ mise.toml\n- a\n+ b"
        );
    }

    #[test]
    fn whitelist_accepts_the_global_config_path() {
        let root = TempDir::new("global");
        let global = root.path.join(".config").join("mise").join("config.toml");

        assert!(is_allowed_path(&global, Some(&global), &[]));
        assert!(!is_allowed_path(
            &root.path.join("elsewhere").join("config.toml"),
            Some(&global),
            &[]
        ));
    }

    #[test]
    fn whitelist_accepts_project_files_within_three_levels() {
        #[cfg(windows)]
        let root = "C:/projects/demo";
        #[cfg(not(windows))]
        let root = "/projects/demo";
        let roots = vec![root.to_string()];

        assert!(is_allowed_path(
            Path::new(&format!("{root}/mise.toml")),
            None,
            &roots
        ));
        assert!(is_allowed_path(
            Path::new(&format!("{root}/a/b/c/.tool-versions")),
            None,
            &roots
        ));
        assert!(is_allowed_path(
            Path::new(&format!("{root}/.terraform-version")),
            None,
            &roots
        ));
        assert!(!is_allowed_path(
            Path::new(&format!("{root}/a/b/c/d/mise.toml")),
            None,
            &roots
        ));
        assert!(!is_allowed_path(
            Path::new(&format!("{root}/config.toml")),
            None,
            &roots
        ));
        assert!(!is_allowed_path(
            Path::new("/somewhere/else/mise.toml"),
            None,
            &roots
        ));
    }

    #[test]
    fn whitelist_rejects_paths_without_a_root() {
        assert!(!is_allowed_path(Path::new("mise.toml"), None, &[]));
    }

    #[test]
    fn resolve_project_prefers_the_selected_toml_file() {
        let project = resolve_project(
            Some("/projects/demo"),
            Some("/projects/demo/.mise.local.toml"),
            Some("demo"),
        )
        .unwrap();

        assert_eq!(project.root, PathBuf::from("/projects/demo"));
        assert_eq!(project.config_path, PathBuf::from("/projects/demo/.mise.local.toml"));
        assert_eq!(project.name, "demo");
    }

    #[test]
    fn resolve_project_falls_back_to_mise_toml_and_the_directory_name() {
        let project = resolve_project(Some("/projects/demo/"), Some("/projects/demo/.tool-versions"), None)
            .unwrap();

        assert_eq!(project.root, PathBuf::from("/projects/demo/"));
        assert_eq!(project.config_path, PathBuf::from("/projects/demo/mise.toml"));
        assert_eq!(project.name, "demo");
    }

    #[test]
    fn resolve_project_ignores_a_non_toml_config_without_a_directory() {
        assert!(resolve_project(None, Some("/tmp/.node-version"), None).is_none());
        assert!(resolve_project(Some(""), None, None).is_none());
    }

    #[test]
    fn load_config_reports_missing_files_and_rejects_invalid_utf8() {
        let root = TempDir::new("load");
        let missing = root.path.join("mise.toml");
        let loaded = load_config(&missing).unwrap();
        assert!(!loaded.exists);
        assert_eq!(loaded.content, "");

        let invalid = root.path.join(".mise.local.toml");
        std::fs::write(&invalid, [0xFF, 0xFE]).unwrap();
        let error = load_config(&invalid).unwrap_err();
        assert_eq!(error.code, crate::error::MiseErrorCode::InvalidInput);
    }

    #[test]
    fn load_config_rejects_files_over_one_mib() {
        let root = TempDir::new("oversized");
        let oversized = root.path.join("mise.toml");
        std::fs::write(&oversized, vec![b'#'; MAX_CONFIG_BYTES as usize + 1]).unwrap();

        let error = load_config(&oversized).unwrap_err();
        assert_eq!(error.code, crate::error::MiseErrorCode::InvalidInput);
    }

    #[test]
    fn write_config_file_backs_up_and_leaves_no_temporary_file() {
        let root = TempDir::new("write");
        let target = root.path.join("nested").join("mise.toml");

        let first = write_config_file(&target, "[tools]\nnode = \"20\"\n").unwrap();
        assert!(first.created);
        assert_eq!(first.backup_path, None);
        assert_eq!(first.bytes_written, "[tools]\nnode = \"20\"\n".len() as u64);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "[tools]\nnode = \"20\"\n"
        );

        let second = write_config_file(&target, "[tools]\nnode = \"22\"\n").unwrap();
        assert!(!second.created);
        let backup_path = second.backup_path.expect("an existing file is backed up");
        assert!(backup_path.contains(".bak-"));
        assert_eq!(
            std::fs::read_to_string(&backup_path).unwrap(),
            "[tools]\nnode = \"20\"\n"
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "[tools]\nnode = \"22\"\n"
        );
        assert!(!root.path.join("nested").join("mise.toml.tmp").exists());
    }

    #[test]
    fn workspace_reads_both_documents_and_the_edited_sections() {
        let root = TempDir::new("workspace");
        let global = root.path.join("config.toml");
        std::fs::write(
            &global,
            "[tools]\npython = \"3.12\"\n\n[settings]\nhttp_retries = 5\n\n[env]\nHTTP_PROXY = \"http://127.0.0.1:7890\"\n\n[tool_alias.java.versions]\n21 = \"corretto-21\"\n17 = \"corretto-17\"\n",
        )
        .unwrap();
        let project_root = root.path.join("demo");
        std::fs::create_dir_all(&project_root).unwrap();
        let project_config = project_root.join("mise.toml");
        std::fs::write(&project_config, "[tools]\nnode = \"20\"\n").unwrap();
        let project = ProjectTarget {
            root: project_root.clone(),
            config_path: project_config.clone(),
            name: "demo".to_string(),
        };

        let workspace = load_workspace(&global, Some(&project)).unwrap();

        assert_eq!(workspace.documents.len(), 2);
        assert_eq!(workspace.documents[0].kind, MiseConfigDocumentKind::Global);
        assert!(workspace.documents[0].exists);
        assert_eq!(workspace.documents[1].kind, MiseConfigDocumentKind::Project);

        assert_eq!(workspace.tools_sections.len(), 2);
        assert_eq!(workspace.tools_sections[0].entries.len(), 1);
        assert_eq!(workspace.tools_sections[0].entries[0].tool, "python");
        assert_eq!(workspace.tools_sections[1].entries[0].version, "20");

        let retries = workspace
            .runtime_settings
            .settings
            .iter()
            .find(|setting| setting.key == "http_retries")
            .unwrap();
        assert_eq!(retries.value, "5");
        assert!(retries.is_set);
        let offline = workspace
            .runtime_settings
            .settings
            .iter()
            .find(|setting| setting.key == "offline")
            .unwrap();
        assert!(!offline.is_set);
        assert_eq!(offline.default_value, "false");

        let http_proxy = workspace
            .proxy_settings
            .settings
            .iter()
            .find(|setting| setting.key == "http_proxy")
            .unwrap();
        assert_eq!(http_proxy.value, "http://127.0.0.1:7890");
        assert!(http_proxy.is_set);
        assert!(http_proxy.requires_uri);

        let aliases: Vec<&str> = workspace
            .java_aliases
            .iter()
            .map(|alias| alias.alias.as_str())
            .collect();
        assert_eq!(aliases, vec!["17", "21"]);

        let reference = workspace.project.unwrap();
        assert_eq!(reference.name, "demo");
        assert_eq!(reference.path, project_root.to_string_lossy().into_owned());
        assert_eq!(
            reference.config_path,
            project_config.to_string_lossy().into_owned()
        );
    }

    #[test]
    fn preview_edit_creates_a_preview_without_writing() {
        let root = TempDir::new("preview");
        let target = root.path.join("mise.toml");
        let edit = MiseConfigEdit::Settings {
            values: values(&[("http_retries", Some("4"))]),
        };

        let preview = build_preview(
            &target.to_string_lossy(),
            "",
            false,
            &edit,
        );

        assert!(preview.creates_file);
        assert!(preview.has_changes);
        assert_eq!(
            preview.next_content,
            "[settings]\nhttp_retries = 4\n"
        );
        assert!(!preview.diff.contains("# Content is unchanged"));
        assert!(!target.exists());

        let unchanged = build_preview(
            &target.to_string_lossy(),
            "[settings]\nhttp_retries = 4\n",
            true,
            &edit,
        );
        assert!(!unchanged.has_changes);
        assert!(unchanged.diff.ends_with("# Content is unchanged"));
    }
}
