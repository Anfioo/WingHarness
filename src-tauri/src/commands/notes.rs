//! Notes storage: a plain directory of text files under the app's data dir.
//!
//! The notes page mounts an in-memory filesystem (codelet's `FileSystem`) and
//! reconciles it to disk through these commands, so a note is a real file the
//! user can find, back up, or open elsewhere. Every path that arrives here is
//! relative to the notes root and is refused unless it stays inside it — the
//! same confinement the rest of the app applies to caller-supplied paths.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config;
use crate::commands::fs_guard::{relative_posix, safe_join};

/// A note as the page loads it: its path relative to the root, POSIX-spelled,
/// with a leading slash so codelet addresses it as `/foo/bar.md`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub path: String,
    pub content: String,
}

/// Every directory in the tree, so empty folders survive a reload.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTree {
    pub files: Vec<NoteFile>,
    pub directories: Vec<String>,
}

/// Root every note lives under, created on first use.
fn notes_root() -> Result<PathBuf, String> {
    let root = config::dir().join("notes");
    fs::create_dir_all(&root).map_err(|e| format!("could not create notes directory: {e}"))?;
    Ok(root)
}

/// Every file and directory under the root, ordered by path.
#[tauri::command]
pub fn notes_list() -> Result<NoteTree, String> {
    let root = notes_root()?;
    let mut files = Vec::new();
    let mut directories = Vec::new();
    walk(&root, &root, &mut files, &mut directories)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    directories.sort();
    Ok(NoteTree { files, directories })
}

fn walk(
    root: &Path,
    dir: &Path,
    files: &mut Vec<NoteFile>,
    directories: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("could not read {dir:?}: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            directories.push(relative_posix(root, &path));
            walk(root, &path, files, directories)?;
        } else if file_type.is_file() {
            // A note is text. Anything that will not decode is skipped rather
            // than failing the whole load.
            if let Ok(content) = fs::read_to_string(&path) {
                files.push(NoteFile {
                    path: relative_posix(root, &path),
                    content,
                });
            }
        }
    }
    Ok(())
}

/// Writes a note, creating any missing parent directories.
#[tauri::command]
pub fn notes_write(path: String, content: String) -> Result<(), String> {
    let root = notes_root()?;
    let target = safe_join(&root, &path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    fs::write(&target, content).map_err(|e| format!("could not write {target:?}: {e}"))
}

/// Creates a directory, and the ones above it.
#[tauri::command]
pub fn notes_mkdir(path: String) -> Result<(), String> {
    let root = notes_root()?;
    let target = safe_join(&root, &path)?;
    fs::create_dir_all(&target).map_err(|e| format!("could not create {target:?}: {e}"))
}

/// Removes a file, or a directory and everything under it.
#[tauri::command]
pub fn notes_delete(path: String) -> Result<(), String> {
    let root = notes_root()?;
    let target = safe_join(&root, &path)?;
    let metadata = fs::metadata(&target).map_err(|e| format!("could not stat {target:?}: {e}"))?;
    let result = if metadata.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };
    result.map_err(|e| format!("could not delete {target:?}: {e}"))
}

/// Renames or moves a file or directory, creating the destination's parents.
#[tauri::command]
pub fn notes_rename(from: String, to: String) -> Result<(), String> {
    let root = notes_root()?;
    let source = safe_join(&root, &from)?;
    let destination = safe_join(&root, &to)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {parent:?}: {e}"))?;
    }
    fs::rename(&source, &destination).map_err(|e| format!("could not move {source:?}: {e}"))
}

