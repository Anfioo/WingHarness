//! Local filesystem browsing for the left pane.
//!
//! The frontend holds absolute paths but never reads the disk itself: every
//! listing and mutation goes through these commands so errors and ordering are
//! uniform with the remote pane.

use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{ServerError, ServerResult};
use crate::models::{EntryKind, SftpEntry};
use crate::sftp::ops::sort_entries;

/// How many levels of nesting a recursive delete may descend.
const MAX_DELETE_DEPTH: usize = 64;

#[cfg(windows)]
const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;

/// The current user's home directory.
pub fn home() -> ServerResult<String> {
    #[cfg(windows)]
    let candidates = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let candidates = ["HOME", "USERPROFILE"];

    for name in candidates {
        if let Ok(value) = std::env::var(name) {
            if !value.trim().is_empty() {
                return Ok(value);
            }
        }
    }

    std::env::current_dir()
        .map(|directory| directory.to_string_lossy().into_owned())
        .map_err(|error| ServerError::internal(format!("Failed to find the home directory: {error}")))
}

/// One directory, directories first, hidden entries filtered when asked.
pub fn list(path: &str, show_hidden: bool) -> ServerResult<Vec<SftpEntry>> {
    let directory = path_buf(path)?;
    let metadata = fs::metadata(&directory).map_err(|error| io_error(path, error))?;
    if !metadata.is_dir() {
        return Err(ServerError::path_invalid(path));
    }

    let children = fs::read_dir(&directory).map_err(|error| io_error(path, error))?;

    let mut entries = Vec::new();
    for child in children {
        let child = match child {
            Ok(child) => child,
            Err(_) => continue,
        };

        let name = child.file_name().to_string_lossy().into_owned();
        // `symlink_metadata` keeps a link a link instead of describing its target.
        let metadata = match fs::symlink_metadata(child.path()) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        if !show_hidden && is_hidden(&name, &metadata) {
            continue;
        }

        entries.push(entry_from(name, child.path(), &metadata));
    }

    sort_entries(&mut entries);
    Ok(entries)
}

pub fn stat(path: &str) -> ServerResult<SftpEntry> {
    let target = path_buf(path)?;
    let metadata = fs::symlink_metadata(&target).map_err(|error| io_error(path, error))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    Ok(entry_from(name, target, &metadata))
}

pub fn mkdir(path: &str) -> ServerResult<()> {
    let directory = path_buf(path)?;

    if directory.exists() {
        return Err(target_exists(path));
    }

    match directory.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            if !parent.is_dir() {
                return Err(ServerError::not_found(&parent.to_string_lossy()));
            }
        }
        _ => {}
    }

    fs::create_dir(&directory).map_err(|error| io_error(path, error))
}

pub fn rename(from: &str, to: &str) -> ServerResult<()> {
    let source = path_buf(from)?;
    let target = path_buf(to)?;

    if !source.exists() {
        return Err(ServerError::not_found(from));
    }
    if target.exists() {
        return Err(target_exists(to));
    }

    fs::rename(&source, &target).map_err(|error| io_error(from, error))
}

pub fn delete(path: &str, is_dir: bool) -> ServerResult<()> {
    let target = path_buf(path)?;
    if target.parent().is_none() {
        return Err(ServerError::permission_denied(path));
    }

    if is_dir {
        return remove_tree(&target, 0);
    }

    fs::remove_file(&target).map_err(|error| io_error(path, error))
}

fn path_buf(path: &str) -> ServerResult<PathBuf> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(ServerError::path_invalid(path));
    }

    let buffer = PathBuf::from(path);
    if !buffer.is_absolute() {
        return Err(ServerError::path_invalid(path));
    }

    Ok(buffer)
}

fn entry_from(name: String, path: PathBuf, metadata: &Metadata) -> SftpEntry {
    let file_type = metadata.file_type();
    let is_symlink = file_type.is_symlink();
    let is_dir = !is_symlink && file_type.is_dir();

    SftpEntry {
        name,
        path: path.to_string_lossy().into_owned(),
        kind: if is_dir { EntryKind::Dir } else { EntryKind::File },
        size: if is_dir { 0 } else { metadata.len() },
        permissions: permissions_string(metadata),
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_secs() as i64),
        is_symlink,
    }
}

fn is_hidden(name: &str, metadata: &Metadata) -> bool {
    if name.starts_with('.') {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
    }

    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

#[cfg(unix)]
fn permissions_string(metadata: &Metadata) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    Some(crate::sftp::ops::permission_string(
        metadata.permissions().mode() & 0o777,
    ))
}

#[cfg(not(unix))]
fn permissions_string(metadata: &Metadata) -> Option<String> {
    let _ = metadata;
    None
}

fn remove_tree(path: &Path, depth: usize) -> ServerResult<()> {
    if depth > MAX_DELETE_DEPTH {
        return Err(ServerError::internal(
            "The directory is nested too deeply to delete.",
        ));
    }

    let shown = path.to_string_lossy().into_owned();
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(&shown, error))?;
    let file_type = metadata.file_type();

    if file_type.is_symlink() || !file_type.is_dir() {
        return fs::remove_file(path).map_err(|error| io_error(&shown, error));
    }

    let children = fs::read_dir(path).map_err(|error| io_error(&shown, error))?;
    for child in children {
        let child = match child {
            Ok(child) => child,
            Err(_) => continue,
        };
        remove_tree(&child.path(), depth + 1)?;
    }

    fs::remove_dir(path).map_err(|error| io_error(&shown, error))
}

