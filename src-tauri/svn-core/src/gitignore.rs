//! Reads a working copy's `.gitignore` so the UI can filter unversioned files.
//!
//! This module only *reads*. Matching happens on the frontend, against the same
//! rules, so filtering can react to a keystroke without a round trip; the two
//! implementations must therefore stay in step.

use std::path::Path;

use crate::error::SvnError;
use crate::models::GitignoreData;

/// The working copy's `.gitignore` contents and mtime, or `None` when the file
/// does not exist. The mtime lets the frontend cache the parse and re-read only
/// when the file actually changed.
pub fn read(workspace: &str) -> Result<Option<GitignoreData>, SvnError> {
    let path = Path::new(workspace).join(".gitignore");
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)?;
    let mtime = std::fs::metadata(&path)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    Ok(Some(GitignoreData { content, mtime }))
}