// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

//! Project coverage: the mise projects behind the open project windows and the
//! custom scan roots, the declarations their configuration files carry, and the
//! bindings that compare those declarations with the global configuration.

use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::config::{extract_section, parse_assignments};
use crate::error::{MiseError, MiseErrorCode, MiseResult};
use crate::models::{
    MiseBindingSource, MiseHealthLevel, MiseNotice, MiseNoticeCode, MiseProject,
    MiseProjectBinding, MiseProjectCoverage, MiseProjectNotes, MiseProjectScanIssue,
    MiseScanDirectory,
};
use crate::paths;
use crate::process;

const SCAN_DIRS_VERSION: u32 = 1;
const MAX_SCAN_DIRS: usize = 50;
const MAX_DEPTH: usize = 3;
const MAX_DIRECTORIES_PER_ROOT: usize = 240;
const MAX_PROJECTS_PER_ROOT: usize = 80;
const LS_TIMEOUT: Duration = Duration::from_secs(30);
const NOT_SET: &str = "not set";
const PROJECT_WINDOW_PREFIX: &str = "project-";

const WORKSPACE_CONFIG_NAMES: [&str; 3] = ["mise.toml", ".mise.local.toml", "mise.local.toml"];
const TOOL_VERSIONS_FILE: &str = ".tool-versions";
const SINGLE_TOOL_FILES: [(&str, &str); 7] = [
    (".node-version", "node"),
    (".nvmrc", "node"),
    (".python-version", "python"),
    (".ruby-version", "ruby"),
    (".java-version", "java"),
    (".go-version", "go"),
    (".terraform-version", "terraform"),
];
const IGNORED_DIRECTORIES: [&str; 7] = [
    ".git",
    ".dart_tool",
    ".idea",
    ".vscode",
    "build",
    "dist",
    "node_modules",
];

/// Serializes the read-modify-write of `scan_dirs.json`. Never held while
/// scanning a directory or running mise.
static SCAN_DIRS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScanDirectoriesDocument {
    version: u32,
    directories: Vec<MiseScanDirectory>,
}

/// Scan the open project windows and the enabled custom roots for mise
/// configuration and resolve each project's bindings.
pub async fn scan_projects(app: &tauri::AppHandle) -> MiseResult<MiseProjectCoverage> {
    let opened_projects = opened_project_roots(app);
    let scan_directories = list_scan_dirs()?;
    let roots = scan_roots(&opened_projects, &scan_directories);

    let global_tools = tokio::task::spawn_blocking(read_global_tools)
        .await
        .unwrap_or_default();

    let discoveries = tokio::task::spawn_blocking(move || {
        roots
            .iter()
            .map(|root| discover_root(root))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| {
        log::warn!("mise_project_scan_join_failed error={error}");
        MiseError::internal("The project scan could not be completed.")
    })?;

    let mut notices = Vec::new();
    let mut projects = Vec::new();
    let mut seen = HashSet::new();
    let mut mise_missing = false;

    for discovery in discoveries {
        if discovery.missing {
            notices.push(MiseNotice {
                code: MiseNoticeCode::Other,
                level: MiseHealthLevel::Warning,
                detail: Some(discovery.root.clone()),
                command: None,
            });
            continue;
        }

        for prepared in discovery.projects {
            if !seen.insert(comparable(&prepared.directory_path)) {
                continue;
            }

            let outcome = if mise_missing {
                ActiveVersionOutcome::Failed {
                    issue: MiseProjectScanIssue::Unavailable,
                    missing_mise: true,
                    message: None,
                }
            } else {
                read_active_versions(Path::new(&prepared.directory_path)).await
            };

            let (active_versions, scan_issue) = match outcome {
                ActiveVersionOutcome::Ready(versions) => (Some(versions), None),
                ActiveVersionOutcome::Failed {
                    issue,
                    missing_mise: missing,
                    message,
                } => {
                    if missing && !mise_missing {
                        mise_missing = true;
                        notices.push(MiseNotice {
                            code: MiseNoticeCode::Other,
                            level: MiseHealthLevel::Warning,
                            detail: message,
                            command: None,
                        });
                    }
                    (None, Some(issue))
                }
            };

            if let Some(project) = build_project(
                &prepared,
                &discovery.root,
                &global_tools,
                active_versions.as_ref(),
                scan_issue,
            ) {
                projects.push(project);
            }
        }
    }

    projects.sort_by(|left, right| {
        right
            .override_count
            .cmp(&left.override_count)
            .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
    });

    Ok(MiseProjectCoverage {
        opened_projects,
        scan_directories,
        projects,
        notices,
    })
}

/// The persisted custom scan roots, normalized and ordered by depth.
pub fn list_scan_dirs() -> MiseResult<Vec<MiseScanDirectory>> {
    list_scan_dirs_at(&paths::scan_dirs_path()?)
}

pub fn add_scan_dir(path: &str) -> MiseResult<Vec<MiseScanDirectory>> {
    let file = paths::scan_dirs_path()?;
    let _guard = scan_dirs_lock();
    add_scan_dir_at(&file, path)
}

pub fn remove_scan_dir(path: &str) -> MiseResult<Vec<MiseScanDirectory>> {
    let file = paths::scan_dirs_path()?;
    let _guard = scan_dirs_lock();
    remove_scan_dir_at(&file, path)
}

pub fn set_scan_dir_enabled(path: &str, enabled: bool) -> MiseResult<Vec<MiseScanDirectory>> {
    let file = paths::scan_dirs_path()?;
    let _guard = scan_dirs_lock();
    set_scan_dir_enabled_at(&file, path, enabled)
}

/// The roots of the currently open project windows, read from the window
/// labels and the `?path=` query of their URLs.
pub(crate) fn opened_project_roots(app: &tauri::AppHandle) -> Vec<String> {
    use tauri::Manager;

    let urls = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(PROJECT_WINDOW_PREFIX))
        .filter_map(|(label, window)| match window.url() {
            Ok(url) => Some(url),
            Err(error) => {
                log::debug!("mise_project_window_url_failed label={label} error={error}");
                None
            }
        })
        .collect::<Vec<_>>();

    project_roots_from_windows(urls)
}

