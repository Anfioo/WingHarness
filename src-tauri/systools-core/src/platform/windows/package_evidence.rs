//! Pure evidence rules that decide whether a registry record still describes an
//! installed application.
//!
//! These predicates never authorize an uninstall. They only choose the record
//! state shown in the catalog: an orphaned registration is a display-only
//! classification that keeps record removal available.

use std::path::{Path, PathBuf};

use crate::platform::contracts::ApplicationUninstallDiagnostic;

use super::package_locations::path_is_missing;

/// True when a record has a registration-shaped identity but none of its
/// filesystem evidence remains.
///
/// A missing uninstall command or executable is ordinary; any other diagnostic
/// means validation itself failed, so the record is not reported as orphaned.
pub(crate) fn registration_is_orphaned(
    has_registration: bool,
    diagnostic: Option<ApplicationUninstallDiagnostic>,
    bundle_path: Option<&Path>,
    executable_paths: &[PathBuf],
) -> bool {
    let Some(bundle_path) = bundle_path else {
        return false;
    };
    if has_registration {
        return false;
    }
    if diagnostic.is_some_and(|reason| {
        !matches!(
            reason,
            ApplicationUninstallDiagnostic::CommandMissing
                | ApplicationUninstallDiagnostic::ExecutableMissing
        )
    }) {
        return false;
    }
    // A record with no executable evidence at all cannot prove absence: the
    // installer may simply not publish a path.
    if executable_paths.is_empty() {
        return false;
    }
    path_is_missing(bundle_path) && executable_paths.iter().all(|path| path_is_missing(path))
}

/// Returns true when at least one executable path still exists.
pub(crate) fn any_executable_present(paths: &[PathBuf]) -> bool {
    paths.iter().any(|path| !path_is_missing(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "systools-evidence-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ))
    }

    #[test]
    fn records_without_filesystem_evidence_are_not_orphaned() {
        let root = temp_root("missing-without-evidence");
        let bundle = root.join("Example");
        assert!(!registration_is_orphaned(false, None, Some(&bundle), &[]));
        assert!(!registration_is_orphaned(false, None, None, &[]));
    }

    #[test]
    fn a_missing_bundle_and_every_missing_executable_is_orphaned() {
        let root = temp_root("orphan");
        let bundle = root.join("Example");
        let executable = bundle.join("example.exe");
        assert!(registration_is_orphaned(
            false,
            Some(ApplicationUninstallDiagnostic::CommandMissing),
            Some(&bundle),
            std::slice::from_ref(&executable),
        ));
    }

    #[test]
    fn a_present_registration_or_validation_failure_is_not_orphaned() {
        let root = temp_root("installed");
        let bundle = root.join("Example");
        let executable = bundle.join("example.exe");
        assert!(!registration_is_orphaned(
            true,
            None,
            Some(&bundle),
            std::slice::from_ref(&executable),
        ));
        assert!(!registration_is_orphaned(
            false,
            Some(ApplicationUninstallDiagnostic::ExecutableAccessDenied),
            Some(&bundle),
            std::slice::from_ref(&executable),
        ));
    }

    #[test]
    fn an_existing_bundle_keeps_the_record_installed() {
        let root = temp_root("existing");
        std::fs::create_dir_all(&root).expect("the evidence fixture should be created");
        let executable = root.join("example.exe");
        std::fs::write(&executable, b"fixture").expect("the fixture should be written");

        assert!(!registration_is_orphaned(false, None, Some(&root), &[executable.clone()]));
        assert!(any_executable_present(&[executable]));

        std::fs::remove_dir_all(root).expect("the evidence fixture should be removed");
    }
}
