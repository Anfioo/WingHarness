//! Primitive SFTP calls behind `SftpHandle`.
//!
//! Kept separate from `mod.rs` so `SftpHandle` stays a thin facade other lanes
//! can call without pulling in the protocol details.

use std::io::SeekFrom;

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::fs::File;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::error::{ServerError, ServerResult};
use crate::models::{EntryKind, SftpEntry};
use crate::sftp::paths;

/// Largest text a single `server_sftp_read_text` / `server_sftp_write_text`
/// round trip moves over IPC (plan §6, D17).
pub(crate) const TEXT_LIMIT: u64 = 2 * 1024 * 1024;

/// How many levels of nesting a recursive delete may descend (plan R5).
pub(crate) const MAX_DELETE_DEPTH: usize = 64;

/// How many rows one listing may return; larger directories are steered to the
/// path bar instead (plan R10).
pub(crate) const MAX_LIST_ENTRIES: usize = 5_000;

pub(crate) async fn home(session: &SftpSession) -> ServerResult<String> {
    if let Ok(path) = session.canonicalize(".").await {
        if let Ok(normalized) = paths::normalize(&path) {
            return Ok(normalized);
        }
    }

    if let Ok(Some(path)) = session.expand_path(".").await {
        if let Ok(normalized) = paths::normalize(&path) {
            return Ok(normalized);
        }
    }

    Ok("/".to_string())
}

pub(crate) async fn list(session: &SftpSession, path: &str) -> ServerResult<Vec<SftpEntry>> {
    let path = paths::normalize(path)?;
    let directory = session
        .read_dir(path.as_str())
        .await
        .map_err(|error| map_error(error, &path))?;

    let mut entries = Vec::new();
    for entry in directory {
        let name = entry.file_name();
        let child = paths::join(&path, &name)?;
        entries.push(entry_from(child, name, &entry.metadata()));
    }

    if entries.len() > MAX_LIST_ENTRIES {
        return Err(ServerError::internal(
            "The directory has too many entries to list.",
        )
        .with_detail(serde_json::json!({ "limit": MAX_LIST_ENTRIES })));
    }

    sort_entries(&mut entries);
    Ok(entries)
}

pub(crate) async fn stat(session: &SftpSession, path: &str) -> ServerResult<SftpEntry> {
    let path = paths::normalize(path)?;
    // `lstat` on purpose: the pane has to show what is on disk, not what a
    // symlink points at.
    let attributes = session
        .symlink_metadata(path.as_str())
        .await
        .map_err(|error| map_error(error, &path))?;

    Ok(entry_from(path.clone(), entry_name(&path), &attributes))
}

pub(crate) async fn mkdir(session: &SftpSession, path: &str) -> ServerResult<()> {
    let path = paths::normalize(path)?;
    reject_root(&path)?;
    ensure_parent_directory(session, &path).await?;

    if session.try_exists(path.as_str()).await.map_err(|error| map_error(error, &path))? {
        return Err(ServerError::internal("target exists").with_detail(serde_json::json!({ "path": path })));
    }

    session
        .create_dir(path.as_str())
        .await
        .map_err(|error| map_error(error, &path))
}

pub(crate) async fn rename(session: &SftpSession, from: &str, to: &str) -> ServerResult<()> {
    let from = paths::normalize(from)?;
    let to = paths::normalize(to)?;
    reject_root(&from)?;
    reject_root(&to)?;

    if session.try_exists(to.as_str()).await.map_err(|error| map_error(error, &to))? {
        return Err(ServerError::internal("target exists").with_detail(serde_json::json!({ "path": to })));
    }

    session
        .rename(from.as_str(), to.as_str())
        .await
        .map_err(|error| map_error(error, &from))
}

pub(crate) async fn remove(session: &SftpSession, path: &str, is_dir: bool) -> ServerResult<()> {
    let path = paths::normalize(path)?;
    reject_root(&path)?;

    if !is_dir {
        return session
            .remove_file(path.as_str())
            .await
            .map_err(|error| map_error(error, &path));
    }

    // A symlink to a directory is still a link: drop the link, never walk it.
    let attributes = session
        .symlink_metadata(path.as_str())
        .await
        .map_err(|error| map_error(error, &path))?;
    if attributes.is_symlink() || !attributes.is_dir() {
        return session
            .remove_file(path.as_str())
            .await
            .map_err(|error| map_error(error, &path));
    }

    remove_directory(session, &path, 0).await
}