/// The distinct `path` query values of the given window URLs, sorted by their
/// lowercase form while keeping the original spelling for display.
pub(crate) fn project_roots_from_windows(
    urls: impl IntoIterator<Item = tauri::Url>,
) -> Vec<String> {
    let mut by_key: BTreeMap<String, String> = BTreeMap::new();

    for url in urls {
        let Some(path) = url
            .query_pairs()
            .find(|(key, _)| key == "path")
            .map(|(_, value)| value.into_owned())
        else {
            continue;
        };
        let trimmed = path.trim();
        if trimmed.is_empty() {
            continue;
        }
        by_key
            .entry(comparable(trimmed).to_lowercase())
            .or_insert_with(|| trimmed.to_string());
    }

    by_key.into_values().collect()
}

fn scan_dirs_lock() -> std::sync::MutexGuard<'static, ()> {
    SCAN_DIRS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn list_scan_dirs_at(file: &Path) -> MiseResult<Vec<MiseScanDirectory>> {
    read_scan_dirs(file)
}

fn read_scan_dirs(file: &Path) -> MiseResult<Vec<MiseScanDirectory>> {
    let bytes = match std::fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            log::warn!(
                "mise_scan_dirs_read_failed path={} error={error}",
                file.display()
            );
            return Err(MiseError::io("The scan directories could not be read."));
        }
    };

    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }

    let document = match serde_json::from_slice::<ScanDirectoriesDocument>(&bytes) {
        Ok(document) => document,
        Err(error) => {
            log::warn!(
                "mise_scan_dirs_decode_failed path={} error={error}",
                file.display()
            );
            let _ = paths::backup_existing(file);
            return Ok(Vec::new());
        }
    };

    let directories = document
        .directories
        .into_iter()
        .filter_map(|directory| {
            let path = normalize_path(&directory.path).ok()?;
            Some(MiseScanDirectory {
                path,
                enabled: directory.enabled,
            })
        })
        .collect();

    Ok(normalize_directories(directories))
}

fn write_scan_dirs(file: &Path, directories: &[MiseScanDirectory]) -> MiseResult<()> {
    let document = ScanDirectoriesDocument {
        version: SCAN_DIRS_VERSION,
        directories: directories.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&document).map_err(|error| {
        log::warn!("mise_scan_dirs_encode_failed error={error}");
        MiseError::internal("The scan directories could not be encoded.")
    })?;

    paths::atomic_write(file, &bytes)
}

fn add_scan_dir_at(file: &Path, raw: &str) -> MiseResult<Vec<MiseScanDirectory>> {
    let path = normalize_path(raw)?;

    let metadata = std::fs::metadata(&path).map_err(|error| {
        log::debug!("mise_scan_dir_metadata_failed path={path} error={error}");
        MiseError::invalid_input("path", "The scan directory does not exist.")
    })?;
    if !metadata.is_dir() {
        return Err(MiseError::invalid_input(
            "path",
            "The scan directory is not a folder.",
        ));
    }

    let mut directories = read_scan_dirs(file)?;
    if let Some(existing) = directories
        .iter_mut()
        .find(|entry| same_path(&entry.path, &path))
    {
        existing.path = path;
        existing.enabled = true;
    } else {
        if directories.len() >= MAX_SCAN_DIRS {
            return Err(MiseError::invalid_input(
                "path",
                "At most 50 scan directories can be added.",
            ));
        }
        directories.push(MiseScanDirectory {
            path,
            enabled: true,
        });
    }

    let normalized = normalize_directories(directories);
    write_scan_dirs(file, &normalized)?;
    Ok(normalized)
}

fn remove_scan_dir_at(file: &Path, raw: &str) -> MiseResult<Vec<MiseScanDirectory>> {
    let Ok(path) = normalize_path(raw) else {
        return read_scan_dirs(file);
    };

    let directories = read_scan_dirs(file)?;
    let current_len = directories.len();
    let next = directories
        .into_iter()
        .filter(|entry| !same_path(&entry.path, &path))
        .collect::<Vec<_>>();
    let normalized = normalize_directories(next);

    if normalized.len() == current_len {
        return Ok(normalized);
    }

    write_scan_dirs(file, &normalized)?;
    Ok(normalized)
}

fn set_scan_dir_enabled_at(
    file: &Path,
    raw: &str,
    enabled: bool,
) -> MiseResult<Vec<MiseScanDirectory>> {
    let path = normalize_path(raw)?;
    let mut directories = read_scan_dirs(file)?;

    let Some(entry) = directories
        .iter_mut()
        .find(|entry| same_path(&entry.path, &path))
    else {
        return Err(MiseError::not_found("The scan directory was not found."));
    };
    entry.enabled = enabled;

    let normalized = normalize_directories(directories);
    write_scan_dirs(file, &normalized)?;
    Ok(normalized)
}

/// The union of the open project roots and the enabled custom roots, deduped,
/// depth-sorted and folded so an enabled ancestor keeps its descendants out.
fn scan_roots(opened: &[String], directories: &[MiseScanDirectory]) -> Vec<String> {
    let mut entries = Vec::new();

    for path in opened {
        let trimmed = trim_trailing_separators(path);
        if !trimmed.is_empty() {
            entries.push(MiseScanDirectory {
                path: trimmed,
                enabled: true,
            });
        }
    }

    entries.extend(
        directories
            .iter()
            .filter(|directory| directory.enabled)
            .cloned(),
    );

    normalize_directories(entries)
        .into_iter()
        .map(|directory| directory.path)
        .collect()
}

