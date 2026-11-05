//! Unversioned-file stash helpers: capture, validate and restore.
//!
//! These are the one place the engine itself touches working-copy files rather
//! than delegating to `svn`: a stash of unversioned content has no `svn`
//! equivalent, so the bytes are read, base64-encoded and written back here.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use crate::error::SvnError;
use crate::models::{CommandResult, StashUnversionedEntry};

/// Keep enough headroom for base64 expansion, existing patches, and the storage
/// engine's own bookkeeping. The stash of unversioned files is persisted as a
/// plain JSON document, so it cannot grow without bound.
const MAX_UNVERSIONED_STASH_BYTES: u64 = 2 * 1024 * 1024;

/// Resolve the working copy root, rejecting a path that does not exist.
fn canonical_workspace(workspace: &str) -> Result<PathBuf, SvnError> {
    std::fs::canonicalize(workspace).map_err(|error| {
        SvnError::InvalidArguments(format!("invalid working copy path: {error}"))
    })
}

/// Resolve `file` against `workspace` without letting it escape: absolute paths,
/// `..` components and drive prefixes are all rejected, so a stashed entry can
/// never name a path outside the working copy.
pub(crate) fn resolve_workspace_child(workspace: &Path, file: &str) -> Result<PathBuf, SvnError> {
    let relative = Path::new(file);
    if relative.is_absolute() {
        return Err(SvnError::InvalidArguments(format!(
            "absolute paths are not allowed: {file}"
        )));
    }

    let mut target = workspace.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => target.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(SvnError::InvalidArguments(format!(
                    "invalid path outside the working copy: {file}"
                )));
            }
        }
    }

    Ok(target)
}

/// Delete unversioned paths from the working copy.
pub fn delete(workspace: &str, files: &[String]) -> Result<CommandResult, SvnError> {
    let workspace = canonical_workspace(workspace)?;
    let mut removed = Vec::new();

    for file in files {
        let target = resolve_workspace_child(&workspace, file)?;
        if !target.exists() {
            return Err(SvnError::InvalidArguments(format!(
                "file does not exist: {file}"
            )));
        }

        let canonical_target = std::fs::canonicalize(&target).map_err(|error| {
            SvnError::CommandFailed(format!("failed to resolve file path '{file}': {error}"))
        })?;
        if !canonical_target.starts_with(&workspace) {
            return Err(SvnError::InvalidArguments(format!(
                "refusing to delete outside the working copy: {file}"
            )));
        }

        if canonical_target.is_dir() {
            std::fs::remove_dir_all(&canonical_target).map_err(|error| {
                SvnError::CommandFailed(format!("failed to delete directory '{file}': {error}"))
            })?;
        } else {
            std::fs::remove_file(&canonical_target).map_err(|error| {
                SvnError::CommandFailed(format!("failed to delete file '{file}': {error}"))
            })?;
        }
        removed.push(file.clone());
    }

    Ok(CommandResult::ok(removed.join("\n")))
}

/// Recursively capture a file or directory into `entries`, enforcing the size
/// limit as bytes are read. Directories are recorded as such, so an empty
/// directory survives the round trip.
fn collect_unversioned_entry(
    workspace: &Path,
    target: &Path,
    entries: &mut Vec<StashUnversionedEntry>,
    total_bytes: &mut u64,
) -> Result<(), SvnError> {
    let metadata = std::fs::symlink_metadata(target)?;
    if metadata.file_type().is_symlink() {
        return Err(SvnError::InvalidArguments(format!(
            "symbolic links are not supported: {}",
            target.display()
        )));
    }
    let relative = target
        .strip_prefix(workspace)
        .map_err(|error| SvnError::CommandFailed(error.to_string()))?;
    let path = relative.to_string_lossy().replace('\\', "/");
    if metadata.is_dir() {
        entries.push(StashUnversionedEntry {
            path,
            kind: "directory".to_string(),
            content_base64: None,
        });
        let mut children = std::fs::read_dir(target)?.collect::<Result<Vec<_>, _>>()?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            collect_unversioned_entry(workspace, &child.path(), entries, total_bytes)?;
        }
    } else {
        *total_bytes = total_bytes.saturating_add(metadata.len());
        if *total_bytes > MAX_UNVERSIONED_STASH_BYTES {
            return Err(SvnError::InvalidArguments(
                "unversioned files exceed the 2 MB stash limit".to_string(),
            ));
        }
        let content = std::fs::read(target)?;
        entries.push(StashUnversionedEntry {
            path,
            kind: "file".to_string(),
            content_base64: Some(BASE64_STANDARD.encode(content)),
        });
    }
    Ok(())
}