pub(crate) async fn read_file(
    session: &SftpSession,
    path: &str,
    max_bytes: u64,
) -> ServerResult<Vec<u8>> {
    let path = paths::normalize(path)?;

    // `stat` follows a symlink, so the size check sees the real payload.
    let attributes = session
        .metadata(path.as_str())
        .await
        .map_err(|error| map_error(error, &path))?;
    if let Some(size) = attributes.size {
        if size > max_bytes {
            return Err(ServerError::file_too_large(size, max_bytes));
        }
    }

    let mut file = session
        .open(path.as_str())
        .await
        .map_err(|error| map_error(error, &path))?;

    let mut buffer = Vec::new();
    {
        let mut limited = (&mut file).take(max_bytes.saturating_add(1));
        limited
            .read_to_end(&mut buffer)
            .await
            .map_err(|error| ServerError::internal(format!("Failed to read the file: {error}")))?;
    }

    if buffer.len() as u64 > max_bytes {
        return Err(ServerError::file_too_large(buffer.len() as u64, max_bytes));
    }

    file.close()
        .await
        .map_err(|error| ServerError::internal(format!("Failed to close the file: {error}")))?;

    Ok(buffer)
}

pub(crate) async fn write_file(session: &SftpSession, path: &str, data: &[u8]) -> ServerResult<()> {
    let path = paths::normalize(path)?;
    reject_root(&path)?;
    ensure_parent_directory(session, &path).await?;

    let mut file = session
        .create(path.as_str())
        .await
        .map_err(|error| map_error(error, &path))?;

    file.write_all(data)
        .await
        .map_err(|error| ServerError::internal(format!("Failed to write the file: {error}")))?;

    file.close()
        .await
        .map_err(|error| ServerError::internal(format!("Failed to close the file: {error}")))
}

pub(crate) async fn open_read(
    session: &SftpSession,
    path: &str,
    offset: u64,
) -> ServerResult<File> {
    let path = paths::normalize(path)?;

    let mut file = session
        .open(path.as_str())
        .await
        .map_err(|error| map_error(error, &path))?;

    if offset > 0 {
        file.seek(SeekFrom::Start(offset)).await.map_err(|error| {
            ServerError::internal(format!("Failed to seek the file: {error}"))
        })?;
    }

    Ok(file)
}

/// Open for writing at `offset`.
///
/// Offset zero truncates, any later offset keeps what is already there so a
/// paused transfer can resume where it stopped.
pub(crate) async fn open_write(
    session: &SftpSession,
    path: &str,
    offset: u64,
) -> ServerResult<File> {
    let path = paths::normalize(path)?;
    reject_root(&path)?;
    ensure_parent_directory(session, &path).await?;

    let flags = if offset == 0 {
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
    } else {
        OpenFlags::CREATE | OpenFlags::WRITE
    };

    let mut file = session
        .open_with_flags(path.as_str(), flags)
        .await
        .map_err(|error| map_error(error, &path))?;

    if offset > 0 {
        file.seek(SeekFrom::Start(offset)).await.map_err(|error| {
            ServerError::internal(format!("Failed to seek the file: {error}"))
        })?;
    }

    Ok(file)
}

/// Classify a raw SFTP error into the command boundary's error type.
pub(crate) fn map_error(error: SftpError, path: &str) -> ServerError {
    match error {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => ServerError::not_found(path),
            StatusCode::PermissionDenied => ServerError::permission_denied(path),
            StatusCode::NoConnection | StatusCode::ConnectionLost => ServerError::not_connected(),
            StatusCode::OpUnsupported => ServerError::internal(
                "The server does not support this file operation.",
            ),
            _ => ServerError::internal(format!(
                "SFTP failed on '{}': {}",
                path, status.error_message
            )),
        },
        SftpError::Timeout => ServerError::internal("The SFTP request timed out."),
        other => ServerError::internal(format!("SFTP failed on '{}': {}", path, other)),
    }
}

/// `rwxr-xr-x` for the low nine mode bits.
pub(crate) fn permission_string(mode: u32) -> String {
    const BITS: [(u32, char); 9] = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];

    BITS.iter()
        .map(|(bit, character)| {
            if mode & bit != 0 {
                *character
            } else {
                '-'
            }
        })
        .collect()
}

