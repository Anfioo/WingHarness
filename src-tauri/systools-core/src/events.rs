use serde::Serialize;
use tauri::Emitter;

pub const ANALYSIS_PROGRESS: &str = "systools:analysis-progress";
pub const LARGE_FILES_PROGRESS: &str = "systools:large-files-progress";
pub const DUPLICATE_PROGRESS: &str = "systools:duplicate-progress";
pub const DUPLICATE_GROUPS: &str = "systools:duplicate-groups";
pub const UNINSTALL_PROGRESS: &str = "systools:uninstall-progress";
pub const UNINSTALL_EXECUTION_PROGRESS: &str = "systools:uninstall-execution-progress";
pub const LEFTOVERS_PROGRESS: &str = "systools:leftovers-progress";

/// Emits one typed desktop event and keeps delivery failures in the native log.
///
/// A closed window must not turn a completed domain operation into a failure.
pub fn emit<S>(app: &tauri::AppHandle, event: &'static str, payload: S)
where
    S: Serialize + Clone,
{
    if let Err(error) = app.emit(event, payload) {
        log::warn!("systools_event_emit_failed event={event} error={error}");
    }
}
