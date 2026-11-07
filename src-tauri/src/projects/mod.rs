//! The multi-project store: which projects were opened and which one is active.
//!
//! The app no longer has a single project root in `config.json`. Like Git and
//! SVN, it has a picker that remembers what the user opened, and each opened
//! project is its own window carrying its own root. This module is that list —
//! `<data dir>/projects.json`, next to `config.json` — so it moves with the data
//! directory like every other piece of state.
//!
//! Deliberately plain `std` + `serde_json` with no Tauri handle, so it stays
//! usable from tests.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const FILE_NAME: &str = "projects.json";

/// How many projects the picker remembers. Entries fall off the end rather
/// than growing the file without bound.
const MAX_RECENT: usize = 50;

/// One row of the picker's "recent projects" list.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectEntry {
    /// The root exactly as the user opened it.
    pub path: String,
    /// The folder name, shown as the row's title.
    pub name: String,
    /// Milliseconds since the Unix epoch, for ordering.
    pub opened_at: u64,
}

impl Default for ProjectEntry {
    fn default() -> Self {
        Self {
            path: String::new(),
            name: String::new(),
            opened_at: 0,
        }
    }
}

/// The persisted document. `active` is the project the pages that are not tied
/// to a window (the picker, a page's selector) last worked on.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Projects {
    pub active: String,
    pub recent: Vec<ProjectEntry>,
}

/// Filesystem name of the store, resolved through the data directory.
pub fn path() -> PathBuf {
    crate::config::dir().join(FILE_NAME)
}

/// Paths that differ only by separator, trailing slash or case name the same
/// project on Windows, and must therefore dedupe to one entry.
fn project_key(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// The folder name, or the whole path when it has no final component.
fn project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Reads the store, falling back to an empty list for anything unreadable.
///
/// Never fails: a missing or corrupt file must not stop the app from starting.
pub fn load() -> Projects {
    load_at(&path())
}

pub(crate) fn load_at(file: &Path) -> Projects {
    fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Projects>(&bytes).ok())
        .unwrap_or_default()
}

/// Persists the store atomically, the same temp-file-and-rename dance
/// `config::save` uses.
pub fn save(projects: &Projects) -> Result<(), String> {
    save_at(&path(), projects)
}

pub(crate) fn save_at(file: &Path, projects: &Projects) -> Result<(), String> {
    let dir = file.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)
        .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;

    let json = serde_json::to_vec_pretty(projects)
        .map_err(|error| format!("Failed to serialize projects: {error}"))?;

    let temp = file.with_extension("json.tmp");
    {
        let mut handle = fs::File::create(&temp)
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        handle
            .write_all(&json)
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        handle
            .sync_all()
            .map_err(|error| format!("Failed to flush {}: {error}", temp.display()))?;
    }
    fs::rename(&temp, file)
        .map_err(|error| format!("Failed to replace {}: {error}", file.display()))
}

/// Records an open: the project moves to the top of the list and becomes the
/// active one. Returns the updated document so the caller need not re-read it.
pub fn remember(root: &str) -> Result<Projects, String> {
    remember_at(&path(), root)
}

pub(crate) fn remember_at(file: &Path, root: &str) -> Result<Projects, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("A project path is required.".to_string());
    }
    let key = project_key(root);
    let mut projects = load_at(file);
    projects.recent.retain(|entry| project_key(&entry.path) != key);
    projects.recent.insert(
        0,
        ProjectEntry {
            path: root.to_string(),
            name: project_name(root),
            opened_at: now_millis(),
        },
    );
    projects.recent.truncate(MAX_RECENT);
    projects.active = root.to_string();
    save_at(file, &projects)?;
    Ok(projects)
}

/// Drops a project from the list. Returns the updated document. If it was the
/// active one, the newest remaining entry takes over — or nothing, when the
/// list is now empty.
pub fn forget(root: &str) -> Result<Projects, String> {
    forget_at(&path(), root)
}

pub(crate) fn forget_at(file: &Path, root: &str) -> Result<Projects, String> {
    let key = project_key(root.trim());
    let mut projects = load_at(file);
    projects.recent.retain(|entry| project_key(&entry.path) != key);
    if project_key(&projects.active) == key {
        projects.active = projects
            .recent
            .first()
            .map(|entry| entry.path.clone())
            .unwrap_or_default();
    }
    save_at(file, &projects)?;
    Ok(projects)
}

