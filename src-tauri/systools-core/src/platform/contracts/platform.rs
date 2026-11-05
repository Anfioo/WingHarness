//! Windows-only subset of the reference `Platform` trait.
//!
//! The port keeps every filesystem safety capability the scan kernel depends on
//! and drops adapter methods owned by lanes that have not landed yet. Default
//! implementations stay byte-for-byte compatible with the reference engine so a
//! missing fast path always falls back to the bounded portable walker.

use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use super::{
    DirectPhysicalDirectoryEnumeration, DirectoryEntryIdentities, DirectoryTreeAggregate,
    DirectoryTreeAggregateError, FastAnalysisQuery, FastAnalysisRecord, FastAnalysisScanError,
    FastAnalysisSummary, FileSpaceUsage, FilesystemChangeImpactError,
    FilesystemChangeImpactOutcome, FilesystemChangeMonitor, FilesystemChangeToken,
    LargeFileCandidateScanError, LargeFileCandidateSummary, PhysicalFileIdentity, PlatformError,
    PlatformResult, ScanPurpose, SkipReason, UserDirectories, VolumeInfo,
};

/// Cloneable cancellation boundary for platform operations that retain a
/// callback while native code is running.
#[derive(Clone)]
pub struct PlatformCancellation {
    probe: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl PlatformCancellation {
    pub fn new(probe: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            probe: Arc::new(probe),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        (self.probe)()
    }
}

pub trait Platform: Send + Sync {
    /// Classifies OS-owned volume files without opening them or requiring elevation.
    /// Analysis may display their space usage, but ordinary deletion must reject them.
    fn is_system_managed_file(&self, _path: &Path) -> bool {
        false
    }

    /// Classifies scopes that ordinary deletion must preserve as a whole.
    fn is_protected_deletion_path(&self, path: &Path) -> bool {
        self.should_skip(path, &self.system_volume_path(), ScanPurpose::LargeFiles)
            .is_some()
    }

    /// Reserved directory names must also survive deletion of an enclosing tree.
    fn protected_deletion_folder_names(&self) -> &'static [&'static str] {
        &[]
    }

