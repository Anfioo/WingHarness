//! Windows candidate stream for large-file discovery.
//!
//! `FindFirstFileExW` returns the file type, size, and safety attributes in one
//! directory enumeration, which avoids a metadata query per entry that the
//! generic `read_dir + symlink_metadata` traversal pays. The implementation still
//! walks the complete tree and performs no Windows Search queries; Core
//! revalidates every candidate against live metadata before publishing it.
//!
//! The reference engine first asked an indexed file-layout provider for
//! candidates. That provider is not part of this crate, so the Win32 enumeration
//! below is the fast path and the shared traversal stays the universal fallback.
use std::{
    ffi::{c_void, OsString},
    io,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    time::Instant,
};

use windows_sys::Win32::{
    Foundation::{
        GetLastError, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES,
        ERROR_NOT_SUPPORTED, HANDLE, INVALID_HANDLE_VALUE,
    },
    Storage::FileSystem::{
        FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FIND_FIRST_EX_LARGE_FETCH,
        WIN32_FIND_DATAW,
    },
};

use crate::platform::contracts::{
    LargeFileCandidateScanError, LargeFileCandidateSummary, Platform, ScanPurpose,
};

use super::{is_remote_placeholder_attributes, WindowsPlatform};

struct FindHandle(HANDLE);

impl Drop for FindHandle {
    fn drop(&mut self) {
        // SAFETY: the handle was returned by `FindFirstFileExW` and is closed once here.
        unsafe {
            FindClose(self.0);
        }
    }
}

struct CandidateCollection<'a> {
    excluded_roots: &'a [PathBuf],
    pending: Vec<PathBuf>,
    consumer: &'a mut dyn FnMut(PathBuf) -> Result<(), String>,
    candidate_count: u64,
    skipped_count: u64,
    remote_placeholder_count: u64,
    consumer_wait_nanos: u64,
    large_fetch_enabled: bool,
}

impl CandidateCollection<'_> {
    fn emit(&mut self, path: PathBuf) -> Result<(), EnumerateError> {
        let started = Instant::now();
        (self.consumer)(path).map_err(EnumerateError::Consumer)?;
        self.consumer_wait_nanos = self
            .consumer_wait_nanos
            .saturating_add(u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX));
        self.candidate_count = self.candidate_count.saturating_add(1);
        Ok(())
    }
}

/// Windows implementation of the shared scan kernel's candidate fast path.
///
/// The `Platform` trait is implemented as one block in `kernel.rs`, which this
/// lane does not own. `current_platform()` returns the concrete
/// `WindowsPlatform`, so the inherent methods below are selected ahead of the
/// trait defaults at every call site without a second, conflicting trait impl.
pub(crate) fn find_candidates(
    platform: &WindowsPlatform,
    root: &Path,
    minimum_bytes: u64,
    excluded_roots: &[PathBuf],
    is_cancelled: &(dyn Fn() -> bool + Sync),
    consumer: &mut dyn FnMut(PathBuf) -> Result<(), String>,
) -> Result<LargeFileCandidateSummary, LargeFileCandidateScanError> {
    let mut native_directory_reads = 0;
    let mut collection = CandidateCollection {
        excluded_roots,
        pending: vec![root.to_path_buf()],
        consumer,
        candidate_count: 0,
        skipped_count: 0,
        remote_placeholder_count: 0,
        consumer_wait_nanos: 0,
        large_fetch_enabled: true,
    };
    while let Some(directory) = collection.pending.pop() {
        if is_cancelled() {
            return Err(LargeFileCandidateScanError::Cancelled);
        }
        native_directory_reads += 1;
        let result = enumerate_directory(
            platform,
            root,
            &directory,
            minimum_bytes,
            &mut collection,
            is_cancelled,
        );
        if let Err(error) = result {
            if is_cancelled() {
                return Err(LargeFileCandidateScanError::Cancelled);
            }
            match error {
                EnumerateError::Consumer(error) => {
                    return Err(LargeFileCandidateScanError::Consumer(error));
                }
                EnumerateError::Io(error) if directory == root => {
                    return Err(LargeFileCandidateScanError::Platform(format!(
                        "scan_root_enumeration_failed error_kind={:?} os_error={:?}",
                        error.kind(),
                        error.raw_os_error()
                    )));
                }
                EnumerateError::Io(error) => {
                    log::debug!(
                        "windows_large_file_directory_skipped error_kind={:?} os_error={:?}",
                        error.kind(),
                        error.raw_os_error()
                    );
                    collection.skipped_count += 1;
                }
            }
        }
    }
    if collection.remote_placeholder_count > 0 {
        log::info!(
            "windows_large_file_remote_placeholders_skipped count={} strategy=win32_directory_enumeration",
            collection.remote_placeholder_count
        );
    }
    Ok(LargeFileCandidateSummary {
        native_directory_reads,
        candidate_count: collection.candidate_count,
        skipped_count: collection.skipped_count,
        consumer_elapsed_ms: collection.consumer_wait_nanos / 1_000_000,
        producer_backpressure_ms: collection.consumer_wait_nanos / 1_000_000,
        peak_in_flight_candidates: usize::from(collection.candidate_count > 0),
        strategy: if collection.large_fetch_enabled {
            "win32_large_fetch_resident_stream_v2"
        } else {
            "win32_resident_stream_v2"
        },
    })
}