fn target_exists(path: &str) -> ServerError {
    ServerError::internal("target exists").with_detail(serde_json::json!({ "path": path }))
}

fn io_error(path: &str, error: std::io::Error) -> ServerError {
    match error.kind() {
        std::io::ErrorKind::NotFound => ServerError::not_found(path),
        std::io::ErrorKind::PermissionDenied => ServerError::permission_denied(path),
        std::io::ErrorKind::AlreadyExists => target_exists(path),
        _ => ServerError::internal(format!("Local file operation failed on '{}': {}", path, error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[cfg(windows)]
    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileAttributesW(file_name: *const u16, attributes: u32) -> i32;
    }

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "server-core-local-{}-{}-{}",
            tag,
            std::process::id(),
            unique
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn shown(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn home_is_absolute() {
        let directory = home().unwrap();
        assert!(Path::new(&directory).is_absolute());
    }

    #[test]
    fn rejects_relative_and_empty_paths() {
        assert!(list("", false).is_err());
        assert!(list("relative/path", false).is_err());
        assert!(mkdir("").is_err());
    }

    #[test]
    fn lists_directories_first_then_names() {
        let directory = scratch("sort");
        fs::write(directory.join("b.txt"), b"b").unwrap();
        fs::write(directory.join("A.txt"), b"a").unwrap();
        fs::create_dir(directory.join("zeta")).unwrap();
        fs::create_dir(directory.join("alpha")).unwrap();

        let entries = list(&shown(&directory), false).unwrap();
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();

        assert_eq!(names, vec!["alpha", "zeta", "A.txt", "b.txt"]);
        assert_eq!(entries[0].kind, EntryKind::Dir);
        assert_eq!(entries[2].kind, EntryKind::File);
        assert_eq!(entries[2].size, 1);

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn filters_dot_files() {
        let directory = scratch("dotfiles");
        fs::write(directory.join(".hidden"), b"x").unwrap();
        fs::write(directory.join("visible.txt"), b"x").unwrap();

        let visible = list(&shown(&directory), false).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].name, "visible.txt");

        let everything = list(&shown(&directory), true).unwrap();
        assert_eq!(everything.len(), 2);

        let _ = fs::remove_dir_all(&directory);
    }

    #[cfg(windows)]
    #[test]
    fn filters_windows_hidden_attribute() {
        use std::os::windows::ffi::OsStrExt;

        let directory = scratch("hidden-attr");
        let secret = directory.join("secret.txt");
        fs::write(&secret, b"x").unwrap();

        let wide: Vec<u16> = secret.as_os_str().encode_wide().chain(Some(0)).collect();
        let applied = unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_HIDDEN) };
        assert_ne!(applied, 0, "SetFileAttributesW failed");

        let visible = list(&shown(&directory), false).unwrap();
        assert!(visible.is_empty(), "hidden attribute was not filtered");

        let everything = list(&shown(&directory), true).unwrap();
        assert_eq!(everything.len(), 1);

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn listing_a_file_is_rejected() {
        let directory = scratch("not-a-dir");
        let file = directory.join("file.txt");
        fs::write(&file, b"x").unwrap();

        assert!(list(&shown(&file), false).is_err());

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn stat_reports_files_and_missing_paths() {
        let directory = scratch("stat");
        let file = directory.join("file.txt");
        fs::write(&file, b"hello").unwrap();

        let entry = stat(&shown(&file)).unwrap();
        assert_eq!(entry.name, "file.txt");
        assert_eq!(entry.kind, EntryKind::File);
        assert_eq!(entry.size, 5);
        assert!(entry.modified_at.is_some());

        let missing = stat(&shown(&directory.join("nope.txt"))).unwrap_err();
        assert_eq!(missing.code, crate::ServerErrorCode::NotFound);

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn mkdir_requires_an_existing_parent() {
        let directory = scratch("mkdir");
        let nested = directory.join("missing").join("child");

        let error = mkdir(&shown(&nested)).unwrap_err();
        assert_eq!(error.code, crate::ServerErrorCode::NotFound);

        let created = directory.join("child");
        mkdir(&shown(&created)).unwrap();
        assert!(created.is_dir());

        let again = mkdir(&shown(&created)).unwrap_err();
        assert_eq!(again.code, crate::ServerErrorCode::Internal);

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn rename_refuses_an_existing_target() {
        let directory = scratch("rename");
        let source = directory.join("source.txt");
        let target = directory.join("target.txt");
        fs::write(&source, b"x").unwrap();
        fs::write(&target, b"y").unwrap();

        let error = rename(&shown(&source), &shown(&target)).unwrap_err();
        assert_eq!(error.code, crate::ServerErrorCode::Internal);
        assert_eq!(error.message, "target exists");

        let moved = directory.join("moved.txt");
        rename(&shown(&source), &shown(&moved)).unwrap();
        assert!(!source.exists());
        assert!(moved.exists());

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn deletes_directories_recursively() {
        let directory = scratch("delete");
        let nested = directory.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("deep.txt"), b"x").unwrap();

        delete(&shown(&directory.join("a")), true).unwrap();
        assert!(!directory.join("a").exists());

        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn refuses_to_delete_a_root() {
        let current = std::env::current_dir().unwrap();
        let root = current
            .ancestors()
            .last()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        let error = delete(&root, true).unwrap_err();
        assert_eq!(error.code, crate::ServerErrorCode::PermissionDenied);
    }
}