/// `~` expansion, absolute path, forward slashes and no trailing separator
/// except on a drive root such as `C:/`.
fn normalize_path(raw: &str) -> MiseResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(MiseError::invalid_input(
            "path",
            "The scan directory path is empty.",
        ));
    }

    let expanded = expand_home(trimmed);
    let path = PathBuf::from(&expanded);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|error| {
                log::warn!("mise_scan_dir_current_dir_failed error={error}");
                MiseError::io("The current directory could not be resolved.")
            })?
            .join(path)
    };

    Ok(trim_trailing_separators(&absolute.to_string_lossy()))
}

fn expand_home(value: &str) -> String {
    expand_home_with(value, paths::home_dir())
}

fn expand_home_with(value: &str, home: Option<PathBuf>) -> String {
    let Some(rest) = value.strip_prefix('~') else {
        return value.to_string();
    };
    if !rest.is_empty() && !rest.starts_with('/') && !rest.starts_with('\\') {
        return value.to_string();
    }

    let Some(home) = home else {
        return value.to_string();
    };

    let tail = rest.trim_start_matches(['/', '\\']);
    if tail.is_empty() {
        trim_trailing_separators(&home.to_string_lossy())
    } else {
        trim_trailing_separators(&home.join(tail).to_string_lossy())
    }
}

fn trim_trailing_separators(value: &str) -> String {
    let mut normalized = value.replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') && !is_drive_root(&normalized) {
        normalized.pop();
    }
    normalized
}

fn is_drive_root(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

fn comparable(value: &str) -> String {
    let mut normalized = value.replace('\\', "/");
    while normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

fn same_path(left: &str, right: &str) -> bool {
    comparable(left) == comparable(right)
}

fn contains_path(parent: &str, child: &str) -> bool {
    let parent = comparable(parent);
    let child = comparable(child);
    if child == parent {
        return true;
    }
    if parent.is_empty() {
        return child.starts_with('/');
    }
    child.starts_with(&format!("{parent}/"))
}

fn path_depth(value: &str) -> usize {
    comparable(value)
        .split('/')
        .filter(|segment| !segment.is_empty())
        .count()
}

fn normalize_directories(directories: Vec<MiseScanDirectory>) -> Vec<MiseScanDirectory> {
    let mut deduped: BTreeMap<String, MiseScanDirectory> = BTreeMap::new();
    for directory in directories {
        let key = comparable(&directory.path);
        match deduped.get_mut(&key) {
            Some(existing) => existing.enabled |= directory.enabled,
            None => {
                deduped.insert(key, directory);
            }
        }
    }

    let mut sorted = deduped.into_values().collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        path_depth(&left.path)
            .cmp(&path_depth(&right.path))
            .then_with(|| left.path.to_lowercase().cmp(&right.path.to_lowercase()))
    });

    let mut kept: Vec<MiseScanDirectory> = Vec::new();
    for directory in sorted {
        let covered_by_enabled = kept
            .iter()
            .any(|existing| existing.enabled && contains_path(&existing.path, &directory.path));
        if covered_by_enabled {
            continue;
        }

        let covered_by_disabled = kept
            .iter()
            .any(|existing| !existing.enabled && contains_path(&existing.path, &directory.path));
        if covered_by_disabled && !directory.enabled {
            continue;
        }

        kept.push(directory);
    }

    kept
}

#[derive(Debug, Clone)]
struct DiscoveredProject {
    directory_path: String,
    primary_path: String,
    config_paths: Vec<String>,
}

#[derive(Debug, Clone)]
struct PreparedProject {
    directory_path: String,
    primary_path: String,
    config_paths: Vec<String>,
    contents: Vec<(String, String)>,
    last_modified_ms: Option<i64>,
}

struct RootDiscovery {
    root: String,
    missing: bool,
    projects: Vec<PreparedProject>,
}

fn discover_root(root: &str) -> RootDiscovery {
    let path = Path::new(root);
    if !path.is_dir() {
        return RootDiscovery {
            root: root.to_string(),
            missing: true,
            projects: Vec::new(),
        };
    }

    let projects = discover_projects(path)
        .iter()
        .filter_map(prepare_project)
        .collect();

    RootDiscovery {
        root: root.to_string(),
        missing: false,
        projects,
    }
}

/// Breadth-first search of one root: depth 3, 240 directories and 80 projects
/// at most, skipping dot directories and build output.
fn discover_projects(root: &Path) -> Vec<DiscoveredProject> {
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));

    let mut visited: HashSet<String> = HashSet::new();
    let mut projects = Vec::new();

    while let Some((directory, depth)) = queue.pop_front() {
        if visited.len() >= MAX_DIRECTORIES_PER_ROOT {
            break;
        }
        if !visited.insert(comparable(&directory.to_string_lossy())) {
            continue;
        }

        if let Some(project) = project_config(&directory) {
            projects.push(project);
            if projects.len() >= MAX_PROJECTS_PER_ROOT {
                break;
            }
        }

        if depth >= MAX_DEPTH {
            continue;
        }

        let mut children = child_directories(&directory);
        children.sort_by_key(|child| child.to_string_lossy().to_lowercase());
        for child in children {
            queue.push_back((child, depth + 1));
        }
    }

    projects.sort_by(|left, right| {
        left.directory_path
            .to_lowercase()
            .cmp(&right.directory_path.to_lowercase())
    });
    projects
}

