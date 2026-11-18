// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! The opt-in privileged Windows service and its local IPC.
//!
//! The service runs as LocalSystem, serves a named pipe to the account that
//! installed it, and exposes a fixed operation set: process termination,
//! priority and efficiency mode, per-process network counters and per-process
//! disk counters. It creates no window and starts no webview.

mod background;
mod diagnostics;
mod disk;
mod install;
mod network;
mod pipe;
mod protocol;
mod security;
mod server;
mod util;

use argus_core::actions::ActionError;

pub use background::NetworkClient;
pub use disk::DiskClient;
pub use install::{ServiceStatus, manage, status};
pub use network::NetworkFrame;
pub use protocol::{Operation, Reply};

/// The service name. The development build uses a separate name so both
/// versions can be installed side by side.
pub const SERVICE_NAME: &str = if cfg!(debug_assertions) {
    "WingHarnessPrivilegedDev"
} else {
    "WingHarnessPrivileged"
};

/// The local pipe the service listens on. The development build is separate
/// for the same reason as the service name.
pub const PIPE_NAME: &str = if cfg!(debug_assertions) {
    r"\\.\pipe\WingHarness.Privileged.Dev.v1"
} else {
    r"\\.\pipe\WingHarness.Privileged.v1"
};

/// Starts the service dispatcher; the SCM adds this argument.
const SERVICE_ARG: &str = "--wingharness-service";
/// Runs the elevated install helper with an action and an owner SID.
const INSTALL_ARG: &str = "--wingharness-service-manage";
/// Re-runs the install helper to remove the service during uninstall.
const REMOVE_ARG: &str = "--wingharness-service-remove";
/// Runs by the installer after it replaced the executable: updates an
/// installed service in the same elevation.
const REFRESH_ARG: &str = "--wingharness-service-refresh";
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The operation-set version. It starts above 1 on purpose: a Ping is always
/// sent in the version-one envelope so the host can discover an older service,
/// so 1 cannot also identify this operation set.
const PROTOCOL: u32 = 2;

/// Handles service and helper modes before the host starts Tauri, its single
/// instance guard or its sampler. None means a normal launch.
pub fn run_mode() -> Option<i32> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some(SERVICE_ARG) if args.len() == 1 => {
            argus_core::diagnostics::capture_helper_failures();
            Some(server::dispatch().map_or_else(|e| e as i32, |_| 0))
        }
        Some(INSTALL_ARG) if args.len() == 3 => {
            Some(diagnostics::helper("privileged service helper", || {
                install::run_helper(&args[1], &args[2])
            }))
        }
        Some(REMOVE_ARG) if args.len() == 1 => Some(remove_for_uninstall()),
        Some(REFRESH_ARG) if args.len() == 1 => Some(diagnostics::helper(
            "installer service refresh",
            install::refresh,
        )),
        Some(SERVICE_ARG | INSTALL_ARG | REMOVE_ARG | REFRESH_ARG) => Some(87),
        _ => None,
    }
}

/// Removes the service through the same elevated helper as the page. 0 when
/// nothing is left installed; the uninstaller asks the user what to do
/// otherwise.
fn remove_for_uninstall() -> i32 {
    match status() {
        Ok(s) if s.state == "notInstalled" => 0,
        _ => match manage("uninstall") {
            Ok(s) if s.state == "notInstalled" => 0,
            _ => 1,
        },
    }
}

/// How the privileged service took an operation of the host.
pub enum Routed {
    /// The service answered; the reply is authoritative.
    Replied(Reply),
    /// The running service speaks another protocol version.
    Outdated,
    /// The service is not installed or not running; do not retry locally.
    Absent,
    /// The service refused the operation (protected target or policy), or the
    /// request failed while it was running.
    Denied,
}

/// Routes an operation to the running service. Blocking; call it off the UI
/// thread. Without a service this does not fall back to a local operation: the
/// host has already tried its own rights first.
pub fn route(operation: Operation) -> Routed {
    let pid = match util::stage(
        "privileged operation service lookup",
        install::running_pid(),
    )
    .map_err(util::message)
    {
        Ok(Some(pid)) => pid,
        _ => return Routed::Absent,
    };
    match pipe::request(PIPE_NAME, pid, operation) {
        Ok(reply) => match &reply {
            Reply::Error(
                ActionError::AccessDenied | ActionError::Refused | ActionError::Critical,
            ) => Routed::Denied,
            _ => Routed::Replied(reply),
        },
        // The service did not run the request and speaks another protocol.
        Err(util::INCOMPATIBLE) => Routed::Outdated,
        Err(_) => Routed::Denied,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_names_are_versioned_apart() {
        assert!(SERVICE_NAME.starts_with("WingHarnessPrivileged"));
        assert_eq!(SERVICE_NAME.ends_with("Dev"), cfg!(debug_assertions));
        assert_eq!(PIPE_NAME.ends_with("Dev.v1"), cfg!(debug_assertions));
        assert!(PIPE_NAME.starts_with(r"\\.\pipe\WingHarness.Privileged"));
    }
}
