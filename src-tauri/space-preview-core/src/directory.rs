//! One-level directory listing for the folder preview.
//!
//! Ported from SpacePreview (MIT). See `UPSTREAM.md`.
//!
//! `list` reads a single bounded page of one directory. Every entry is
//! canonicalised, refused when it resolves outside the directory it was found
//! in, and admitted through [`crate::io::inspect`], so expanding a subdirectory
//! and opening a file both work without a second admission call.

use std::fs;
use std::path::Path;

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::io;
use crate::models::{DirectoryPage, PreviewFileInfo};
use crate::state::PreviewState;

/// The number of entries one page holds.
pub const PAGE_SIZE: usize = 500;

/// List one page of `path`, directories first.
pub fn list(path: &Path, offset: usize, state: &PreviewState) -> SpacePreviewResult<DirectoryPage> {
    let directory = state.check(path)?;
    if !fs::metadata(&directory)
        .map_err(|error| listing_error(&directory, error))?
        .is_dir()
    {
        return Err(SpacePreviewError::invalid_input(
            "Only a directory can be listed.",
        ));
    }

    let mut source = fs::read_dir(&directory)
        .map_err(|error| listing_error(&directory, error))?
        .skip(offset);
    let mut entries = Vec::new();
    let mut consumed = 0;
    for entry in source.by_ref().take(PAGE_SIZE) {
        consumed += 1;
        // A single entry the process cannot resolve must not fail the page.
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(canonical) = fs::canonicalize(entry.path()) else {
            continue;
        };
        // A link or junction that resolves outside this directory is skipped.
        if canonical == directory || !canonical.starts_with(&directory) {
            continue;
        }
        if let Ok(info) = io::inspect(&canonical, state) {
            entries.push(info);
        }
    }
    entries.sort_by(|a: &PreviewFileInfo, b: &PreviewFileInfo| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(DirectoryPage {
        entries,
        next_offset: source.next().map(|_| offset + consumed),
    })
}

fn listing_error(path: &Path, error: std::io::Error) -> SpacePreviewError {
    if error.kind() == std::io::ErrorKind::NotFound {
        SpacePreviewError::not_found(format!("The directory does not exist: {}", path.display()))
    } else {
        SpacePreviewError::internal(format!(
            "The directory could not be listed: {} ({error})",
            path.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "space-preview-directory-{label}-{}-{stamp}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn admitting(path: &Path) -> PreviewState {
        let state = PreviewState::default();
        state.allow(path).unwrap();
        state
    }

    #[test]
    fn pages_carry_every_entry_once() {
        let directory = temp_dir("paging");
        for index in 0..502 {
            fs::write(directory.join(format!("file-{index:03}.txt")), b"").unwrap();
        }
        fs::create_dir(directory.join("nested")).unwrap();
        let state = admitting(&directory);

        let first = list(&directory, 0, &state).unwrap();
        assert_eq!(first.entries.len(), 500);
        assert_eq!(first.next_offset, Some(500));

        let second = list(&directory, 500, &state).unwrap();
        assert_eq!(second.entries.len(), 3);
        assert_eq!(second.next_offset, None);

        let ids: HashSet<String> = first
            .entries
            .iter()
            .chain(&second.entries)
            .map(|entry| entry.id.clone())
            .collect();
        assert_eq!(ids.len(), 503);
    }

    #[test]
    fn directories_come_before_files() {
        let directory = temp_dir("order");
        fs::write(directory.join("a.txt"), b"").unwrap();
        fs::create_dir(directory.join("z-folder")).unwrap();
        let state = admitting(&directory);

        let page = list(&directory, 0, &state).unwrap();

        assert_eq!(page.entries.len(), 2);
        assert!(page.entries[0].directory);
        assert!(!page.entries[1].directory);
    }

    #[test]
    fn listing_an_unadmitted_directory_is_refused() {
        let directory = temp_dir("unauthorized");
        let state = PreviewState::default();

        let error = list(&directory, 0, &state).unwrap_err();

        assert_eq!(error.code, "not-authorized");
    }

    #[cfg(windows)]
    #[test]
    fn links_outside_the_directory_are_skipped() {
        use std::os::windows::fs::symlink_dir;

        let directory = temp_dir("links");
        let outside = temp_dir("links-outside");
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        // Creating a symlink needs developer mode or an elevated process.
        if symlink_dir(&outside, directory.join("escape")).is_err() {
            return;
        }
        let state = admitting(&directory);

        let page = list(&directory, 0, &state).unwrap();

        assert!(page.entries.is_empty());
    }
}
