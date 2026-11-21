//! Service status and the install/uninstall/update entry point.
//!
//! The privileged service is optional: every read-only command works without
//! it, and process actions first run with the host's own rights. This module
//! keeps the service's error strings out of the command surface by mapping them
//! onto the page's stable `ArgusError` codes.

use argus_core::{ArgusError, ArgusErrorCode};
use argus_service::ServiceStatus;

pub fn status() -> Result<ServiceStatus, ArgusError> {
    argus_service::status().map_err(|error| {
        eprintln!("argus service status query failed: {error}");
        ArgusError::new(
            ArgusErrorCode::ServiceUnavailable,
            "The privileged service could not be queried.",
        )
    })
}

/// Closes an established IPv4 TCP connection. Stub baseline: the local-first
/// attempt and the privileged-service fallback land with the connection port.
pub fn close_connection(
    local_address: String,
    local_port: u16,
    remote_address: String,
    remote_port: u16,
) -> Result<(), ArgusError> {
    let _ = (local_address, local_port, remote_address, remote_port);
    Err(ArgusError::new(
        ArgusErrorCode::AccessDenied,
        "Closing connections is not available yet.",
    ))
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