/// Switches the active project without reordering the list.
pub fn set_active(root: &str) -> Result<Projects, String> {
    set_active_at(&path(), root)
}

pub(crate) fn set_active_at(file: &Path, root: &str) -> Result<Projects, String> {
    let root = root.trim();
    let mut projects = load_at(file);
    if project_key(&projects.active) == project_key(root) {
        return Ok(projects);
    }
    projects.active = root.to_string();
    save_at(file, &projects)?;
    Ok(projects)
}

/// The active project's path, or `None` when nothing has been opened yet.
pub fn active() -> Option<String> {
    let projects = load();
    let root = projects.active.trim();
    (!root.is_empty()).then(|| root.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch file that removes itself, so the tests never touch the real
    /// data directory.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "wingharness-projects-{tag}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir.join(FILE_NAME))
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = fs::remove_dir_all(dir);
            }
        }
    }

    #[test]
    fn remembering_prepends_and_sets_active() {
        let scratch = Scratch::new("remember");
        let first = remember_at(&scratch.0, r"M:\work\one").unwrap();
        assert_eq!(first.active, r"M:\work\one");
        assert_eq!(first.recent[0].name, "one");

        let second = remember_at(&scratch.0, r"M:\work\two").unwrap();
        assert_eq!(second.active, r"M:\work\two");
        assert_eq!(second.recent[0].path, r"M:\work\two");
        assert_eq!(second.recent[1].path, r"M:\work\one");

        // Re-opening the first moves it back to the front without duplicating.
        let again = remember_at(&scratch.0, r"M:\work\one").unwrap();
        assert_eq!(again.recent.len(), 2);
        assert_eq!(again.recent[0].path, r"M:\work\one");
        assert_eq!(again.active, r"M:\work\one");
    }

    #[test]
    fn separators_trailing_slash_and_case_dedupe() {
        let scratch = Scratch::new("dedupe");
        remember_at(&scratch.0, r"M:\Work\Project").unwrap();
        let projects = remember_at(&scratch.0, "m:/work/project/").unwrap();
        assert_eq!(projects.recent.len(), 1);
        assert_eq!(projects.recent[0].path, "m:/work/project/");
    }

    #[test]
    fn forgetting_falls_back_to_the_newest_remaining() {
        let scratch = Scratch::new("forget");
        remember_at(&scratch.0, r"M:\work\one").unwrap();
        remember_at(&scratch.0, r"M:\work\two").unwrap();

        let projects = forget_at(&scratch.0, r"M:\work\two").unwrap();
        assert_eq!(projects.recent.len(), 1);
        assert_eq!(projects.active, r"M:\work\one");

        let empty = forget_at(&scratch.0, r"M:\work\one").unwrap();
        assert!(empty.recent.is_empty());
        assert_eq!(empty.active, "");
    }

    #[test]
    fn the_list_is_capped() {
        let scratch = Scratch::new("cap");
        for index in 0..(MAX_RECENT + 5) {
            remember_at(&scratch.0, &format!(r"M:\work\{index}")).unwrap();
        }
        let projects = load_at(&scratch.0);
        assert_eq!(projects.recent.len(), MAX_RECENT);
        assert_eq!(projects.recent[0].path, format!(r"M:\work\{}", MAX_RECENT + 4));
    }

    #[test]
    fn setting_active_keeps_the_order() {
        let scratch = Scratch::new("active");
        remember_at(&scratch.0, r"M:\work\one").unwrap();
        remember_at(&scratch.0, r"M:\work\two").unwrap();

        let projects = set_active_at(&scratch.0, r"M:\work\one").unwrap();
        assert_eq!(projects.active, r"M:\work\one");
        assert_eq!(projects.recent[0].path, r"M:\work\two");
    }

    #[test]
    fn corrupt_or_missing_files_read_as_empty() {
        let scratch = Scratch::new("corrupt");
        assert_eq!(load_at(&scratch.0), Projects::default());
        fs::write(&scratch.0, b"not json").unwrap();
        assert_eq!(load_at(&scratch.0), Projects::default());
    }

    #[test]
    fn a_blank_path_is_refused() {
        let scratch = Scratch::new("blank");
        assert!(remember_at(&scratch.0, "   ").is_err());
    }
}
