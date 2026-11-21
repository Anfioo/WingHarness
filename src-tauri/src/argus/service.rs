//! Service status and the install/uninstall/update entry point.
//!
//! The privileged service is optional: every read-only command works without
//! it, and process actions first run with the host's own rights. This module
//! keeps the service's error strings out of the command surface by mapping them
//! onto the page's stable `ArgusError` codes.

use argus_core::actions::ActionError;
use argus_core::{ArgusError, ArgusErrorCode};
use argus_service::{Operation, Reply, Routed, ServiceStatus};

pub fn status() -> Result<ServiceStatus, ArgusError> {
    argus_service::status().map_err(|error| {
        eprintln!("argus service status query failed: {error}");
        ArgusError::new(
            ArgusErrorCode::ServiceUnavailable,
            "The privileged service could not be queried.",
        )
    })
}

/// Closes an established IPv4 TCP connection using host rights first.
pub fn close_connection(
    local_address: String,
    local_port: u16,
    remote_address: String,
    remote_port: u16,
) -> Result<(), ArgusError> {
    match argus_core::connections::close_tcp(
        &local_address,
        local_port,
        &remote_address,
        remote_port,
    ) {
        Ok(()) => Ok(()),
        Err(ActionError::AccessDenied) => match argus_service::route(Operation::CloseConnection {
            local_address,
            local_port,
            remote_address,
            remote_port,
        }) {
            Routed::Replied(Reply::Done) => Ok(()),
            Routed::Replied(Reply::Error(error)) => Err(map_service_error(error)),
            Routed::Replied(reply) => Err(ArgusError::internal(format!(
                "Unexpected reply from the privileged service: {reply:?}"
            ))),
            Routed::Outdated => Err(ArgusError::new(
                ArgusErrorCode::ServiceUnavailable,
                "The privileged service speaks an incompatible protocol; updating it is required.",
            )),
            Routed::Absent => Err(ArgusError::new(
                ArgusErrorCode::AccessDenied,
                "Access denied. Install or start the privileged service to close connections.",
            )),
            Routed::Denied => Err(ArgusError::new(
                ArgusErrorCode::AccessDenied,
                "The privileged service refused to close this connection.",
            )),
        },
        Err(error) => Err(map_service_error(error)),
    }
}

fn map_service_error(error: ActionError) -> ArgusError {
    match error {
        ActionError::AccessDenied | ActionError::Refused => ArgusError::new(
            ArgusErrorCode::AccessDenied,
            "The connection close operation was refused.",
        ),
        ActionError::Os(detail) => ArgusError {
            code: ArgusErrorCode::Internal,
            message: "The connection close operation failed.".into(),
            detail: Some(detail),
        },
        ActionError::NotFound => {
            ArgusError::new(ArgusErrorCode::NotFound, "The connection no longer exists.")
        }
        ActionError::Critical | ActionError::ServiceOutdated => ArgusError::new(
            ArgusErrorCode::AccessDenied,
            "The connection close operation was refused.",
        ),
    }
}

pub fn manage(action: &str) -> Result<ServiceStatus, ArgusError> {
    match action {
        "install" | "uninstall" | "update" => argus_service::manage(action).map_err(|error| {
            eprintln!("argus service action failed: action={action}; error={error}");
            ArgusError {
                code: ArgusErrorCode::AccessDenied,
                message: "The privileged service could not be changed.".into(),
                detail: Some(error),
            }
        }),
        other => Err(ArgusError::invalid_input(format!(
            "Unknown service action: {other}"
        ))),
    }
}
