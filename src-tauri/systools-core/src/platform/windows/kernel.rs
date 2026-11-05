//! Stateless Windows platform adapter for the shared scan kernel.
//!
//! The reference engine split these capabilities across a platform crate. The
//! port keeps the same native policy and helper modules, while fast paths owned
//! by the analysis and large-file lanes stay on their portable defaults until
//! those lanes land.

use std::{
    ffi::OsStr,
    fs,
    os::windows::ffi::OsStrExt,
    os::windows::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};

use crate::platform::contracts::{
    DirectPhysicalDirectoryEnumeration, DirectoryEntryIdentities, DirectoryTreeAggregate,
    DirectoryTreeAggregateError, FileSpaceUsage, FilesystemChangeImpactError,
    FilesystemChangeImpactOutcome, FilesystemChangeMonitor, FilesystemChangeToken, Platform,
    PlatformCancellation, PlatformError, PlatformErrorCode, PlatformResult, ScanPurpose,
    SkipReason, UserDirectories, VolumeInfo,
};

use super::{
    allocated_content, change_tracking, directory_aggregate, directory_entry,
    directory_identity, directories, file_space, path_identity, volumes,
};

pub struct WindowsPlatform;

pub(crate) const FILE_ATTRIBUTE_REPARSE_POINT_VALUE: u32 = 0x0000_0400;
const FILE_ATTRIBUTE_OFFLINE_VALUE: u32 = 0x0000_1000;
const FILE_ATTRIBUTE_RECALL_ON_OPEN_VALUE: u32 = 0x0004_0000;
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS_VALUE: u32 = 0x0040_0000;

/// Returns whether opening an entry can recall content from remote or offline storage.
pub(crate) fn is_remote_placeholder_attributes(attributes: u32) -> bool {
    attributes
        & (FILE_ATTRIBUTE_OFFLINE_VALUE
            | FILE_ATTRIBUTE_RECALL_ON_OPEN_VALUE
            | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS_VALUE)
        != 0
}

/// Applies the metadata link policy to attributes returned by native handle queries.
pub fn windows_file_attributes_are_link_like(attributes: u32) -> bool {
    attributes & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0
        || is_remote_placeholder_attributes(attributes)
}

