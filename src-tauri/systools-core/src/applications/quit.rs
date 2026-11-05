//! Graceful quit requests for one running application.
//!
//! A quit request is weaker than verified termination: it posts a close request
//! to the application window and reports whether one was delivered. Callers that
//! need a proof must re-read the process snapshot.

use std::path::PathBuf;

use serde::Serialize;

use crate::applications::catalog::ProcessSnapshot;
use crate::applications::contracts::{
    ApplicationProcessCloseMode, ApplicationProcessTarget, Cancellation,
};
use crate::applications::{process_control, running_identity};

/// Outcome of one quit request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationQuitStatus {
    Requested,
    Unavailable,
    Unsupported,
}

/// Requests a graceful close for the application identified by a stable
/// executable identity.
pub fn request(application_id: &str) -> Result<ApplicationQuitStatus, String> {
    if !valid_identity(application_id) {
        return Err("invalid application identity".to_string());
    }
    let snapshot = process_control::snapshot(&Cancellation::new())?;
    match resolve_target(application_id, &snapshot) {
        QuitTarget::Available(path) => request_path(&path),
        QuitTarget::Unavailable => Ok(ApplicationQuitStatus::Unavailable),
        QuitTarget::Unsupported(_) => Ok(ApplicationQuitStatus::Unsupported),
    }
}

/// Resolution result for one quit request, kept separate so it can be tested
/// without starting PowerShell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum QuitTarget {
    Available(PathBuf),
    Unavailable,
    Unsupported(Option<PathBuf>),
}

pub(crate) fn resolve_target(application_id: &str, snapshot: &ProcessSnapshot) -> QuitTarget {
    let Some(path) = snapshot.executable_path_for_id(application_id) else {
        return QuitTarget::Unavailable;
    };
    if !running_identity::can_quit(&path) {
        log::info!(
            "application_quit_target_rejected stage=validate_identity outcome=unsupported path={}",
            path.display()
        );
        return QuitTarget::Unsupported(Some(path));
    }
    QuitTarget::Available(path)
}

fn request_path(path: &std::path::Path) -> Result<ApplicationQuitStatus, String> {
    // A graceful close targets exactly the resolved image. Name-only matching is
    // deliberately not used: another installation may share the file name.
    let target = ApplicationProcessTarget {
        executable_names: Vec::new(),
        executable_paths: vec![path.to_path_buf()],
    };
    let result =
        process_control::close_application_processes(&target, ApplicationProcessCloseMode::Graceful)?;
    if result.matched_process_count == 0 {
        return Ok(ApplicationQuitStatus::Unavailable);
    }
    log::info!(
        "application_quit_requested path={} matched_process_count={} requested_process_count={} remaining_process_count={}",
        path.display(),
        result.matched_process_count,
        result.requested_process_count,
        result.remaining_processes.len()
    );
    Ok(ApplicationQuitStatus::Requested)
}

fn valid_identity(application_id: &str) -> bool {
    application_id.len() == 64 && application_id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::contracts::RunningProcessIdentity;

    fn snapshot_of(entries: &[(&str, Option<&str>)]) -> ProcessSnapshot {
        ProcessSnapshot::from_process_identities(
            entries
                .iter()
                .map(|(name, path)| RunningProcessIdentity {
                    executable_name: name.to_string(),
                    executable_path: path.map(PathBuf::from),
                })
                .collect(),
        )
    }

    #[test]
    fn identity_validation_requires_a_full_digest() {
        assert!(valid_identity(&"a".repeat(64)));
        assert!(!valid_identity("application-0123456789abcdef01234567"));
        assert!(!valid_identity(&"g".repeat(64)));
    }

    #[test]
    fn resolvable_executables_are_available_and_system_images_are_unsupported() {
        let path = PathBuf::from(r"C:\Program Files\Example\example.exe");
        let id = running_identity::executable_id(&path);
        let snapshot = snapshot_of(&[("Example.exe", Some(path.to_string_lossy().as_ref()))]);
        assert_eq!(
            resolve_target(&id, &snapshot),
            QuitTarget::Available(path)
        );
        let system = PathBuf::from(r"C:\Windows\System32\cmd.exe");
        let snapshot = snapshot_of(&[("cmd.exe", Some(system.to_string_lossy().as_ref()))]);
        assert_eq!(
            resolve_target(&running_identity::executable_id(&system), &snapshot),
            QuitTarget::Unsupported(Some(system))
        );
    }

    #[test]
    fn unknown_identities_are_unavailable() {
        let snapshot = snapshot_of(&[("Example.exe", Some(r"C:\Apps\Example\example.exe"))]);
        assert_eq!(
            resolve_target(&"0".repeat(64), &snapshot),
            QuitTarget::Unavailable
        );
    }
}
