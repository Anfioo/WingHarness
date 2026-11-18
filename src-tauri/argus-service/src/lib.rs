// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! The opt-in privileged Windows service and its local IPC.
//!
//! A0 freezes the surface the host talks to: the installation status, the
//! install/uninstall/update entry point and the two clients that feed
//! per-process network and disk metrics. B2 replaces the bodies with the
//! trimmed upstream service.

use serde::Serialize;

/// The service name. The development build uses a separate name so both
/// versions can be installed side by side.
pub const SERVICE_NAME: &str = if cfg!(debug_assertions) {
    "WingHarnessPrivilegedDev"
} else {
    "WingHarnessPrivileged"
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub state: &'static str,
    pub authorized: bool,
    pub version: Option<String>,
    pub error: Option<String>,
    /// The running service speaks another protocol (`error` says so too):
    /// updating it is what reconnects, unlike a failure that may pass.
    pub incompatible: bool,
}

impl ServiceStatus {
    /// The status of a machine that never installed the service.
    pub fn not_installed() -> Self {
        Self {
            state: "notInstalled",
            authorized: false,
            version: None,
            error: None,
            incompatible: false,
        }
    }
}

/// Query the installed service. A0 reports "not installed" until B2 ports the
/// Service Control Manager queries.
pub fn status() -> Result<ServiceStatus, String> {
    Ok(ServiceStatus::not_installed())
}

/// Install, uninstall or update the service through one UAC prompt. A0 only
/// validates the action; B2 implements the elevation helper.
pub fn manage(action: &str) -> Result<ServiceStatus, String> {
    match action {
        "install" | "uninstall" | "update" => Err("not implemented yet".into()),
        other => Err(format!("unknown service action: {other}")),
    }
}

/// Feeds per-process network rates from the service into a snapshot. B2 ports
/// the pipe client and the background reader.
#[derive(Debug, Default)]
pub struct NetworkClient;

impl NetworkClient {
    pub fn spawn() -> Self {
        Self
    }
}

/// Feeds per-process disk rates from the service into a snapshot. B2 ports the
/// pipe client and the local elevated fallback.
#[derive(Debug, Default)]
pub struct DiskClient;

impl DiskClient {
    pub fn spawn() -> Self {
        Self
    }
}
