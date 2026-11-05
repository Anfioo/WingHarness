//! `recent.json`: the documents opened lately, newest first.
//!
//! Missing files are only flagged, never dropped: the user may have the file on
//! a drive that is currently unplugged, and the UI decides what to prune.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::MdEditorResult;
use crate::models::{MdRecentEntry, MdRecentList};
use crate::paths;
use crate::store::{load_json, save_json};

/// Keeps the empty-state menu readable.
pub const MAX_RECENT_ENTRIES: usize = 30;

/// Read the list, flagging entries whose file is gone.
pub fn list() -> MdEditorResult<MdRecentList> {
    let path = paths::recent_path()?;
    Ok(with_missing(load_json::<MdRecentList>(&path)))
}

/// Move `path` to the front of the list, deduplicated.
pub fn add(path: &str) -> MdEditorResult<MdRecentList> {
    let storage = paths::recent_path()?;
    let mut entries = load_json::<MdRecentList>(&storage).entries;
    entries.retain(|entry| entry.path != path);
    entries.insert(
        0,
        MdRecentEntry {
            path: path.to_owned(),
            name: display_name(path),
            opened_at: now_seconds(),
            missing: false,
        },
    );
    entries.truncate(MAX_RECENT_ENTRIES);

    let list = MdRecentList { entries };
    save_json(&storage, &list)?;
    Ok(with_missing(list))
}

/// Drop one path from the list. Removing an absent path is not an error.
pub fn remove(path: &str) -> MdEditorResult<MdRecentList> {
    let storage = paths::recent_path()?;
    let mut entries = load_json::<MdRecentList>(&storage).entries;
    entries.retain(|entry| entry.path != path);

    let list = MdRecentList { entries };
    save_json(&storage, &list)?;
    Ok(with_missing(list))
}

fn with_missing(list: MdRecentList) -> MdRecentList {
    MdRecentList {
        entries: list
            .entries
            .into_iter()
            .map(|mut entry| {
                entry.missing = !Path::new(&entry.path).exists();
                entry
            })
            .collect(),
    }
}

fn display_name(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_owned())
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}