/// Directories first, then names case-insensitively, so both panes agree.
pub(crate) fn sort_entries(entries: &mut [SftpEntry]) {
    entries.sort_by(|left, right| {
        let left_dir = left.kind == EntryKind::Dir;
        let right_dir = right.kind == EntryKind::Dir;
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
}

fn entry_from(path: String, name: String, attributes: &FileAttributes) -> SftpEntry {
    let is_symlink = attributes.is_symlink();
    let is_dir = !is_symlink && attributes.is_dir();

    SftpEntry {
        name,
        path,
        kind: if is_dir { EntryKind::Dir } else { EntryKind::File },
        size: if is_dir {
            0
        } else {
            attributes.size.unwrap_or(0)
        },
        permissions: attributes.permissions.map(permission_string),
        modified_at: attributes.mtime.map(|seconds| seconds as i64),
        is_symlink,
    }
}

fn entry_name(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return path.to_string();
    }

    match trimmed.rfind('/') {
        Some(index) => trimmed[index + 1..].to_string(),
        None => trimmed.to_string(),
    }
}

fn reject_root(path: &str) -> ServerResult<()> {
    if path == "/" || path == "." || path == ".." {
        return Err(ServerError::permission_denied(path));
    }
    Ok(())
}

async fn ensure_parent_directory(session: &SftpSession, path: &str) -> ServerResult<()> {
    let parent = paths::parent(path)?;
    match session.metadata(parent.as_str()).await {
        Ok(attributes) if attributes.is_dir() => Ok(()),
        Ok(_) => Err(ServerError::internal(format!(
            "The parent of '{}' is not a directory.",
            path
        ))),
        Err(error) => Err(map_error(error, &parent)),
    }
}

async fn remove_directory(
    session: &SftpSession,
    path: &str,
    depth: usize,
) -> ServerResult<()> {
    if depth > MAX_DELETE_DEPTH {
        return Err(ServerError::internal(
            "The directory is nested too deeply to delete.",
        ));
    }

    let directory = session
        .read_dir(path)
        .await
        .map_err(|error| map_error(error, path))?;

    for entry in directory {
        let child = entry.path();
        let attributes = entry.metadata();
        if attributes.is_symlink() || !attributes.is_dir() {
            session
                .remove_file(child.as_str())
                .await
                .map_err(|error| map_error(error, &child))?;
        } else {
            Box::pin(remove_directory(session, &child, depth + 1)).await?;
        }
    }

    session
        .remove_dir(path)
        .await
        .map_err(|error| map_error(error, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_permissions() {
        assert_eq!(permission_string(0o755), "rwxr-xr-x");
        assert_eq!(permission_string(0o644), "rw-r--r--");
        assert_eq!(permission_string(0o000), "---------");
        assert_eq!(permission_string(0o777), "rwxrwxrwx");
    }

    #[test]
    fn entry_names() {
        assert_eq!(entry_name("/a/b.txt"), "b.txt");
        assert_eq!(entry_name("/a/"), "a");
        assert_eq!(entry_name("/"), "/");
        assert_eq!(entry_name("b.txt"), "b.txt");
    }

    #[test]
    fn classifies_directories_and_symlinks() {
        let mut directory = FileAttributes::default();
        directory.set_dir(true);
        let entry = entry_from("/srv/data".into(), "data".into(), &directory);
        assert_eq!(entry.kind, EntryKind::Dir);
        assert!(!entry.is_symlink);

        let mut link = FileAttributes::default();
        link.set_symlink(true);
        let entry = entry_from("/srv/link".into(), "link".into(), &link);
        assert_eq!(entry.kind, EntryKind::File);
        assert!(entry.is_symlink);
    }

    #[test]
    fn sorts_directories_first_then_names() {
        let make = |name: &str, kind: EntryKind| SftpEntry {
            name: name.into(),
            path: format!("/{name}"),
            kind,
            size: 0,
            permissions: None,
            modified_at: None,
            is_symlink: false,
        };

        let mut entries = vec![
            make("b.txt", EntryKind::File),
            make("Zeta", EntryKind::Dir),
            make("A.txt", EntryKind::File),
            make("alpha", EntryKind::Dir),
        ];
        sort_entries(&mut entries);

        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Zeta", "A.txt", "b.txt"]);
    }
}