/// Capture unversioned paths so they can be stashed.
pub async fn read(
    workspace: &str,
    files: &[String],
) -> Result<Vec<StashUnversionedEntry>, SvnError> {
    let root = canonical_workspace(workspace)?;
    let statuses = crate::operations::status(workspace).await?;
    let unversioned: HashSet<String> = statuses
        .into_iter()
        .filter(|status| status.status_code == "unversioned")
        .map(|status| status.path.replace('\\', "/"))
        .collect();

    let mut entries = Vec::new();
    let mut total_bytes = 0u64;
    for file in files {
        let normalized = file.replace('\\', "/");
        if !unversioned.contains(&normalized) {
            return Err(SvnError::InvalidArguments(format!(
                "path is not unversioned: {file}"
            )));
        }
        let target = resolve_workspace_child(&root, file)?;
        let canonical = std::fs::canonicalize(&target)?;
        if !canonical.starts_with(&root) {
            return Err(SvnError::InvalidArguments(format!(
                "refusing to read outside the working copy: {file}"
            )));
        }
        collect_unversioned_entry(&root, &canonical, &mut entries, &mut total_bytes)?;
    }
    Ok(entries)
}

/// Confirm the deepest existing ancestor of `target` still sits inside the
/// working copy, so restoration cannot be tricked into writing elsewhere by a
/// symlinked parent that was created behind our back.
fn validate_restore_target(workspace: &Path, target: &Path) -> Result<(), SvnError> {
    let mut existing_parent = target
        .parent()
        .ok_or_else(|| SvnError::InvalidArguments("invalid restore path".to_string()))?;
    while !existing_parent.exists() {
        existing_parent = existing_parent
            .parent()
            .ok_or_else(|| SvnError::InvalidArguments("invalid restore path".to_string()))?;
    }
    let canonical_parent = std::fs::canonicalize(existing_parent)?;
    if !canonical_parent.starts_with(workspace) {
        return Err(SvnError::InvalidArguments(format!(
            "refusing to restore outside the working copy: {}",
            target.display()
        )));
    }
    Ok(())
}

/// Write stashed unversioned paths back. With `dry_run`, only validate.
pub fn restore(
    workspace: &str,
    entries: &[StashUnversionedEntry],
    dry_run: bool,
) -> Result<(), SvnError> {
    let workspace = canonical_workspace(workspace)?;
    if entries.is_empty() {
        return Ok(());
    }

    let mut resolved = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry.kind != "file" && entry.kind != "directory" {
            return Err(SvnError::InvalidArguments(format!(
                "invalid stored entry kind: {}",
                entry.kind
            )));
        }
        if entry.kind == "file" && entry.content_base64.is_none() {
            return Err(SvnError::InvalidArguments(format!(
                "stored file has no content: {}",
                entry.path
            )));
        }
        let target = resolve_workspace_child(&workspace, &entry.path)?;
        validate_restore_target(&workspace, &target)?;
        if target.exists() {
            return Err(SvnError::InvalidArguments(format!(
                "cannot restore because the path already exists: {}",
                entry.path
            )));
        }
        resolved.push((entry, target));
    }
    if dry_run {
        return Ok(());
    }

    // Shallow paths first, so a directory is always created before its children.
    resolved.sort_by_key(|(_, target)| target.components().count());
    for (entry, target) in resolved {
        if entry.kind == "directory" {
            std::fs::create_dir_all(&target).map_err(|error| {
                SvnError::CommandFailed(format!(
                    "failed to restore directory '{}': {error}",
                    entry.path
                ))
            })?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let encoded = entry.content_base64.as_deref().unwrap_or_default();
            let content = BASE64_STANDARD.decode(encoded).map_err(|error| {
                SvnError::InvalidArguments(format!(
                    "invalid stored content for '{}': {error}",
                    entry.path
                ))
            })?;
            std::fs::write(&target, content).map_err(|error| {
                SvnError::CommandFailed(format!("failed to restore file '{}': {error}", entry.path))
            })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{collect_unversioned_entry, restore};
    use std::fs;

    #[test]
    fn captures_and_restores_binary_files_and_empty_directories() {
        let root = std::env::temp_dir().join(format!(
            "svn-core-unversioned-stash-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source = root.join("new-dir");
        fs::create_dir_all(source.join("empty")).unwrap();
        fs::write(source.join("binary.dat"), [0, 1, 127, 255]).unwrap();

        let workspace = fs::canonicalize(&root).unwrap();
        let canonical_source = fs::canonicalize(&source).unwrap();
        let mut entries = Vec::new();
        let mut total_bytes = 0;
        collect_unversioned_entry(
            &workspace,
            &canonical_source,
            &mut entries,
            &mut total_bytes,
        )
        .unwrap();
        assert_eq!(total_bytes, 4);
        assert!(entries.iter().any(|entry| entry.path == "new-dir/empty"));

        fs::remove_dir_all(&source).unwrap();
        restore(root.to_string_lossy().as_ref(), &entries, true).unwrap();
        assert!(!source.exists());
        restore(root.to_string_lossy().as_ref(), &entries, false).unwrap();
        assert_eq!(
            fs::read(source.join("binary.dat")).unwrap(),
            [0, 1, 127, 255]
        );
        assert!(source.join("empty").is_dir());
        assert!(restore(root.to_string_lossy().as_ref(), &entries, true).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}