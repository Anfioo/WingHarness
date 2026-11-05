//! The feature's own data directory.
//!
//! Everything the SVN workspace persists — the recent-working-copy list and the
//! status snapshot cache — lives under `<data dir>/.svn-workspace`, resolved once
//! at startup by the root crate, next to `ccs/`, `.git-repo/` and `.api-client/`.
//! Keeping it in one directory is what makes the whole thing migratable: copy
//! the data directory to another machine and nothing has been left behind in Web
//! storage or the app config root.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::error::{SvnError, SvnResult};

/// Set once, from the root crate's `setup`, to `config::dir()/.svn-workspace`.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the data directory, creating it on first use.
pub fn dir() -> SvnResult<PathBuf> {
    let dir = CONFIG_DIR.get().ok_or_else(|| {
        SvnError::CommandFailed("the svn workspace data directory has not been initialized".into())
    })?;
    std::fs::create_dir_all(dir)?;
    Ok(dir.clone())
}

/// The status snapshot cache lives beside the data rather than in the OS cache
/// directory: one directory to back up, one directory to delete, and no state
/// that survives a data-directory move in a place the user cannot see.
pub fn cache_dir() -> SvnResult<PathBuf> {
    let dir = dir()?.join("cache");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Resolve a flat file name inside the data directory. Names are hard-coded in
/// our own source, but the command boundary is a system boundary, so reject
/// anything that could point outside the directory.
fn path(name: &str) -> SvnResult<PathBuf> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.len() > 128
    {
        return Err(SvnError::InvalidArguments(format!(
            "invalid store name: {name:?}"
        )));
    }
    Ok(dir()?.join(name))
}

/// Read and parse a JSON document, or `None` when the file does not exist yet.
pub fn read_json<T: DeserializeOwned>(name: &str) -> SvnResult<Option<T>> {
    let path = path(name)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    serde_json::from_str(&raw).map_err(|error| SvnError::CommandFailed(error.to_string()))
        .map(Some)
}

/// Serialize `value` and write it atomically: stage to a timestamped `.tmp`
/// sibling, then `rename` over the destination (which replaces it on Windows).
/// On any failure the staging file is removed, so no leftovers remain.
pub fn write_json<T: Serialize>(name: &str, value: &T) -> SvnResult<()> {
    let path = path(name)?;
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| SvnError::CommandFailed(error.to_string()))?;
    // The temp name carries a timestamp so two writers staging the same file
    // cannot clobber each other's staging copy. The rename is what commits.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("{nanos}.json.tmp"));
    std::fs::write(&tmp, &bytes)?;
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.into());
    }
    Ok(())
}

/// Delete a file if it exists. A missing file is not an error.
pub fn remove_file(name: &str) -> SvnResult<()> {
    let path = path(name)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// The file the recent-working-copy list is persisted in.
const RECENT_FILE: &str = "recent-workspaces.json";

/// How many working copies the picker remembers. Old enough entries fall off
/// the end rather than growing the file without bound.
const MAX_RECENT: usize = 20;

/// One entry of the picker's "recent working copies" list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspace {
    /// The working copy path exactly as the user opened it.
    pub path: String,
    /// The revision the working copy was on when it was last opened, if it was
    /// known then. Shown in the list so the user can tell copies apart.
    pub revision: Option<u64>,
    /// Milliseconds since the Unix epoch, for ordering.
    pub opened_at: u64,
}

