//! File inspection and ranged reads.
//!
//! `inspect` is the only entry that admits a path into the allowlist; the two
//! read functions only accept paths it admitted. Reads are bounded and ranged,
//! so nothing here loads a whole file on the caller's behalf.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::models::PreviewFileInfo;
use crate::state::PreviewState;

/// The largest single read the engine performs.
pub const MAX_READ: usize = 32 * 1024 * 1024;

/// An opaque change tag: a write carries the one it read, and a mismatch is a
/// conflict. Same shape as the project file client's tag.
pub fn etag_of(size: u64, mtime_ms: u64) -> String {
    format!("{size}-{mtime_ms}")
}

/// Resolve `path`, admit it for later reads and describe it.
pub fn inspect(path: &Path, state: &PreviewState) -> SpacePreviewResult<PreviewFileInfo> {
    // `allow` canonicalizes first, so a path that does not exist fails here
    // rather than being recorded.
    let canonical = state.allow(path)?;
    let metadata = fs::metadata(&canonical).map_err(|error| metadata_error(&canonical, error))?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(SpacePreviewError::unsupported(
            "Only regular files and directories can be previewed.",
        ));
    }

    let size = metadata.len();
    let modified = modified_millis(&metadata);
    Ok(PreviewFileInfo {
        id: identity(&canonical.to_string_lossy()),
        name: file_name(&canonical),
        path: canonical.to_string_lossy().into_owned(),
        size,
        modified,
        mime: mime_guess::from_path(&canonical)
            .first_or_octet_stream()
            .to_string(),
        directory: metadata.is_dir(),
        etag: etag_of(size, modified),
    })
}

/// The first `limit` bytes of an admitted file.
pub fn read_prefix(
    path: &Path,
    limit: usize,
    state: &PreviewState,
) -> SpacePreviewResult<Vec<u8>> {
    let canonical = state.check(path)?;
    read_at(&canonical, 0, limit)
}

/// `limit` bytes starting at `offset` of an admitted file.
pub fn read_range(
    path: &Path,
    offset: usize,
    limit: usize,
    state: &PreviewState,
) -> SpacePreviewResult<Vec<u8>> {
    let canonical = state.check(path)?;
    if offset.checked_add(limit).is_none() {
        return Err(SpacePreviewError::invalid_input(
            "The read range overflows the addressable size.",
        ));
    }
    read_at(&canonical, offset as u64, limit)
}

/// Map a filesystem error onto the structured preview error.
pub(crate) fn file_error(path: &Path, error: std::io::Error) -> SpacePreviewError {
    if error.kind() == std::io::ErrorKind::NotFound {
        SpacePreviewError::not_found(format!(
            "The file does not exist: {}",
            path.display()
        ))
    } else {
        SpacePreviewError::internal(format!(
            "The file could not be read: {} ({error})",
            path.display()
        ))
    }
}

fn read_at(path: &Path, offset: u64, limit: usize) -> SpacePreviewResult<Vec<u8>> {
    if limit > MAX_READ {
        return Err(SpacePreviewError::too_large(format!(
            "A single read is limited to {MAX_READ} bytes."
        )));
    }
    if limit == 0 {
        return Ok(Vec::new());
    }

    // Windows refuses to open a directory as a file, so the type check comes
    // from the metadata rather than the open error.
    let metadata = fs::metadata(path).map_err(|error| metadata_error(path, error))?;
    if !metadata.is_file() {
        return Err(SpacePreviewError::invalid_input(
            "Only regular files can be read.",
        ));
    }

    let mut file = File::open(path).map_err(|error| file_error(path, error))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| file_error(path, error))?;
    let remaining = metadata.len().saturating_sub(offset);
    let capacity = limit.min(usize::try_from(remaining).unwrap_or(usize::MAX));
    let mut bytes = Vec::with_capacity(capacity);
    file.take(limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| file_error(path, error))?;
    Ok(bytes)
}