fn project_config(directory: &Path) -> Option<DiscoveredProject> {
    let mut config_paths = Vec::new();

    for name in WORKSPACE_CONFIG_NAMES {
        let candidate = directory.join(name);
        if candidate.is_file() {
            config_paths.push(display_path(&candidate));
        }
    }

    let tool_versions = directory.join(TOOL_VERSIONS_FILE);
    if tool_versions.is_file() {
        config_paths.push(display_path(&tool_versions));
    }

    for (name, _) in SINGLE_TOOL_FILES {
        let candidate = directory.join(name);
        if candidate.is_file() {
            config_paths.push(display_path(&candidate));
        }
    }

    if config_paths.is_empty() {
        return None;
    }

    Some(DiscoveredProject {
        directory_path: display_path(directory),
        primary_path: config_paths[0].clone(),
        config_paths,
    })
}

fn child_directories(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };

    let mut children = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || IGNORED_DIRECTORIES.contains(&name.as_str()) {
            continue;
        }
        children.push(entry.path());
    }
    children
}

fn prepare_project(project: &DiscoveredProject) -> Option<PreparedProject> {
    let mut contents = Vec::new();
    let mut last_modified_ms: Option<i64> = None;

    for path in &project.config_paths {
        if let Some(timestamp) = modified_ms(path) {
            last_modified_ms =
                Some(last_modified_ms.map_or(timestamp, |current| current.max(timestamp)));
        }
        if let Ok(content) = std::fs::read_to_string(path) {
            contents.push((path.clone(), content));
        }
    }

    if contents.is_empty() {
        return None;
    }

    Some(PreparedProject {
        directory_path: project.directory_path.clone(),
        primary_path: project.primary_path.clone(),
        config_paths: project.config_paths.clone(),
        contents,
        last_modified_ms,
    })
}

fn modified_ms(path: &str) -> Option<i64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as i64)
}

#[derive(Debug, Clone)]
struct DeclaredTool {
    version: String,
    source_path: String,
}

fn project_declarations(prepared: &PreparedProject) -> BTreeMap<String, DeclaredTool> {
    let mut declarations: BTreeMap<String, DeclaredTool> = BTreeMap::new();

    for path in &prepared.config_paths {
        let Some(content) = prepared
            .contents
            .iter()
            .find(|(candidate, _)| candidate == path)
            .map(|(_, content)| content)
        else {
            continue;
        };

        for (tool, version) in declarations_for_file(path, content) {
            declarations.entry(tool).or_insert(DeclaredTool {
                version,
                source_path: path.clone(),
            });
        }
    }

    declarations
}

fn declarations_for_file(path: &str, content: &str) -> BTreeMap<String, String> {
    let name = file_name(path);

    if WORKSPACE_CONFIG_NAMES.contains(&name.as_str()) {
        return extract_section(content, "tools")
            .map(|section| parse_assignments(&section))
            .unwrap_or_default();
    }

    if name == TOOL_VERSIONS_FILE {
        return parse_tool_versions(content);
    }

    if let Some((_, tool)) = SINGLE_TOOL_FILES
        .iter()
        .find(|(candidate, _)| *candidate == name.as_str())
    {
        if let Some(version) = parse_single_version(content, tool) {
            return BTreeMap::from([(tool.to_string(), version)]);
        }
    }

    BTreeMap::new()
}

fn parse_tool_versions(content: &str) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();

    for line in content.lines() {
        let trimmed = strip_inline_comment(line).trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut parts = trimmed.split_whitespace();
        let Some(raw_tool) = parts.next() else {
            continue;
        };
        let Some(raw_version) = parts.next() else {
            continue;
        };

        let tool = normalize_tool_name(raw_tool);
        if tool.is_empty() {
            continue;
        }
        let version = normalize_version_for_tool(&tool, raw_version);
        if version.is_empty() {
            continue;
        }

        result.entry(tool).or_insert(version);
    }

    result
}

fn parse_single_version(content: &str, tool: &str) -> Option<String> {
    for line in content.lines() {
        let version = strip_inline_comment(line).trim();
        if version.is_empty() {
            continue;
        }
        return Some(normalize_version_for_tool(tool, version));
    }
    None
}

fn strip_inline_comment(line: &str) -> &str {
    match line.find('#') {
        Some(index) => &line[..index],
        None => line,
    }
}

fn normalize_tool_name(tool: &str) -> String {
    match tool.trim().to_lowercase().as_str() {
        "nodejs" => "node".to_string(),
        "golang" => "go".to_string(),
        other => other.to_string(),
    }
}

fn normalize_version_for_tool(tool: &str, version: &str) -> String {
    let trimmed = version.trim();
    if tool == "node" {
        if let Some(rest) = trimmed.strip_prefix('v') {
            if rest
                .chars()
                .next()
                .map_or(false, |character| character.is_ascii_digit())
            {
                return rest.to_string();
            }
        }
    }
    trimmed.to_string()
}

