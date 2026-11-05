//! Verified termination of one freshly resolved application.
//!
//! Force quit reuses the process-close primitive with the forced mode and then
//! reports the processes that survived. It never accepts a raw process ID: the
//! executable path is resolved from the current process snapshot.

use std::time::Instant;

use serde::Serialize;

use crate::applications::contracts::{
    ApplicationProcessCloseMode, ApplicationProcessCloseResult, ApplicationProcessTarget,
    Cancellation,
};
use crate::applications::{process_control, running_identity};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApplicationForceQuitStatus {
    Completed,
    StillRunning,
    Unavailable,
    Blocked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationForceQuitResult {
    pub schema_version: u32,
    pub operation_id: String,
    pub status: ApplicationForceQuitStatus,
    pub matched_process_count: u64,
    pub requested_process_count: u64,
    /// Unique native names, not a PID count or proof that every child belongs
    /// to this application.
    pub remaining_processes: Vec<String>,
}

pub fn execute(application_id: &str) -> Result<ApplicationForceQuitResult, String> {
    if !valid_identity(application_id) {
        return Err("invalid application identity".to_string());
    }
    let operation_id = uuid::Uuid::new_v4().to_string();
    let started = Instant::now();
    let snapshot = process_control::snapshot(&Cancellation::new()).inspect_err(|error| {
        log::warn!(
            "application_force_quit_failed operation_id={operation_id} stage=resolve_processes error={error}"
        );
    })?;
    let mut result = ApplicationForceQuitResult {
        schema_version: 1,
        operation_id,
        status: ApplicationForceQuitStatus::Unavailable,
        matched_process_count: 0,
        requested_process_count: 0,
        remaining_processes: Vec::new(),
    };
    let Some(path) = snapshot.executable_path_for_id(application_id) else {
        return Ok(result);
    };
    if running_identity::is_current_application(&path) {
        log::info!(
            "application_force_quit_blocked operation_id={} path={} reason=current_application",
            result.operation_id,
            path.display()
        );
        result.status = ApplicationForceQuitStatus::Blocked;
        return Ok(result);
    }
    if !running_identity::can_force_quit(&path) {
        log::info!(
            "application_force_quit_blocked operation_id={} path={} reason=protected_target",
            result.operation_id,
            path.display()
        );
        result.status = ApplicationForceQuitStatus::Blocked;
        return Ok(result);
    }
    let target = ApplicationProcessTarget {
        executable_names: Vec::new(),
        executable_paths: vec![path.clone()],
    };
    let native = process_control::close_application_processes(
        &target,
        ApplicationProcessCloseMode::Force,
    )
    .inspect_err(|error| {
        log::warn!(
            "application_force_quit_failed operation_id={} path={} stage=platform_close error={}",
            result.operation_id,
            path.display(),
            error
        );
    })?;
    result.status = status_for(&native);
    result.matched_process_count = native.matched_process_count;
    result.requested_process_count = native.requested_process_count;
    result.remaining_processes = native.remaining_processes;
    log::info!(
        "application_force_quit_finished operation_id={} status={:?} path={} matched_process_count={} requested_process_count={} remaining_processes={} elapsed_ms={}",
        result.operation_id,
        result.status,
        path.display(),
        result.matched_process_count,
        result.requested_process_count,
        result.remaining_processes.join(","),
        started.elapsed().as_millis()
    );
    Ok(result)
}

fn status_for(result: &ApplicationProcessCloseResult) -> ApplicationForceQuitStatus {
    if !result.remaining_processes.is_empty() {
        ApplicationForceQuitStatus::StillRunning
    } else if result.matched_process_count == 0 {
        ApplicationForceQuitStatus::Unavailable
    } else {
        ApplicationForceQuitStatus::Completed
    }
}

fn valid_identity(application_id: &str) -> bool {
    application_id.len() == 64 && application_id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(matched: u64, remaining: &[&str]) -> ApplicationProcessCloseResult {
        ApplicationProcessCloseResult {
            matched_process_count: matched,
            requested_process_count: matched,
            remaining_processes: remaining.iter().map(|name| name.to_string()).collect(),
        }
    }

    #[test]
    fn status_reports_surviving_processes_before_success() {
        assert_eq!(
            status_for(&result(2, &["example.exe"])),
            ApplicationForceQuitStatus::StillRunning
        );
        assert_eq!(
            status_for(&result(2, &[])),
            ApplicationForceQuitStatus::Completed
        );
        assert_eq!(
            status_for(&result(0, &[])),
            ApplicationForceQuitStatus::Unavailable
        );
    }

    #[test]
    fn identity_validation_requires_a_full_digest() {
        assert!(valid_identity(&"b".repeat(64)));
        assert!(!valid_identity("application-0123456789abcdef01234567"));
        assert!(!valid_identity(&"z".repeat(64)));
    }
}