fn metadata_error(path: &Path, error: std::io::Error) -> SpacePreviewError {
    if error.kind() == std::io::ErrorKind::NotFound {
        file_error(path, error)
    } else {
        SpacePreviewError::internal(format!(
            "The file metadata could not be read: {} ({error})",
            path.display()
        ))
    }
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_else(|| path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

/// A short, stable identity for the canonical path: FNV-1a, hex encoded.
///
/// The id keys preview targets for one run; it is not persisted and does not
/// need to survive a restart or a Rust upgrade.
fn identity(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "space-preview-b1-{label}-{}-{stamp}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn write_fixture(directory: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn admitting(path: &Path) -> PreviewState {
        let state = PreviewState::default();
        state.allow(path).unwrap();
        state
    }

    #[test]
    fn etag_is_size_and_millis() {
        assert_eq!(etag_of(12, 34), "12-34");
        assert_ne!(etag_of(12, 34), etag_of(13, 34));
    }

    #[test]
    fn inspect_describes_a_file_and_admits_it() {
        let directory = temp_dir("inspect");
        let path = write_fixture(&directory, "note.txt", b"hello");
        let state = PreviewState::default();

        let info = inspect(&path, &state).unwrap();

        assert_eq!(info.name, "note.txt");
        assert_eq!(info.size, 5);
        assert!(!info.directory);
        assert_eq!(info.mime, "text/plain");
        assert_eq!(info.etag, etag_of(5, info.modified));
        assert_eq!(info.id.len(), 16);
        assert!(state.check(&path).is_ok());
    }

    #[test]
    fn inspect_canonicalizes_relative_segments() {
        let directory = temp_dir("canonical");
        let nested = directory.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let path = write_fixture(&directory, "note.txt", b"hello");
        let state = PreviewState::default();

        let info = inspect(&nested.join("..").join("note.txt"), &state).unwrap();

        assert_eq!(
            info.path,
            fs::canonicalize(&path)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );
        assert!(!info.path.contains(".."));
    }

    #[test]
    fn inspect_reports_a_directory() {
        let directory = temp_dir("directory");
        let state = PreviewState::default();

        let info = inspect(&directory, &state).unwrap();

        assert!(info.directory);
        assert_eq!(
            info.name,
            directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );
    }

    #[test]
    fn inspect_missing_path_is_not_found() {
        let directory = temp_dir("missing");
        let state = PreviewState::default();

        let error = inspect(&directory.join("absent.txt"), &state).unwrap_err();

        assert_eq!(error.code, "not-found");
    }

    #[test]
    fn read_without_inspect_is_refused() {
        let directory = temp_dir("unauthorized");
        let path = write_fixture(&directory, "note.txt", b"hello");
        let state = PreviewState::default();

        let error = read_prefix(&path, 4, &state).unwrap_err();
        assert_eq!(error.code, "not-authorized");

        let error = read_range(&path, 0, 4, &state).unwrap_err();
        assert_eq!(error.code, "not-authorized");
    }

    #[test]
    fn read_prefix_honours_the_limit() {
        let directory = temp_dir("prefix");
        let path = write_fixture(&directory, "note.txt", b"hello world");
        let state = admitting(&path);

        assert_eq!(read_prefix(&path, 5, &state).unwrap(), b"hello");
    }

    #[test]
    fn read_prefix_zero_is_empty() {
        let directory = temp_dir("prefix-zero");
        let path = write_fixture(&directory, "note.txt", b"hello");
        let state = admitting(&path);

        assert!(read_prefix(&path, 0, &state).unwrap().is_empty());
    }

    #[test]
    fn read_prefix_rejects_over_the_cap() {
        let directory = temp_dir("prefix-cap");
        let path = write_fixture(&directory, "note.txt", b"hello");
        let state = admitting(&path);

        let error = read_prefix(&path, MAX_READ + 1, &state).unwrap_err();

        assert_eq!(error.code, "too-large");
    }

    #[test]
    fn read_range_reads_the_window() {
        let directory = temp_dir("range");
        let path = write_fixture(&directory, "note.txt", b"0123456789");
        let state = admitting(&path);

        assert_eq!(read_range(&path, 3, 4, &state).unwrap(), b"3456");
    }

    #[test]
    fn read_range_past_the_end_is_empty() {
        let directory = temp_dir("range-past");
        let path = write_fixture(&directory, "note.txt", b"0123456789");
        let state = admitting(&path);

        assert!(read_range(&path, 100, 4, &state).unwrap().is_empty());
    }

    #[test]
    fn read_range_overflow_is_rejected() {
        let directory = temp_dir("range-overflow");
        let path = write_fixture(&directory, "note.txt", b"0123456789");
        let state = admitting(&path);

        let error = read_range(&path, usize::MAX, 2, &state).unwrap_err();

        assert_eq!(error.code, "invalid-input");
    }

    #[test]
    fn read_range_rejects_over_the_cap() {
        let directory = temp_dir("range-cap");
        let path = write_fixture(&directory, "note.txt", b"0123456789");
        let state = admitting(&path);

        let error = read_range(&path, 0, MAX_READ + 1, &state).unwrap_err();

        assert_eq!(error.code, "too-large");
    }

    #[test]
    fn read_rejects_a_directory() {
        let directory = temp_dir("read-directory");
        let state = admitting(&directory);

        let error = read_prefix(&directory, 4, &state).unwrap_err();

        assert_eq!(error.code, "invalid-input");
    }
}