fn file_name(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn read_global_tools() -> BTreeMap<String, String> {
    let Some(path) = paths::global_config_path() else {
        return BTreeMap::new();
    };
    let Ok(content) = std::fs::read_to_string(&path) else {
        return BTreeMap::new();
    };

    extract_section(&content, "tools")
        .map(|section| parse_assignments(&section))
        .unwrap_or_default()
}

#[derive(Debug, Clone)]
struct ActiveVersion {
    version: Option<String>,
    requested_version: Option<String>,
}

enum ActiveVersionOutcome {
    Ready(BTreeMap<String, ActiveVersion>),
    Failed {
        issue: MiseProjectScanIssue,
        missing_mise: bool,
        message: Option<String>,
    },
}

async fn read_active_versions(directory: &Path) -> ActiveVersionOutcome {
    let args = vec!["ls".to_string(), "--json".to_string()];

    match process::run_command(&args, Some(directory), LS_TIMEOUT, true, None, None).await {
        Ok(result) if result.exit_code == 0 => match parse_active_versions(&result.stdout) {
            Some(versions) => ActiveVersionOutcome::Ready(versions),
            None => {
                log::warn!("mise_project_ls_decode_failed path={}", directory.display());
                ActiveVersionOutcome::Failed {
                    issue: MiseProjectScanIssue::Unavailable,
                    missing_mise: false,
                    message: None,
                }
            }
        },
        Ok(result) => {
            let stderr = result.stderr.to_lowercase();
            ActiveVersionOutcome::Failed {
                issue: if stderr.contains("not trusted") {
                    MiseProjectScanIssue::NotTrusted
                } else {
                    MiseProjectScanIssue::Unavailable
                },
                missing_mise: false,
                message: None,
            }
        }
        Err(error) => ActiveVersionOutcome::Failed {
            issue: MiseProjectScanIssue::Unavailable,
            missing_mise: error.code == MiseErrorCode::MiseNotFound,
            message: Some(error.message),
        },
    }
}

fn parse_active_versions(stdout: &str) -> Option<BTreeMap<String, ActiveVersion>> {
    let value: serde_json::Value = serde_json::from_str(stdout).ok()?;
    let object = value.as_object()?;
    let mut versions = BTreeMap::new();

    for (tool, entries) in object {
        let Some(entries) = entries.as_array() else {
            continue;
        };
        let Some(active) = entries.iter().find(|entry| {
            entry
                .get("active")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        }) else {
            continue;
        };

        versions.insert(
            tool.clone(),
            ActiveVersion {
                version: active
                    .get("version")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                requested_version: active
                    .get("requested_version")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
            },
        );
    }

    Some(versions)
}

fn build_project(
    prepared: &PreparedProject,
    scan_root_path: &str,
    global_tools: &BTreeMap<String, String>,
    active_versions: Option<&BTreeMap<String, ActiveVersion>>,
    scan_issue: Option<MiseProjectScanIssue>,
) -> Option<MiseProject> {
    if prepared.contents.is_empty() {
        return None;
    }

    let declarations = project_declarations(prepared);

    let mut tool_names: BTreeSet<String> = declarations.keys().cloned().collect();
    if let Some(active_versions) = active_versions {
        tool_names.extend(active_versions.keys().cloned());
    }

    let mut bindings = Vec::new();
    let mut declared_tool_count = 0;
    let mut override_count = 0;
    let mut project_only_tool_count = 0;

    for name in tool_names {
        let declared = declarations.get(&name);
        let active = active_versions.and_then(|versions| versions.get(&name));
        let declared_in_project = declared.is_some();
        let declared_in_global = global_tools.contains_key(&name);

        if declared_in_project {
            declared_tool_count += 1;
        }
        if declared_in_project && !declared_in_global {
            project_only_tool_count += 1;
        }

        let project_version = declared
            .map(|declared| declared.version.clone())
            .or_else(|| active.and_then(|active| active.requested_version.clone()))
            .or_else(|| active.and_then(|active| active.version.clone()))
            .unwrap_or_else(|| NOT_SET.to_string());
        let global_version = global_tools
            .get(&name)
            .cloned()
            .unwrap_or_else(|| NOT_SET.to_string());
        let overrides_global =
            declared_in_project && declared_in_global && project_version != global_version;
        if overrides_global {
            override_count += 1;
        }

        let source = if let Some(declared) = declared {
            if WORKSPACE_CONFIG_NAMES.contains(&file_name(&declared.source_path).as_str()) {
                MiseBindingSource::Project
            } else {
                MiseBindingSource::ProjectFile
            }
        } else if declared_in_global {
            MiseBindingSource::Global
        } else if active.is_some() {
            MiseBindingSource::Resolved
        } else {
            MiseBindingSource::Inherited
        };

        bindings.push(MiseProjectBinding {
            name,
            project_version,
            global_version,
            source,
            source_file: declared.map(|declared| file_name(&declared.source_path)),
            declared_in_project,
            declared_in_global,
            overrides_global,
        });
    }

    let notes = if override_count > 0 {
        MiseProjectNotes::Overrides
    } else if project_only_tool_count > 0 {
        MiseProjectNotes::ProjectOnly
    } else if declared_tool_count == 0 {
        MiseProjectNotes::None
    } else {
        MiseProjectNotes::Consistent
    };

    let level = if scan_issue.is_some() || override_count > 0 {
        MiseHealthLevel::Warning
    } else {
        MiseHealthLevel::Healthy
    };

    let mut command_preview = String::from("mise current\nmise ls --json");
    for path in &prepared.config_paths {
        command_preview.push_str(&format!("\ncat {path}"));
    }

    Some(MiseProject {
        name: file_name(&prepared.directory_path),
        path: prepared.directory_path.clone(),
        scan_root_path: scan_root_path.to_string(),
        config_path: prepared.primary_path.clone(),
        config_paths: prepared.config_paths.clone(),
        tools: declarations.keys().cloned().collect(),
        last_modified_ms: prepared.last_modified_ms,
        command_preview,
        bindings,
        level,
        declared_tool_count,
        override_count,
        project_only_tool_count,
        notes,
        scan_issue,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEST_COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let unique = format!(
                "mise-projects-{}-{}-{}",
                std::process::id(),
                tag,
                TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn write(&self, relative: &str, content: &str) -> PathBuf {
            let path = self.path.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&path, content).unwrap();
            path
        }

        fn mkdir(&self, relative: &str) -> PathBuf {
            let path = self.path.join(relative);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn directory(path: &str, enabled: bool) -> MiseScanDirectory {
        MiseScanDirectory {
            path: path.to_string(),
            enabled,
        }
    }

    #[test]
    fn expand_home_handles_the_home_prefix() {
        let home = Some(PathBuf::from("C:/Users/test"));

        assert_eq!(
            expand_home_with("~/Projects", home.clone()),
            "C:/Users/test/Projects"
        );
        assert_eq!(expand_home_with("~", home.clone()), "C:/Users/test");
        assert_eq!(expand_home_with("~other/Projects", home), "~other/Projects");
    }

    #[test]
    fn trims_trailing_separators_but_keeps_a_drive_root() {
        assert_eq!(
            trim_trailing_separators("D:\\Work\\Projects\\"),
            "D:/Work/Projects"
        );
        assert_eq!(trim_trailing_separators("D:\\"), "D:/");
        assert_eq!(trim_trailing_separators("/opt/projects//"), "/opt/projects");
    }

    #[test]
    fn normalize_rejects_an_empty_path() {
        let error = normalize_path("   ").unwrap_err();
        assert_eq!(error.code, MiseErrorCode::InvalidInput);
    }

    #[test]
    fn normalize_keeps_an_absolute_path_without_its_trailing_separator() {
        let temp = TempDir::new("normalize-path");
        let value = format!("{}/", display_path(&temp.path));

        assert_eq!(normalize_path(&value).unwrap(), display_path(&temp.path));
    }

    #[test]
    fn normalization_dedupes_and_folds_enabled_ancestors() {
        let normalized = normalize_directories(vec![
            directory("D:/Projects", true),
            directory("D:/Projects/App", true),
            directory("D:/Projects/App", true),
            directory("E:/Tools", false),
        ]);

        let paths = normalized
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["D:/Projects", "E:/Tools"]);
    }

    #[test]
    fn a_disabled_ancestor_keeps_an_enabled_child() {
        let normalized = normalize_directories(vec![
            directory("D:/Projects", false),
            directory("D:/Projects/App", true),
        ]);

        let paths = normalized
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["D:/Projects", "D:/Projects/App"]);
    }

    #[test]
    fn a_disabled_ancestor_folds_a_disabled_child() {
        let normalized = normalize_directories(vec![
            directory("D:/Projects", false),
            directory("D:/Projects/App", false),
        ]);

        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].path, "D:/Projects");
    }

    #[test]
    fn scan_directories_round_trip() {
        let temp = TempDir::new("scan-round-trip");
        let file = temp.path.join("scan_dirs.json");
        let alpha = temp.mkdir("alpha");
        let beta = temp.mkdir("beta");

        let added = add_scan_dir_at(&file, &display_path(&alpha)).unwrap();
        assert_eq!(added.len(), 1);
        assert!(added[0].enabled);

        let more = add_scan_dir_at(&file, &display_path(&beta)).unwrap();
        assert_eq!(more.len(), 2);

        let disabled = set_scan_dir_enabled_at(&file, &display_path(&alpha), false).unwrap();
        let alpha_entry = disabled
            .iter()
            .find(|entry| entry.path.ends_with("/alpha"))
            .unwrap();
        assert!(!alpha_entry.enabled);

        let removed = remove_scan_dir_at(&file, &display_path(&alpha)).unwrap();
        assert_eq!(removed.len(), 1);

        let missing = remove_scan_dir_at(&file, &display_path(&alpha)).unwrap();
        assert_eq!(missing.len(), 1);

        let error = set_scan_dir_enabled_at(&file, &display_path(&alpha), true).unwrap_err();
        assert_eq!(error.code, MiseErrorCode::NotFound);
    }

    #[test]
    fn adding_a_child_of_an_enabled_root_folds_it() {
        let temp = TempDir::new("scan-fold");
        let file = temp.path.join("scan_dirs.json");
        let root = temp.mkdir("root");
        let child = temp.mkdir("root/child");

        add_scan_dir_at(&file, &display_path(&root)).unwrap();
        let normalized = add_scan_dir_at(&file, &display_path(&child)).unwrap();

        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].path, display_path(&root));
    }

    #[test]
    fn adding_to_a_disabled_root_keeps_the_enabled_child() {
        let temp = TempDir::new("scan-disabled-root");
        let file = temp.path.join("scan_dirs.json");
        let root = temp.mkdir("root");
        let child = temp.mkdir("root/child");

        add_scan_dir_at(&file, &display_path(&root)).unwrap();
        set_scan_dir_enabled_at(&file, &display_path(&root), false).unwrap();
        let normalized = add_scan_dir_at(&file, &display_path(&child)).unwrap();

        assert_eq!(normalized.len(), 2);
    }

    #[test]
    fn adding_an_invalid_directory_is_rejected() {
        let temp = TempDir::new("scan-invalid");
        let file = temp.path.join("scan_dirs.json");

        let empty = add_scan_dir_at(&file, "  ").unwrap_err();
        assert_eq!(empty.code, MiseErrorCode::InvalidInput);

        let absent = temp.path.join("absent");
        let missing = add_scan_dir_at(&file, &display_path(&absent)).unwrap_err();
        assert_eq!(missing.code, MiseErrorCode::InvalidInput);

        let plain_file = temp.write("plain.txt", "text");
        let not_a_folder = add_scan_dir_at(&file, &display_path(&plain_file)).unwrap_err();
        assert_eq!(not_a_folder.code, MiseErrorCode::InvalidInput);
    }

    #[test]
    fn adding_beyond_the_limit_is_rejected() {
        let temp = TempDir::new("scan-limit");
        let file = temp.path.join("scan_dirs.json");
        let mut directories = Vec::new();

        for index in 0..MAX_SCAN_DIRS {
            let path = temp.mkdir(&format!("root-{index}"));
            directories.push(directory(&display_path(&path), true));
        }
        write_scan_dirs(&file, &directories).unwrap();

        let extra = temp.mkdir("extra");
        let error = add_scan_dir_at(&file, &display_path(&extra)).unwrap_err();
        assert_eq!(error.code, MiseErrorCode::InvalidInput);
    }

    #[test]
    fn a_missing_store_is_empty() {
        let temp = TempDir::new("scan-missing");
        let file = temp.path.join("scan_dirs.json");

        assert!(list_scan_dirs_at(&file).unwrap().is_empty());
    }

    #[test]
    fn a_corrupted_store_is_backed_up_and_starts_empty() {
        let temp = TempDir::new("scan-corrupt");
        let file = temp.path.join("scan_dirs.json");
        std::fs::write(&file, "{ not json").unwrap();

        assert!(list_scan_dirs_at(&file).unwrap().is_empty());

        let backed_up = std::fs::read_dir(&temp.path)
            .unwrap()
            .flatten()
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("scan_dirs.json.bak-")
            });
        assert!(backed_up);
    }

    #[test]
    fn discovers_projects_and_skips_noise() {
        let temp = TempDir::new("discover");
        temp.write("app/mise.toml", "[tools]\nnode = \"20\"\n");
        temp.write("app/sub/.node-version", "v18.2.0\n");
        temp.write("lib/.tool-versions", "python 3.12.1\n");
        temp.write("node_modules/pkg/mise.toml", "[tools]\nnode = \"1\"\n");
        temp.write(".hidden/mise.toml", "[tools]\nnode = \"1\"\n");
        temp.write("a/b/c/mise.toml", "[tools]\ngo = \"1.22\"\n");
        temp.write("a/b/c/d/mise.toml", "[tools]\ngo = \"1.22\"\n");

        let projects = discover_projects(&temp.path);

        assert_eq!(projects.len(), 4);
        assert!(projects
            .iter()
            .any(|project| project.directory_path.ends_with("/app/sub")));
        assert!(projects
            .iter()
            .any(|project| project.directory_path.ends_with("/a/b/c")));
        assert!(!projects
            .iter()
            .any(|project| project.directory_path.ends_with("/a/b/c/d")));
        assert!(!projects
            .iter()
            .any(|project| project.directory_path.contains("node_modules")));
        assert!(!projects
            .iter()
            .any(|project| project.directory_path.contains(".hidden")));
    }

    #[test]
    fn records_config_paths_in_priority_order() {
        let temp = TempDir::new("discover-order");
        temp.write("project/mise.toml", "");
        temp.write("project/.mise.local.toml", "");
        temp.write("project/.tool-versions", "");
        temp.write("project/.node-version", "");

        let projects = discover_projects(&temp.path);
        let project = projects
            .iter()
            .find(|project| project.directory_path.ends_with("/project"))
            .unwrap();

        assert_eq!(project.primary_path, project.config_paths[0]);
        let names = project
            .config_paths
            .iter()
            .map(|path| file_name(path))
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "mise.toml".to_string(),
                ".mise.local.toml".to_string(),
                ".tool-versions".to_string(),
                ".node-version".to_string()
            ]
        );
    }

    #[test]
    fn parses_tool_versions_with_aliases_and_comments() {
        let parsed =
            parse_tool_versions("nodejs 20.1.0\n# comment\ngolang 1.22.3 # inline\nbroken\n");

        assert_eq!(parsed.get("node").map(String::as_str), Some("20.1.0"));
        assert_eq!(parsed.get("go").map(String::as_str), Some("1.22.3"));
        assert!(!parsed.contains_key("broken"));
    }

    #[test]
    fn parses_single_version_files_and_strips_the_node_prefix() {
        assert_eq!(
            parse_single_version("# comment\nv20.1.0\n", "node").as_deref(),
            Some("20.1.0")
        );
        assert_eq!(
            parse_single_version("\n  18.19.0  \n", "node").as_deref(),
            Some("18.19.0")
        );
        assert_eq!(parse_single_version("", "node"), None);
    }

    #[test]
    fn parses_the_tools_section_of_a_mise_file() {
        let parsed = declarations_for_file(
            "mise.toml",
            "[tools]\nnode = \"20.1.0\"\n\"python\" = '3.12'\n[settings]\nhttp_retries = 3\n",
        );

        assert_eq!(parsed.get("node").map(String::as_str), Some("20.1.0"));
        assert_eq!(parsed.get("python").map(String::as_str), Some("3.12"));
        assert_eq!(parsed.len(), 2);
    }

    #[test]
    fn project_declarations_keep_the_first_file_that_declares_a_tool() {
        let temp = TempDir::new("declarations");
        let mise = temp.write("project/mise.toml", "[tools]\nnode = \"20\"\n");
        let node_version = temp.write("project/.node-version", "18\n");
        let prepared = PreparedProject {
            directory_path: display_path(&temp.path.join("project")),
            primary_path: display_path(&mise),
            config_paths: vec![display_path(&mise), display_path(&node_version)],
            contents: vec![
                (display_path(&mise), std::fs::read_to_string(&mise).unwrap()),
                (
                    display_path(&node_version),
                    std::fs::read_to_string(&node_version).unwrap(),
                ),
            ],
            last_modified_ms: None,
        };

        let declarations = project_declarations(&prepared);

        assert_eq!(
            declarations
                .get("node")
                .map(|declared| declared.version.as_str()),
            Some("20")
        );
        assert_eq!(file_name(&declarations["node"].source_path), "mise.toml");
    }

    #[test]
    fn builds_bindings_with_overrides_and_sources() {
        let temp = TempDir::new("bindings");
        temp.write(
            "proj/mise.toml",
            "[tools]\nnode = \"20\"\npython = \"3.11\"\n",
        );
        temp.write("proj/.node-version", "18\n");

        let discovered = discover_projects(&temp.path);
        let project = discovered
            .iter()
            .find(|project| project.directory_path.ends_with("/proj"))
            .unwrap();
        let prepared = prepare_project(project).unwrap();

        let global_tools = BTreeMap::from([
            ("node".to_string(), "22".to_string()),
            ("java".to_string(), "21".to_string()),
        ]);
        let active = BTreeMap::from([
            (
                "node".to_string(),
                ActiveVersion {
                    version: Some("20.1.0".to_string()),
                    requested_version: Some("20".to_string()),
                },
            ),
            (
                "java".to_string(),
                ActiveVersion {
                    version: Some("21.0.2".to_string()),
                    requested_version: None,
                },
            ),
        ]);

        let built = build_project(
            &prepared,
            "/roots/projects",
            &global_tools,
            Some(&active),
            None,
        )
        .unwrap();

        assert_eq!(built.name, "proj");
        assert_eq!(built.scan_root_path, "/roots/projects");
        assert_eq!(built.tools, vec!["node".to_string(), "python".to_string()]);
        assert_eq!(built.declared_tool_count, 2);
        assert_eq!(built.override_count, 1);
        assert_eq!(built.project_only_tool_count, 1);
        assert_eq!(built.notes, MiseProjectNotes::Overrides);
        assert_eq!(built.level, MiseHealthLevel::Warning);
        assert!(built.last_modified_ms.is_some());
        assert!(built.command_preview.contains("mise current"));
        assert!(built.command_preview.contains("cat "));

        let node = built
            .bindings
            .iter()
            .find(|binding| binding.name == "node")
            .unwrap();
        assert_eq!(node.project_version, "20");
        assert_eq!(node.global_version, "22");
        assert_eq!(node.source, MiseBindingSource::Project);
        assert_eq!(node.source_file.as_deref(), Some("mise.toml"));
        assert!(node.declared_in_project);
        assert!(node.declared_in_global);
        assert!(node.overrides_global);

        let python = built
            .bindings
            .iter()
            .find(|binding| binding.name == "python")
            .unwrap();
        assert_eq!(python.project_version, "3.11");
        assert_eq!(python.global_version, NOT_SET);
        assert_eq!(python.source, MiseBindingSource::Project);
        assert!(!python.declared_in_global);
        assert!(!python.overrides_global);

        let java = built
            .bindings
            .iter()
            .find(|binding| binding.name == "java")
            .unwrap();
        assert_eq!(java.project_version, "21.0.2");
        assert_eq!(java.source, MiseBindingSource::Global);
        assert_eq!(java.source_file, None);
    }

    #[test]
    fn notes_are_none_without_declarations() {
        let temp = TempDir::new("notes-none");
        temp.write("proj/mise.toml", "[settings]\nhttp_retries = 3\n");
        let discovered = discover_projects(&temp.path);
        let prepared = prepare_project(&discovered[0]).unwrap();
        let active = BTreeMap::from([(
            "ruby".to_string(),
            ActiveVersion {
                version: Some("3.3.0".to_string()),
                requested_version: None,
            },
        )]);

        let built = build_project(
            &prepared,
            display_path(&temp.path).as_str(),
            &BTreeMap::new(),
            Some(&active),
            None,
        )
        .unwrap();

        assert_eq!(built.notes, MiseProjectNotes::None);
        assert_eq!(built.level, MiseHealthLevel::Healthy);
        let ruby = built
            .bindings
            .iter()
            .find(|binding| binding.name == "ruby")
            .unwrap();
        assert_eq!(ruby.source, MiseBindingSource::Resolved);
        assert_eq!(ruby.project_version, "3.3.0");
    }

    #[test]
    fn notes_are_consistent_when_declarations_match_global() {
        let temp = TempDir::new("notes-consistent");
        temp.write("proj/mise.toml", "[tools]\nnode = \"20\"\n");
        let discovered = discover_projects(&temp.path);
        let prepared = prepare_project(&discovered[0]).unwrap();
        let global_tools = BTreeMap::from([("node".to_string(), "20".to_string())]);

        let built = build_project(
            &prepared,
            display_path(&temp.path).as_str(),
            &global_tools,
            None,
            None,
        )
        .unwrap();

        assert_eq!(built.notes, MiseProjectNotes::Consistent);
        assert_eq!(built.override_count, 0);
        assert_eq!(built.level, MiseHealthLevel::Healthy);
    }

    #[test]
    fn parses_open_project_window_urls() {
        let urls = vec![
            tauri::Url::parse("tauri://localhost/project-window?path=D%3A%2FWork%2FBeta").unwrap(),
            tauri::Url::parse("tauri://localhost/project-window?path=D%3A%2FWork%2Falpha").unwrap(),
            tauri::Url::parse("tauri://localhost/project-window?path=D%3A%2FWork%2Falpha").unwrap(),
            tauri::Url::parse("tauri://localhost/project-window?other=1").unwrap(),
        ];

        assert_eq!(
            project_roots_from_windows(urls),
            vec!["D:/Work/alpha".to_string(), "D:/Work/Beta".to_string()]
        );
    }

    #[test]
    fn parses_active_versions_from_the_list_output() {
        let stdout = r#"{
            "node": [
                {"version": "18.0.0", "requested_version": "18", "active": false},
                {"version": "20.1.0", "requested_version": "20", "active": true}
            ],
            "python": [
                {"version": "3.12.0", "active": false}
            ]
        }"#;

        let parsed = parse_active_versions(stdout).unwrap();

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed["node"].version.as_deref(), Some("20.1.0"));
        assert_eq!(parsed["node"].requested_version.as_deref(), Some("20"));
    }

    #[test]
    #[ignore = "scans a real directory; set MISE_PROJECT_SCAN_ROOT to run it"]
    fn discovers_a_real_directory() {
        let root =
            std::env::var("MISE_PROJECT_SCAN_ROOT").expect("MISE_PROJECT_SCAN_ROOT must be set");
        let projects = discover_projects(Path::new(&root));
        let paths = projects
            .iter()
            .map(|project| project.directory_path.as_str())
            .collect::<Vec<_>>();

        println!("{paths:#?}");
        assert!(!paths.is_empty());
    }
}