/// Paths that differ only by separator, trailing slash or case name the same
/// working copy on Windows, and must therefore dedupe to one entry.
fn workspace_key(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// The recent list, most recently opened first.
pub fn recent() -> SvnResult<Vec<RecentWorkspace>> {
    Ok(read_json::<Vec<RecentWorkspace>>(RECENT_FILE)?.unwrap_or_default())
}

/// Record an open, moving the working copy to the top of the list. Returns the
/// updated list so the caller does not have to re-read it.
pub fn remember(path: &str, revision: Option<u64>) -> SvnResult<Vec<RecentWorkspace>> {
    let path = path.trim();
    if path.is_empty() {
        return Err(SvnError::InvalidArguments(
            "a working copy path is required".to_string(),
        ));
    }
    let key = workspace_key(path);
    let mut entries = recent()?;
    entries.retain(|entry| workspace_key(&entry.path) != key);
    entries.insert(
        0,
        RecentWorkspace {
            path: path.to_string(),
            revision,
            opened_at: now_millis(),
        },
    );
    entries.truncate(MAX_RECENT);
    write_json(RECENT_FILE, &entries)?;
    Ok(entries)
}

/// Drop a working copy from the list. Returns the updated list.
pub fn forget(path: &str) -> SvnResult<Vec<RecentWorkspace>> {
    let key = workspace_key(path.trim());
    let mut entries = recent()?;
    entries.retain(|entry| workspace_key(&entry.path) != key);
    write_json(RECENT_FILE, &entries)?;
    Ok(entries)
}

/// Write a stash export to `path`, which the frontend got from the save dialog.
/// This is the one place the feature writes outside its data directory, and it
/// only ever writes where the user pointed.
pub fn export_stash(path: &str, contents: &str) -> SvnResult<()> {
    let path = path.trim();
    if path.is_empty() {
        return Err(SvnError::InvalidArguments(
            "an export path is required".to_string(),
        ));
    }
    std::fs::write(path, contents)?;
    Ok(())
}

/// A key is a flat lowercase slug, so one key maps to exactly one file in the
/// data directory and can never point outside it. Keys are hard-coded in our own
/// source, but the command boundary is a system boundary, hence the check.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Resolve a key to the file it names in the data directory.
fn key_path(key: &str) -> SvnResult<PathBuf> {
    if !valid_key(key) {
        return Err(SvnError::InvalidArguments(format!(
            "invalid store key: {key:?}"
        )));
    }
    Ok(dir()?.join(format!("{key}.json")))
}

/// Read a raw value, or `None` when the key has never been written. This is the
/// halves-of-a-JSON-document store the frontend's zustand `persist` layers ride
/// on, one file per key.
pub fn read(key: &str) -> SvnResult<Option<String>> {
    let path = key_path(key)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read_to_string(path)?))
}

/// Write a raw value atomically: stage to a timestamped `.tmp` sibling, then
/// `rename` over the destination (which replaces it on Windows). On failure the
/// staging file is removed, so no leftovers remain. [`write_json`] does the same
/// dance for typed documents.
pub fn write(key: &str, value: &str) -> SvnResult<()> {
    let path = key_path(key)?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("{nanos}.json.tmp"));
    std::fs::write(&tmp, value)?;
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.into());
    }
    Ok(())
}

/// Delete a key's file if it exists. A missing file is not an error.
pub fn remove(key: &str) -> SvnResult<()> {
    let path = key_path(key)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod key_tests {
    use super::valid_key;

    #[test]
    fn store_keys_are_flat_lowercase_slugs() {
        assert!(valid_key("svn-stash-entries"));
        assert!(valid_key("svn-workspace-views"));
        assert!(valid_key("a1"));
        assert!(!valid_key(""));
        assert!(!valid_key(".."));
        assert!(!valid_key("a/b"));
        assert!(!valid_key("a\\b"));
        assert!(!valid_key("Svn-Stash"));
        assert!(!valid_key("svn stash"));
        assert!(!valid_key(&"x".repeat(65)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Sample {
        a: u32,
    }

    #[test]
    fn values_round_trip_and_leave_no_temp_files() {
        let dir = std::env::temp_dir().join(format!("svn-core-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        CONFIG_DIR
            .set(dir.clone())
            .expect("no other test claims CONFIG_DIR");

        assert_eq!(read_json::<Sample>("sample.json").unwrap(), None);
        write_json("sample.json", &Sample { a: 1 }).unwrap();
        assert_eq!(read_json::<Sample>("sample.json").unwrap(), Some(Sample { a: 1 }));
        write_json("sample.json", &Sample { a: 2 }).unwrap();
        assert_eq!(read_json::<Sample>("sample.json").unwrap(), Some(Sample { a: 2 }));
        remove_file("sample.json").unwrap();
        assert_eq!(read_json::<Sample>("sample.json").unwrap(), None);

        assert!(path("../escape.json").is_err());
        assert!(path("a/b.json").is_err());

        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(leftovers.is_empty(), "leftover files: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