impl Platform for WindowsPlatform {
    fn os_name(&self) -> &'static str {
        "windows"
    }

    fn system_volume_path(&self) -> PathBuf {
        volumes::system_drive_path()
    }

    fn system_volume(&self) -> PlatformResult<VolumeInfo> {
        volumes::system_volume().map_err(Into::into)
    }

    fn volumes(&self) -> PlatformResult<Vec<VolumeInfo>> {
        volumes::volumes().map_err(Into::into)
    }

    fn user_directories(&self) -> PlatformResult<UserDirectories> {
        directories::user_directories()
    }

    fn resolve_directory_entry(&self, path: &Path) -> PlatformResult<PathBuf> {
        directory_entry::resolve(path)
    }

    fn is_link_like(&self, metadata: &fs::Metadata) -> bool {
        let attributes = metadata.file_attributes();
        metadata.file_type().is_symlink() || windows_file_attributes_are_link_like(attributes)
    }

    fn file_space_usage(&self, path: &Path, metadata: &fs::Metadata) -> FileSpaceUsage {
        file_space::usage(path, metadata)
    }

    fn file_has_allocated_content(
        &self,
        file: &fs::File,
        logical_bytes: u64,
    ) -> PlatformResult<Option<bool>> {
        allocated_content::has_allocated_content(file, logical_bytes)
    }

    fn directory_entry_identities(
        &self,
        directory: &Path,
        cancellation: &PlatformCancellation,
    ) -> PlatformResult<Option<DirectoryEntryIdentities>> {
        directory_identity::read(directory, cancellation)
            .map(Some)
            .map_err(|error| {
                if cancellation.is_cancelled() {
                    PlatformError::new(
                        PlatformErrorCode::UserCancelled,
                        "directory identity enumeration cancelled",
                    )
                } else {
                    PlatformError::io("read directory entry identities", &error)
                }
            })
    }

    fn display_path(&self, path: &Path) -> String {
        path_identity::display(path)
    }

    fn path_identity_key(&self, path: &Path) -> String {
        path_identity::comparison_key(path)
    }

    fn paths_equal(&self, left: &Path, right: &Path) -> bool {
        path_identity::equal(left, right)
    }

    fn path_is_same_or_child(&self, path: &Path, root: &Path) -> bool {
        path_identity::is_same_or_child(path, root)
    }

    fn relative_path(&self, path: &Path, root: &Path) -> Option<PathBuf> {
        if path_identity::equal(path, root) {
            return Some(PathBuf::new());
        }
        path_identity::relative_child_path(path, root)
    }

    fn is_system_managed_file(&self, path: &Path) -> bool {
        if !path.is_absolute() {
            return false;
        }
        // Resolve lexical parents only on unusual adapter inputs. Ordinary scan
        // paths stay allocation-free in the traversal hot path.
        let normalized;
        let path = if path.components().any(|part| part == Component::ParentDir) {
            normalized = path.components().fold(PathBuf::new(), |mut result, part| {
                if part == Component::ParentDir {
                    result.pop();
                } else {
                    result.push(part.as_os_str());
                }
                result
            });
            normalized.as_path()
        } else {
            path
        };
        let mut components = path.components();
        let trim_win32_suffix = match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                std::path::Prefix::Disk(_) => true,
                std::path::Prefix::VerbatimDisk(_) => false,
                std::path::Prefix::DeviceNS(drive)
                    if matches!(drive.as_encoded_bytes(), [letter, b':'] if letter.is_ascii_alphabetic()) =>
                {
                    false
                }
                _ => return false,
            },
            _ => return false,
        };
        if components.next() != Some(Component::RootDir) {
            return false;
        }
        let Some(Component::Normal(name)) = components.next() else {
            return false;
        };
        // Streams belong to the protected file. Ordinary Win32 paths also ignore
        // trailing dots/spaces; verbatim names retain those literal suffixes.
        let mut name = name
            .as_encoded_bytes()
            .split(|byte| *byte == b':')
            .next()
            .unwrap_or_default();
        if trim_win32_suffix {
            while name.last().is_some_and(|byte| matches!(byte, b'.' | b' ')) {
                name = &name[..name.len() - 1];
            }
        }
        components.next().is_none()
            && [
                "hiberfil.sys",
                "pagefile.sys",
                "swapfile.sys",
                "dumpstack.log.tmp",
            ]
            .into_iter()
            .any(|value| name.eq_ignore_ascii_case(value.as_bytes()))
    }

    fn should_skip(
        &self,
        path: &Path,
        scan_root: &Path,
        purpose: ScanPurpose,
    ) -> Option<SkipReason> {
        // Read-only analysis may measure protected scopes. Mutation authorization remains
        // independent through is_protected_deletion_path and the deletion preflight.
        if matches!(purpose, ScanPurpose::Cleanup | ScanPurpose::Analysis) {
            return None;
        }
        let mut components = path.components().filter_map(|component| match component {
            Component::Normal(value) => Some(value),
            _ => None,
        });
        let first = components.next();
        let second = components.next();

        // This runs in the full-volume traversal hot path. Comparing Windows
        // UTF-16 components directly avoids allocating a lowercase String and
        // formatting temporary values for every visited entry.
        let first_is = |value| first.is_some_and(|part| os_str_eq_ascii_case(part, value));
        let second_is = |value| second.is_some_and(|part| os_str_eq_ascii_case(part, value));
        if matches!(
            purpose,
            ScanPurpose::LargeFiles | ScanPurpose::DuplicateFiles
        ) && second.is_none()
            && self.is_system_managed_file(path)
        {
            // These files are owned by Windows memory and power management.
            return Some(SkipReason::SystemCritical);
        }
        if purpose == ScanPurpose::DuplicateFiles
            && [
                "$windows.~bt",
                "$windows.~ws",
                "windows.old",
                "config.msi",
                "msocache",
                "perflogs",
            ]
            .into_iter()
            .any(first_is)
        {
            return Some(SkipReason::SystemCritical);
        }
        if first_is("system volume information")
            || first_is("$recycle.bin")
            || first_is("recovery")
            || first_is("$winreagent")
            || (first_is("windows")
                && (second_is("winsxs") || second_is("installer") || second_is("system32")))
        {
            return Some(SkipReason::SystemCritical);
        }
        if matches!(
            purpose,
            ScanPurpose::LargeFiles | ScanPurpose::DuplicateFiles
        ) && (first_is("windows")
            || first_is("program files")
            || first_is("program files (x86)")
            || first_is("programdata"))
        {
            return Some(SkipReason::SystemCritical);
        }
        if purpose == ScanPurpose::DuplicateFiles
            && is_transient_duplicate_scope(path)
            && !is_transient_duplicate_scope(scan_root)
        {
            return Some(SkipReason::SystemCritical);
        }
        None
    }

    fn validate_cleanup_root(&self, path: &Path) -> PlatformResult<()> {
        let canonical = fs::canonicalize(path)
            .map_err(|error| PlatformError::io("canonicalize path", &error))?;
        if canonical.parent().is_none()
            || path_identity::equal(&canonical, &self.system_volume_path())
        {
            return Err(PlatformError::invalid_path("cleanup root is a volume root"));
        }
        let system_directory = directories::system_directory()?;
        let program_files_directories = directories::program_files_directories()?;
        if path_identity::is_same_or_child(&canonical, &system_directory)
            || program_files_directories
                .iter()
                .any(|root| path_identity::is_same_or_child(&canonical, root))
        {
            return Err(PlatformError::invalid_path(
                "cleanup root is system protected",
            ));
        }
        let user_directories = self.user_directories()?;
        for name in [
            "Desktop",
            "Documents",
            "Downloads",
            "Pictures",
            "Videos",
            "Music",
            "OneDrive",
            "Saved Games",
        ] {
            if path_identity::is_same_or_child(
                &canonical,
                &user_directories.home_directory().join(name),
            ) {
                return Err(PlatformError::invalid_path(
                    "cleanup root contains user content",
                ));
            }
        }
        Ok(())
    }

    fn validate_user_selected_cleanup_root(&self, path: &Path) -> PlatformResult<()> {
        let canonical = fs::canonicalize(path)
            .map_err(|error| PlatformError::io("canonicalize path", &error))?;
        if canonical.parent().is_none()
            || path_identity::equal(&canonical, &self.system_volume_path())
        {
            return Err(PlatformError::invalid_path("cleanup root is a volume root"));
        }
        let system_directory = directories::system_directory()?;
        let program_files_directories = directories::program_files_directories()?;
        if path_identity::is_same_or_child(&canonical, &system_directory)
            || program_files_directories
                .iter()
                .any(|root| path_identity::is_same_or_child(&canonical, root))
        {
            return Err(PlatformError::invalid_path(
                "cleanup root is system protected",
            ));
        }
        let per_user_programs = self
            .user_directories()?
            .home_directory()
            .join("AppData/Local/Programs");
        if path_identity::is_same_or_child(&canonical, &per_user_programs) {
            return Err(PlatformError::invalid_path(
                "cleanup root is an application installation directory",
            ));
        }
        Ok(())
    }

    fn fast_directory_tree_aggregate(
        &self,
        root: &Path,
        is_cancelled: &(dyn Fn() -> bool + Sync),
        report_progress: &(dyn Fn(&Path, u64, u64) + Sync),
    ) -> Result<Option<DirectoryTreeAggregate>, DirectoryTreeAggregateError> {
        directory_aggregate::measure(root, false, is_cancelled, report_progress, |_| false)
            .map(Some)
    }

    fn fast_project_artifact_tree_aggregate(
        &self,
        root: &Path,
        is_cancelled: &(dyn Fn() -> bool + Sync),
        report_progress: &(dyn Fn(&Path, u64, u64) + Sync),
        flag_entry_name: fn(&std::ffi::OsStr) -> bool,
    ) -> Result<Option<DirectoryTreeAggregate>, DirectoryTreeAggregateError> {
        directory_aggregate::measure(root, true, is_cancelled, report_progress, flag_entry_name)
            .map(Some)
    }

    fn fast_direct_physical_directories(
        &self,
        root: &Path,
        maximum_entries: usize,
        is_cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<Option<DirectPhysicalDirectoryEnumeration>, DirectoryTreeAggregateError> {
        directory_aggregate::direct_physical_directories(root, maximum_entries, is_cancelled)
            .map(Some)
    }

    fn capture_filesystem_change_token(
        &self,
        root: &Path,
    ) -> PlatformResult<Option<FilesystemChangeToken>> {
        change_tracking::capture_token(root).map_err(Into::into)
    }

    fn start_filesystem_change_monitor(
        &self,
        root: &Path,
        token: &FilesystemChangeToken,
        is_cancelled: &(dyn Fn() -> bool + Sync),
    ) -> PlatformResult<Option<FilesystemChangeMonitor>> {
        change_tracking::start_monitor(root, token, is_cancelled).map_err(Into::into)
    }

    fn filesystem_change_impact_plan(
        &self,
        root: &Path,
        token: &FilesystemChangeToken,
        is_cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<Option<FilesystemChangeImpactOutcome>, FilesystemChangeImpactError> {
        change_tracking::impact_plan(self, root, token, is_cancelled).map(Some)
    }
}

fn os_str_eq_ascii_case(value: &OsStr, expected: &str) -> bool {
    let mut value = value.encode_wide();
    let mut expected = expected.encode_utf16();
    loop {
        match (value.next(), expected.next()) {
            (Some(left), Some(right)) if ascii_lowercase(left) == ascii_lowercase(right) => {}
            (None, None) => return true,
            _ => return false,
        }
    }
}

fn ascii_lowercase(value: u16) -> u16 {
    if (u16::from(b'A')..=u16::from(b'Z')).contains(&value) {
        value + u16::from(b'a' - b'A')
    } else {
        value
    }
}

/// Returns whether a Windows path belongs to per-user application state.
///
/// Broad duplicate scans skip AppData because it contains app-managed caches, package state,
/// databases, and support files whose byte-identical members are not independent user copies.
/// The caller compares both the candidate and scan root so an explicit request targeting AppData
/// remains inspectable.
fn is_transient_duplicate_scope(path: &Path) -> bool {
    let mut components = path.components().filter_map(|component| match component {
        Component::Normal(value) => Some(value),
        _ => None,
    });
    let values = [
        components.next(),
        components.next(),
        components.next(),
        components.next(),
        components.next(),
        components.next(),
        components.next(),
    ];
    let is = |index: usize, expected: &str| {
        values[index].is_some_and(|value| os_str_eq_ascii_case(value, expected))
    };

    is(0, "temp") || (is(0, "users") && is(2, "appdata"))
}
