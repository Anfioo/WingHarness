//! Filesystem state and trust helpers shared by the Windows startup sources.
//!
//! The reference adapter used WinTrust to classify every target. This crate's
//! `windows` feature set does not include `Win32_Security_WinTrust`, so trust is
//! limited to what the environment can prove: a target that exists under a
//! system-owned directory is reported as `System`; everything else stays
//! `Unknown` rather than guessing a signature state.

use std::path::{Path, PathBuf};

use crate::startup::platform::PlatformStartupTrustState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FilesystemTargetState {
    Present,
    Missing,
    Unknown,
}

pub(super) use crate::platform::windows::file_version::file_version_metadata;

/// Classifies a startup target without claiming a signature state.
///
/// Only an existing file under a system-owned directory can be reported as
/// `System`. A missing file, a relative path, or a user-writable location stays
/// `Unknown`, which keeps the UI from presenting unverified evidence as trust.
pub(super) fn startup_trust(
    path: Option<&Path>,
    system_candidate: bool,
) -> PlatformStartupTrustState {
    let Some(path) = path.filter(|path| path.is_file()) else {
        return PlatformStartupTrustState::Unknown;
    };
    if system_candidate || is_under_system_directory(path) {
        PlatformStartupTrustState::System
    } else {
        PlatformStartupTrustState::Unknown
    }
}

fn is_under_system_directory(path: &Path) -> bool {
    let candidate = comparison_key(path);
    if candidate.is_empty() {
        return false;
    }
    ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|variable| std::env::var_os(variable))
        .map(PathBuf::from)
        .map(|root| comparison_key(&root))
        .any(|root| {
            !root.is_empty()
                && candidate.len() > root.len()
                && candidate.starts_with(&root)
                && candidate.as_bytes()[root.len()] == b'\\'
        })
}

fn comparison_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

/// Distinguishes a missing local target from an unavailable filesystem boundary.
///
/// Remote paths are intentionally never classified as missing because a disconnected share is
/// indistinguishable from a deleted target without performing network I/O. Local drive roots must
/// also be available before absence can become evidence for destructive orphan cleanup.
pub(super) fn filesystem_target_state(path: &Path) -> FilesystemTargetState {
    if !path.is_absolute() || path.to_string_lossy().starts_with(r"\\") {
        return FilesystemTargetState::Unknown;
    }
    let Some(root) = path
        .ancestors()
        .last()
        .filter(|root| !root.as_os_str().is_empty())
    else {
        return FilesystemTargetState::Unknown;
    };
    if !matches!(root.try_exists(), Ok(true)) {
        return FilesystemTargetState::Unknown;
    }
    match path.try_exists() {
        Ok(true) => FilesystemTargetState::Present,
        Ok(false) => FilesystemTargetState::Missing,
        Err(_) => FilesystemTargetState::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_has_no_version_metadata() {
        assert!(file_version_metadata(Path::new(r"C:\missing\fixture.exe")).is_none());
    }

    #[test]
    fn remote_target_is_never_claimed_as_missing() {
        assert_eq!(
            filesystem_target_state(Path::new(r"\\unavailable\share\agent.exe")),
            FilesystemTargetState::Unknown
        );
    }

    #[test]
    fn relative_target_is_never_claimed_as_missing() {
        assert_eq!(
            filesystem_target_state(Path::new(r"relative\agent.exe")),
            FilesystemTargetState::Unknown
        );
    }

    #[test]
    fn missing_target_cannot_be_trusted() {
        assert_eq!(
            startup_trust(Some(Path::new(r"C:\missing\fixture.exe")), true),
            PlatformStartupTrustState::Unknown
        );
        assert_eq!(
            startup_trust(None, true),
            PlatformStartupTrustState::Unknown
        );
    }
}
