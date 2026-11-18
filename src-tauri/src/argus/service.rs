//! Service status and the install/uninstall/update entry point.
//!
//! The privileged service is optional: A0 reports "not installed", so the page
//! and every read-only command work without it. B2/B3 replace these forwards.

use argus_core::ArgusError;
use argus_service::ServiceStatus;

pub fn status() -> Result<ServiceStatus, ArgusError> {
    argus_service::status().map_err(ArgusError::internal)
}

pub fn manage(action: &str) -> Result<ServiceStatus, ArgusError> {
    match action {
        "install" | "uninstall" | "update" => Err(ArgusError::not_implemented()),
        other => Err(ArgusError::invalid_input(format!(
            "Unknown service action: {other}"
        ))),
    }
}