impl WindowsPlatform {
    /// Streams size-qualified candidates from the Win32 directory walk.
    ///
    /// Inherent methods take precedence over trait methods for a concrete
    /// receiver, so `current_platform().fast_large_file_candidates(...)` uses
    /// this implementation instead of the trait default that returns `None`.
    pub(crate) fn fast_large_file_candidates(
        &self,
        root: &Path,
        minimum_bytes: u64,
        excluded_roots: &[PathBuf],
        is_cancelled: &(dyn Fn() -> bool + Sync),
        consumer: &mut dyn FnMut(PathBuf) -> Result<(), String>,
    ) -> Result<Option<LargeFileCandidateSummary>, LargeFileCandidateScanError> {
        find_candidates(
            self,
            root,
            minimum_bytes,
            excluded_roots,
            is_cancelled,
            consumer,
        )
        .map(Some)
    }

    /// The Win32 walk reaches every file in the scope, so no indexed source is needed.
    pub(crate) fn fast_large_file_candidates_are_complete(&self) -> bool {
        true
    }
}

#[derive(Debug)]
enum EnumerateError {
    Io(io::Error),
    Consumer(String),
}

impl std::fmt::Display for EnumerateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Consumer(error) => formatter.write_str(error),
        }
    }
}

fn enumerate_directory(
    platform: &WindowsPlatform,
    scan_root: &Path,
    directory: &Path,
    minimum_bytes: u64,
    collection: &mut CandidateCollection<'_>,
    is_cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<(), EnumerateError> {
    let mut pattern = directory.to_path_buf();
    pattern.push("*");
    let wide_pattern = pattern
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut data = WIN32_FIND_DATAW::default();
    let mut raw_handle = find_first(&wide_pattern, &mut data, collection.large_fetch_enabled);
    if raw_handle == INVALID_HANDLE_VALUE && collection.large_fetch_enabled {
        // SAFETY: `FindFirstFileExW` just failed, so this reads the error it stored.
        let error = unsafe { GetLastError() };
        if large_fetch_is_unsupported(error) {
            // Older systems and some network filesystems reject LARGE_FETCH.
            // Disable it and retry this directory only for explicit
            // unsupported errors; permission and path failures retain the
            // ordinary skip or fallback behavior.
            collection.large_fetch_enabled = false;
            raw_handle = find_first(&wide_pattern, &mut data, false);
        }
    }
    if raw_handle == INVALID_HANDLE_VALUE {
        return Err(EnumerateError::Io(io::Error::last_os_error()));
    }
    let handle = FindHandle(raw_handle);

    loop {
        if is_cancelled() {
            return Err(EnumerateError::Io(io::Error::new(
                io::ErrorKind::Interrupted,
                "scan cancelled",
            )));
        }
        collect_entry(
            platform,
            scan_root,
            directory,
            &data,
            minimum_bytes,
            collection,
        )?;
        // SAFETY: `handle` is open for the loop body and `data` is writable.
        if unsafe { FindNextFileW(handle.0, &mut data) } == 0 {
            // SAFETY: `FindNextFileW` just failed, so this reads the error it stored.
            let error = unsafe { GetLastError() };
            if error == ERROR_NO_MORE_FILES {
                return Ok(());
            }
            return Err(EnumerateError::Io(io::Error::from_raw_os_error(
                error as i32,
            )));
        }
    }
}

fn large_fetch_is_unsupported(error: u32) -> bool {
    matches!(
        error,
        ERROR_INVALID_FUNCTION | ERROR_INVALID_PARAMETER | ERROR_NOT_SUPPORTED
    )
}

fn find_first(wide_pattern: &[u16], data: &mut WIN32_FIND_DATAW, large_fetch: bool) -> HANDLE {
    // SAFETY: `wide_pattern` is NUL terminated and `data` is a valid output buffer.
    unsafe {
        FindFirstFileExW(
            wide_pattern.as_ptr(),
            FindExInfoBasic,
            data as *mut WIN32_FIND_DATAW as *mut c_void,
            FindExSearchNameMatch,
            std::ptr::null(),
            if large_fetch {
                FIND_FIRST_EX_LARGE_FETCH
            } else {
                0
            },
        )
    }
}

fn collect_entry(
    platform: &WindowsPlatform,
    scan_root: &Path,
    directory: &Path,
    data: &WIN32_FIND_DATAW,
    minimum_bytes: u64,
    collection: &mut CandidateCollection<'_>,
) -> Result<(), EnumerateError> {
    let name_length = data
        .cFileName
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(data.cFileName.len());
    let name = OsString::from_wide(&data.cFileName[..name_length]);
    if name == "." || name == ".." {
        return Ok(());
    }
    // Opening a placeholder recalls remote content and would make a scan perform
    // network or archival I/O the user never requested.
    if is_remote_placeholder_attributes(data.dwFileAttributes) {
        collection.remote_placeholder_count = collection.remote_placeholder_count.saturating_add(1);
        collection.skipped_count += 1;
        return Ok(());
    }
    // Junctions and symlinks can leave the selected scope or form cycles.
    if data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        collection.skipped_count += 1;
        return Ok(());
    }

    let path = directory.join(name);
    if data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        if collection
            .excluded_roots
            .iter()
            .any(|root| platform.path_is_same_or_child(&path, root))
        {
            return Ok(());
        }
        if platform
            .should_skip(&path, scan_root, ScanPurpose::LargeFiles)
            .is_none()
        {
            collection.pending.push(path);
        } else {
            collection.skipped_count += 1;
        }
        return Ok(());
    }

    let bytes = (u64::from(data.nFileSizeHigh) << 32) | u64::from(data.nFileSizeLow);
    if bytes >= minimum_bytes {
        collection.emit(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collection<'a>(
        consumer: &'a mut dyn FnMut(PathBuf) -> Result<(), String>,
    ) -> CandidateCollection<'a> {
        CandidateCollection {
            excluded_roots: &[],
            pending: Vec::new(),
            consumer,
            candidate_count: 0,
            skipped_count: 0,
            remote_placeholder_count: 0,
            consumer_wait_nanos: 0,
            large_fetch_enabled: true,
        }
    }

    #[test]
    fn large_fetch_falls_back_only_for_explicit_unsupported_errors() {
        assert!(large_fetch_is_unsupported(ERROR_INVALID_FUNCTION));
        assert!(large_fetch_is_unsupported(ERROR_INVALID_PARAMETER));
        assert!(large_fetch_is_unsupported(ERROR_NOT_SUPPORTED));
        assert!(!large_fetch_is_unsupported(
            windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED
        ));
    }

    #[test]
    fn direct_candidate_stream_stops_on_consumer_failure() {
        let mut consumed = 0_u64;
        let mut consumer = |_: PathBuf| {
            consumed += 1;
            if consumed == 2 {
                Err("fixture consumer failure".to_string())
            } else {
                Ok(())
            }
        };
        let mut collection = collection(&mut consumer);

        collection
            .emit(PathBuf::from("first.bin"))
            .expect("the first candidate should succeed");
        let error = collection
            .emit(PathBuf::from("second.bin"))
            .expect_err("consumer failure must stop enumeration unchanged");

        assert!(matches!(
            error,
            EnumerateError::Consumer(ref detail) if detail == "fixture consumer failure"
        ));
        assert_eq!(collection.candidate_count, 1);
    }

    #[test]
    fn win32_fallback_skips_remote_only_candidates() {
        let mut consumed = 0_u64;
        let mut consumer = |_: PathBuf| {
            consumed += 1;
            Ok(())
        };
        let mut collection = collection(&mut consumer);
        let mut data = WIN32_FIND_DATAW {
            dwFileAttributes: 0x0000_1000,
            nFileSizeLow: 1024,
            ..Default::default()
        };
        data.cFileName[0] = b'x' as u16;

        collect_entry(
            &WindowsPlatform,
            Path::new(r"C:\"),
            Path::new(r"C:\fixture"),
            &data,
            1,
            &mut collection,
        )
        .expect("remote-only candidate should be skipped");

        assert_eq!(collection.skipped_count, 1);
        assert_eq!(collection.remote_placeholder_count, 1);
        assert_eq!(collection.candidate_count, 0);
        assert_eq!(consumed, 0);
    }

    #[test]
    fn reparse_point_entries_are_skipped_without_being_emitted() {
        let mut consumer = |_: PathBuf| Ok(());
        let mut collection = collection(&mut consumer);
        let mut data = WIN32_FIND_DATAW {
            dwFileAttributes: FILE_ATTRIBUTE_REPARSE_POINT,
            nFileSizeLow: 4096,
            ..Default::default()
        };
        data.cFileName[0] = b'x' as u16;

        collect_entry(
            &WindowsPlatform,
            Path::new(r"C:\"),
            Path::new(r"C:\fixture"),
            &data,
            1,
            &mut collection,
        )
        .expect("a reparse point is not a candidate");

        assert_eq!(collection.skipped_count, 1);
        assert_eq!(collection.candidate_count, 0);
    }

    #[test]
    fn root_enumeration_error_does_not_expose_the_private_path() {
        let private_root =
            std::env::temp_dir().join(format!("mangodisk-private-root-{}-Δ", std::process::id()));
        assert!(
            !private_root.exists(),
            "the missing-root fixture must not already exist"
        );
        let mut consumer = |_: PathBuf| Ok(());

        let error = find_candidates(
            &WindowsPlatform,
            &private_root,
            1,
            &[],
            &|| false,
            &mut consumer,
        )
        .expect_err("a missing scan root should fail");
        let LargeFileCandidateScanError::Platform(detail) = error else {
            panic!("a missing scan root should report a platform error");
        };

        assert!(detail.starts_with("scan_root_enumeration_failed"));
        assert!(!detail.contains(private_root.to_string_lossy().as_ref()));
        assert!(!detail.contains("mangodisk-private-root"));
    }
}
