//! The task manager page's thin command surface.
//!
//! Every command is registered in four places: `invoke.rs`, `build.rs`,
//! `capabilities/default.json` and the generated permission files. Commands
//! only move small values around: sampling happens on its own thread, and
//! process actions run locally first, with the service consulted only when the
//! host's own rights fall short.

use argus_core::actions::{self, ActionError, Priority, TreeKillReport};
use argus_core::collector::Snapshot;
use argus_core::details::{self, ProcessDetails};
use argus_core::models::ArgusSettings;
use argus_core::{ArgusError, ArgusErrorCode};
use argus_service::{Operation, Reply, Routed, ServiceStatus};
use tauri::State;
use tauri::ipc::Channel;

use crate::argus::{ArgusState, service, store};

#[tauri::command]
pub fn argus_snapshot_start(
    state: State<'_, ArgusState>,
    channel: Channel<Snapshot>,
    interval_ms: u64,
) -> Result<(), ArgusError> {
    let settings = ArgusSettings::with_interval_ms(interval_ms);
    *state.settings() = settings.clone();

    let mut sampler = state.sampler();
    if sampler.is_none() {
        *sampler = Some(crate::argus::sampler::Sampler::spawn());
    }
    let subscribe = |running: &crate::argus::sampler::Sampler| {
        running.send(crate::argus::sampler::Control::Subscribe(
            channel.clone(),
            settings.interval_ms,
        ))
    };
    // The previous page may have gone away without a stop, in which case the
    // thread exited by itself; its handle is dead, so replace it instead of
    // leaving this page subscribed to nothing.
    if !sampler.as_ref().is_some_and(subscribe) {
        *sampler = Some(crate::argus::sampler::Sampler::spawn());
        if let Some(running) = sampler.as_ref() {
            subscribe(running);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn argus_snapshot_stop(state: State<'_, ArgusState>) -> Result<(), ArgusError> {
    state.stop_sampler();
    Ok(())
}

#[tauri::command]
pub fn argus_set_interval(
    state: State<'_, ArgusState>,
    interval_ms: u64,
) -> Result<ArgusSettings, ArgusError> {
    let settings = store::set(ArgusSettings::with_interval_ms(interval_ms))?;
    *state.settings() = settings.clone();
    state.send(crate::argus::sampler::Control::SetInterval(
        settings.interval_ms,
    ));
    Ok(settings)
}

#[tauri::command]
pub fn argus_refresh(state: State<'_, ArgusState>) -> Result<(), ArgusError> {
    state.refresh();
    Ok(())
}

#[tauri::command]
pub fn argus_settings_get(state: State<'_, ArgusState>) -> Result<ArgusSettings, ArgusError> {
    let settings = store::get()?;
    *state.settings() = settings.clone();
    Ok(settings)
}

#[tauri::command]
pub fn argus_settings_set(
    state: State<'_, ArgusState>,
    settings: ArgusSettings,
) -> Result<ArgusSettings, ArgusError> {
    let settings = store::set(settings)?;
    *state.settings() = settings.clone();
    state.send(crate::argus::sampler::Control::SetInterval(
        settings.interval_ms,
    ));
    Ok(settings)
}

#[tauri::command(async)]
pub fn argus_process_details(pid: u32) -> Result<ProcessDetails, ArgusError> {
    if !details::exists(pid) {
        return Err(ArgusError::new(
            ArgusErrorCode::NotFound,
            "The process has already exited.",
        ));
    }
    // The page only knows the PID; resolve the image path here so the version
    // resource can be read on demand.
    let path = details::image_path_of(pid);
    Ok(details::query(pid, path.as_deref()))
}

#[tauri::command(async)]
pub fn argus_kill_process(
    state: State<'_, ArgusState>,
    pid: u32,
    create_time: i64,
    force: bool,
) -> Result<(), ArgusError> {
    if pid == std::process::id() {
        return Err(ArgusError::invalid_input(
            "The task manager cannot end its own process.",
        ));
    }
    let result = route_operation(
        &state,
        || actions::terminate(pid, create_time, force),
        Operation::Terminate {
            pid,
            create_time,
            force,
        },
        |reply| match reply {
            Reply::Done => Ok(()),
            Reply::Error(error) => Err(map_action_error(error)),
            other => Err(unexpected_reply(other)),
        },
    );
    state.refresh();
    result
}

#[tauri::command(async)]
pub fn argus_kill_process_tree(
    state: State<'_, ArgusState>,
    pid: u32,
    create_time: i64,
) -> Result<TreeKillReport, ArgusError> {
    if pid == std::process::id() {
        return Err(ArgusError::invalid_input(
            "The task manager cannot end its own process.",
        ));
    }
    let result =
        actions::terminate_tree_with(
            pid,
            create_time,
            |pid, create_time| match actions::terminate(pid, create_time, false) {
                Ok(()) => Ok(()),
                Err(ActionError::AccessDenied) if !state.elevated => {
                    match argus_service::route(Operation::Terminate {
                        pid,
                        create_time,
                        force: false,
                    }) {
                        Routed::Replied(Reply::Done) => Ok(()),
                        Routed::Replied(Reply::Error(error)) => Err(error),
                        Routed::Replied(other) => Err(ActionError::Os(format!(
                            "unexpected reply from the privileged service: {other:?}"
                        ))),
                        Routed::Outdated => Err(ActionError::ServiceOutdated),
                        Routed::Absent | Routed::Denied => Err(ActionError::AccessDenied),
                    }
                }
                Err(error) => Err(error),
            },
        )
        .map_err(|error| match error {
            ActionError::ServiceOutdated => service_outdated(),
            other => map_action_error(other),
        });
    state.refresh();
    result
}

#[tauri::command(async)]
pub fn argus_set_priority(
    state: State<'_, ArgusState>,
    pid: u32,
    create_time: i64,
    priority: Priority,
) -> Result<Priority, ArgusError> {
    let result = route_operation(
        &state,
        || actions::set_priority(pid, create_time, priority),
        Operation::Priority {
            pid,
            create_time,
            priority,
        },
        |reply| match reply {
            Reply::Priority(actual) => Ok(actual),
            Reply::Error(error) => Err(map_action_error(error)),
            other => Err(unexpected_reply(other)),
        },
    );
    state.refresh();
    result
}

#[tauri::command(async)]
pub fn argus_set_efficiency(
    state: State<'_, ArgusState>,
    pid: u32,
    create_time: i64,
    on: bool,
) -> Result<(), ArgusError> {
    let result = route_operation(
        &state,
        || actions::set_efficiency_mode(pid, create_time, on),
        Operation::Efficiency {
            pid,
            create_time,
            on,
        },
        |reply| match reply {
            Reply::Done => Ok(()),
            Reply::Error(error) => Err(map_action_error(error)),
            other => Err(unexpected_reply(other)),
        },
    );
    state.refresh();
    result
}

// The status probe may have to wait for the service pipe (a few seconds when
// it is running but unresponsive), so it must not block the main thread.
#[tauri::command(async)]
pub fn argus_service_status() -> Result<ServiceStatus, ArgusError> {
    service::status()
}

#[tauri::command(async)]
pub fn argus_service_manage(
    state: State<'_, ArgusState>,
    action: String,
) -> Result<ServiceStatus, ArgusError> {
    let status = service::manage(&action)?;
    state.refresh();
    Ok(status)
}

/// Runs an operation with the host's own rights first. When the host is denied
/// and is not elevated, the same operation is handed to the privileged service;
/// the service's answer is authoritative and the host never retries locally.
fn route_operation<T>(
    state: &ArgusState,
    local: impl FnOnce() -> Result<T, ActionError>,
    operation: Operation,
    on_reply: impl FnOnce(Reply) -> Result<T, ArgusError>,
) -> Result<T, ArgusError> {
    match local() {
        Ok(value) => Ok(value),
        Err(ActionError::AccessDenied) if !state.elevated => {
            match argus_service::route(operation) {
                Routed::Replied(reply) => on_reply(reply),
                Routed::Outdated => Err(service_outdated()),
                Routed::Absent => Err(service_absent()),
                Routed::Denied => Err(ArgusError::new(
                    ArgusErrorCode::AccessDenied,
                    "The privileged service refused to change this process.",
                )),
            }
        }
        Err(error) => Err(map_action_error(error)),
    }
}

fn service_outdated() -> ArgusError {
    ArgusError::new(
        ArgusErrorCode::ServiceUnavailable,
        "The privileged service speaks an incompatible protocol; updating it is required.",
    )
}

fn service_absent() -> ArgusError {
    ArgusError::new(
        ArgusErrorCode::AccessDenied,
        "Access denied. Install or start the privileged service to change protected processes.",
    )
}

fn unexpected_reply(reply: Reply) -> ArgusError {
    ArgusError::internal(format!(
        "Unexpected reply from the privileged service: {reply:?}"
    ))
}

/// The page's stable error surface: the UI branches on `code`, and `message`
/// is an English fallback for anything it does not know.
fn map_action_error(error: ActionError) -> ArgusError {
    match error {
        ActionError::AccessDenied => ArgusError::new(
            ArgusErrorCode::AccessDenied,
            "Access denied. Administrator rights are required for this process.",
        ),
        ActionError::Critical => ArgusError::new(
            ArgusErrorCode::AccessDenied,
            "This is a critical process; terminating it would crash the system.",
        ),
        ActionError::Refused => ArgusError::new(
            ArgusErrorCode::AccessDenied,
            "The operation was refused for this process.",
        ),
        ActionError::ServiceOutdated => ArgusError::new(
            ArgusErrorCode::AccessDenied,
            "The privileged service is out of date; updating it is required.",
        ),
        ActionError::NotFound => ArgusError::new(
            ArgusErrorCode::NotFound,
            "The process has already exited or its PID was reused.",
        ),
        ActionError::Os(message) => ArgusError {
            code: ArgusErrorCode::Internal,
            message: "The process operation failed.".into(),
            detail: Some(message),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argus_errors_serialize_with_kebab_case_codes() {
        let error = ArgusError::new(ArgusErrorCode::NotFound, "gone");
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({ "code": "not-found", "message": "gone" })
        );
        let internal = map_action_error(ActionError::Os("boom".into()));
        assert_eq!(
            serde_json::to_value(&internal).unwrap(),
            serde_json::json!({
                "code": "internal",
                "message": "The process operation failed.",
                "detail": "boom",
            })
        );
    }

    #[test]
    fn action_errors_map_to_the_documented_codes() {
        let code = |error: ActionError| match map_action_error(error).code {
            ArgusErrorCode::NotFound => "not-found",
            ArgusErrorCode::InvalidInput => "invalid-input",
            ArgusErrorCode::AccessDenied => "access-denied",
            ArgusErrorCode::ServiceUnavailable => "service-unavailable",
            ArgusErrorCode::NotImplemented => "not-implemented",
            ArgusErrorCode::Internal => "internal",
        };
        assert_eq!(code(ActionError::AccessDenied), "access-denied");
        assert_eq!(code(ActionError::Critical), "access-denied");
        assert_eq!(code(ActionError::Refused), "access-denied");
        assert_eq!(code(ActionError::ServiceOutdated), "access-denied");
        assert_eq!(code(ActionError::NotFound), "not-found");
        assert_eq!(code(ActionError::Os("x".into())), "internal");
    }
}