    /// Compares a known scan identity without requiring multiple links to remain.
    fn matches_file_identity(&self, metadata: &fs::Metadata, identity: PhysicalFileIdentity) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            metadata.is_file()
                && metadata.dev() == identity.volume
                && metadata.ino() == identity.index
        }
        #[cfg(not(unix))]
        {
            let _ = (metadata, identity);
            false
        }
    }

    /// Returns an identity only when allocation can be shared by multiple directory entries.
    fn hard_link_identity(&self, metadata: &fs::Metadata) -> Option<PhysicalFileIdentity> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            (metadata.is_file() && metadata.nlink() > 1).then(|| PhysicalFileIdentity {
                volume: metadata.dev(),
                index: metadata.ino(),
            })
        }
        #[cfg(not(unix))]
        {
            let _ = metadata;
            None
        }
    }

    fn os_name(&self) -> &'static str;
    fn system_volume_path(&self) -> PathBuf;
    fn system_volume(&self) -> PlatformResult<VolumeInfo>;
    fn volumes(&self) -> PlatformResult<Vec<VolumeInfo>>;
    fn user_directories(&self) -> PlatformResult<UserDirectories>;

    /// Classifies entries that must not be opened as ordinary resident files.
    fn is_link_like(&self, metadata: &fs::Metadata) -> bool;

    /// Reports whether two entries belong to the same mounted filesystem.
    fn is_same_filesystem(&self, _root: &fs::Metadata, _candidate: &fs::Metadata) -> bool {
        true
    }

    /// Returns both identity and volume-usage sizes from one filesystem snapshot.
    fn file_space_usage(&self, _path: &Path, metadata: &fs::Metadata) -> FileSpaceUsage {
        FileSpaceUsage::logical_only(metadata.len())
    }

    /// Reports whether an already-open file has any physically allocated content range.
    fn file_has_allocated_content(
        &self,
        _file: &fs::File,
        _logical_bytes: u64,
    ) -> PlatformResult<Option<bool>> {
        Ok(None)
    }

    /// Returns stable physical identities for immediate directory entries in one native batch.
    fn directory_entry_identities(
        &self,
        _directory: &Path,
        _cancellation: &PlatformCancellation,
    ) -> PlatformResult<Option<DirectoryEntryIdentities>> {
        Ok(None)
    }

    /// Converts a native path to the stable representation exposed across adapter boundaries.
    fn display_path(&self, path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// Produces a stable platform identity key for sorting, hashing, and deduplication.
    fn path_identity_key(&self, path: &Path) -> String {
        let value = self.display_path(path);
        let trimmed = value.trim_end_matches(std::path::MAIN_SEPARATOR);
        if trimmed.is_empty() && !value.is_empty() {
            std::path::MAIN_SEPARATOR.to_string()
        } else {
            trimmed.to_string()
        }
    }

    /// Reports whether two paths identify the same platform location.
    fn paths_equal(&self, left: &Path, right: &Path) -> bool {
        self.path_identity_key(left) == self.path_identity_key(right)
    }

    /// Reports whether a path is equal to or contained by a root according to
    /// platform path identity rules.
    fn path_is_same_or_child(&self, path: &Path, root: &Path) -> bool {
        path.starts_with(root)
    }

    /// Returns the lexical path below `root` using the same platform identity
    /// semantics as `path_is_same_or_child`.
    fn relative_path(&self, path: &Path, root: &Path) -> Option<PathBuf> {
        if self.paths_equal(path, root) {
            return Some(PathBuf::new());
        }
        path.strip_prefix(root).ok().map(Path::to_path_buf)
    }

    fn validate_path_no_links(&self, path: &Path) -> PlatformResult<()> {
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|error| PlatformError::io("locate current directory", &error))?
                .join(path)
        };
        for component_path in absolute.ancestors().collect::<Vec<_>>().into_iter().rev() {
            if component_path.as_os_str().is_empty() {
                continue;
            }
            let metadata = fs::symlink_metadata(component_path)
                .map_err(|error| PlatformError::io("validate path metadata", &error))?;
            if self.is_link_like(&metadata) && !self.is_allowed_system_path_alias(component_path) {
                return Err(PlatformError::invalid_path(
                    "path contains a link or reparse point",
                ));
            }
        }
        Ok(())
    }

    /// Fixed OS compatibility aliases; Windows has none.
    fn is_allowed_system_path_alias(&self, _path: &Path) -> bool {
        false
    }

    /// Resolves an explicitly selected directory or an OS-provided folder shortcut.
    fn resolve_directory_entry(&self, path: &Path) -> PlatformResult<PathBuf> {
        self.canonicalize_no_links(path)
    }

    fn canonicalize_no_links(&self, path: &Path) -> PlatformResult<PathBuf> {
        self.validate_path_no_links(path)?;
        let canonical =
            fs::canonicalize(path).map_err(|error| PlatformError::io("access path", &error))?;
        self.validate_path_no_links(path)?;
        let verified =
            fs::canonicalize(path).map_err(|error| PlatformError::io("revalidate path", &error))?;
        if canonical != verified {
            return Err(PlatformError::invalid_path(
                "path changed during validation",
            ));
        }
        Ok(canonical)
    }

    fn should_skip(&self, path: &Path, scan_root: &Path, purpose: ScanPurpose)
        -> Option<SkipReason>;

    fn validate_cleanup_root(&self, path: &Path) -> PlatformResult<()>;

    /// Validates a cleanup root chosen explicitly by the user.
    fn validate_user_selected_cleanup_root(&self, path: &Path) -> PlatformResult<()> {
        self.validate_cleanup_root(path)
    }

    /// Measures a complete directory through a platform-native bulk traversal.
    fn fast_directory_tree_aggregate(
        &self,
        _root: &Path,
        _is_cancelled: &(dyn Fn() -> bool + Sync),
        _report_progress: &(dyn Fn(&Path, u64, u64) + Sync),
    ) -> Result<Option<DirectoryTreeAggregate>, DirectoryTreeAggregateError> {
        Ok(None)
    }

    /// Measures one generated project-artifact tree through a native bulk traversal.
    fn fast_project_artifact_tree_aggregate(
        &self,
        _root: &Path,
        _is_cancelled: &(dyn Fn() -> bool + Sync),
        _report_progress: &(dyn Fn(&Path, u64, u64) + Sync),
        _flag_entry_name: fn(&OsStr) -> bool,
    ) -> Result<Option<DirectoryTreeAggregate>, DirectoryTreeAggregateError> {
        Ok(None)
    }

    /// Enumerates physical direct-child directories without a metadata syscall per entry.
    fn fast_direct_physical_directories(
        &self,
        _root: &Path,
        _maximum_entries: usize,
        _is_cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<Option<DirectPhysicalDirectoryEnumeration>, DirectoryTreeAggregateError> {
        Ok(None)
    }

    /// Captures an event boundary before a full scan.
    fn capture_filesystem_change_token(
        &self,
        _root: &Path,
    ) -> PlatformResult<Option<FilesystemChangeToken>> {
        Ok(None)
    }

    /// Catches up history from a token and monitors the current session.
    fn start_filesystem_change_monitor(
        &self,
        _root: &Path,
        _token: &FilesystemChangeToken,
        _is_cancelled: &(dyn Fn() -> bool + Sync),
    ) -> PlatformResult<Option<FilesystemChangeMonitor>> {
        Ok(None)
    }

    /// Reports whether the monitor continues after history catch-up.
    fn filesystem_change_monitor_is_continuous(&self) -> bool {
        false
    }

    /// Computes directories requiring remeasurement between a stable token and
    /// the fixed upper boundary captured when the call starts.
    fn filesystem_change_impact_plan(
        &self,
        _root: &Path,
        _token: &FilesystemChangeToken,
        _is_cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<Option<FilesystemChangeImpactOutcome>, FilesystemChangeImpactError> {
        Ok(None)
    }

    /// Streams size-qualified candidates from a platform fast path.
    fn fast_large_file_candidates(
        &self,
        _root: &Path,
        _minimum_bytes: u64,
        _excluded_roots: &[PathBuf],
        _is_cancelled: &(dyn Fn() -> bool + Sync),
        _consumer: &mut dyn FnMut(PathBuf) -> Result<(), String>,
    ) -> Result<Option<LargeFileCandidateSummary>, LargeFileCandidateScanError> {
        Ok(None)
    }

    /// Reports whether the native candidate source covers every reachable file in the scope.
    fn fast_large_file_candidates_are_complete(&self) -> bool {
        false
    }

    /// Streams complete directory aggregates and large-file index candidates.
    fn fast_analysis_records(
        &self,
        _query: FastAnalysisQuery<'_>,
        _is_cancelled: &(dyn Fn() -> bool + Sync),
        _report_progress: &mut dyn FnMut(&Path, u64, u64),
        _consumer: &mut dyn FnMut(FastAnalysisRecord) -> Result<(), String>,
    ) -> Result<Option<FastAnalysisSummary>, FastAnalysisScanError> {
        Ok(None)
    }
}

/// Returns the stateless adapter for the current operating system.
pub fn current_platform() -> crate::platform::windows::WindowsPlatform {
    crate::platform::windows::WindowsPlatform
}
