// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

//! Terminating the process that holds a listening port.
//!
//! The frontend only ever sends a PID. Every command string used by the
//! elevated path is built in this crate, never accepted from a caller.

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::error::{PortsError, PortsResult};
use crate::scan;

/// PIDs below this value are treated as system processes.
const SYSTEM_PID_LIMIT: u32 = 1000;

#[cfg(target_os = "windows")]
const EXIT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
#[cfg(target_os = "windows")]
const EXIT_POLL_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

/// Rejects a PID the page must not terminate, in a fixed order:
/// zero, this process, system PIDs, PIDs without a listening port, then
/// PIDs that no longer exist.
pub(crate) fn ensure_killable(pid: u32) -> PortsResult<()> {
    if pid == 0 {
        return Err(PortsError::invalid_input(
            "pid",
            "The process id is invalid.",
        ));
    }
    if pid == std::process::id() {
        return Err(PortsError::invalid_input(
            "pid",
            "The ports page will not terminate its own process.",
        ));
    }
    if pid < SYSTEM_PID_LIMIT {
        return Err(PortsError::invalid_input(
            "pid",
            "System processes are not terminated from this page.",
        ));
    }
    if !owns_listening_port(pid)? {
        return Err(PortsError::invalid_input(
            "pid",
            "The process does not own a listening port.",
        ));
    }
    if !is_running(Pid::from_u32(pid))? {
        return Err(PortsError::not_found("The process does not exist."));
    }
    Ok(())
}

fn owns_listening_port(pid: u32) -> PortsResult<bool> {
    Ok(scan::list_listening_ports()?
        .iter()
        .any(|entry| entry.process.as_ref().map(|process| process.pid) == Some(pid)))
}

fn new_system() -> PortsResult<System> {
    System::new()
        .map_err(|error| PortsError::internal(format!("Could not read the process table: {error}")))
}

/// A fresh snapshot per call: refreshing a single PID never drops the ones
/// that have exited, so a reused `System` would report a dead process as alive.
fn is_running(pid: Pid) -> PortsResult<bool> {
    let mut system = new_system()?;
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    Ok(system.process(pid).is_some())
}

/// Terminates `pid` with the current process privileges.
pub fn kill(pid: u32) -> PortsResult<()> {
    ensure_killable(pid)?;
    log::debug!("Terminating process {pid}");
    terminate(pid)
}

#[cfg(target_os = "windows")]
fn terminate(pid: u32) -> PortsResult<()> {
    let pid = Pid::from_u32(pid);
    let mut system = new_system()?;
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    let Some(process) = system.process(pid) else {
        return Err(PortsError::not_found("The process does not exist."));
    };
    if !process.kill() {
        return Err(PortsError::access_denied(
            "Terminating the process was denied by the system.",
        ));
    }
    if wait_for_exit(pid)? {
        Ok(())
    } else {
        Err(PortsError::access_denied(
            "Terminating the process was denied by the system.",
        ))
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate(_pid: u32) -> PortsResult<()> {
    Err(PortsError::internal(
        "Terminating processes is only implemented on Windows.",
    ))
}

#[cfg(target_os = "windows")]
fn wait_for_exit(pid: Pid) -> PortsResult<bool> {
    let deadline = std::time::Instant::now() + EXIT_POLL_TIMEOUT;
    loop {
        if !is_running(pid)? {
            return Ok(true);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(EXIT_POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::PortsErrorCode;

    fn code_for(pid: u32) -> PortsErrorCode {
        ensure_killable(pid).expect_err("the guard must reject this pid").code
    }

    #[test]
    fn rejects_pid_zero() {
        assert_eq!(code_for(0), PortsErrorCode::InvalidInput);
    }

    #[test]
    fn rejects_own_process() {
        assert_eq!(code_for(std::process::id()), PortsErrorCode::InvalidInput);
    }

    #[test]
    fn rejects_system_pids() {
        // PID 4 is the Windows System process; any PID below 1000 is refused.
        for pid in [1, 4, 999] {
            if pid == std::process::id() {
                continue;
            }
            let error = ensure_killable(pid).expect_err("the guard must reject this pid");
            assert_eq!(error.code, PortsErrorCode::InvalidInput);
            assert_eq!(error.detail.as_ref().unwrap()["field"], "pid");
            assert!(
                error.message.contains("System processes"),
                "pid {pid} must fail the system check, not a later one: {}",
                error.message
            );
        }
    }

    #[test]
    fn the_system_boundary_is_one_thousand() {
        // The test process itself is never below the limit, so the constant is
        // what pins the boundary; PID 999 is checked above.
        assert_eq!(SYSTEM_PID_LIMIT, 1_000);
    }

    #[test]
    fn rejects_pid_without_listening_port() {
        // A PID nothing listens on is caught by the listening-port guard.
        // Assert the code only: with a real listener table the existence
        // guard would never be reached for a made-up PID.
        assert_eq!(code_for(u32::MAX), PortsErrorCode::InvalidInput);
    }

    #[test]
    #[cfg(target_os = "windows")]
    #[ignore = "spawns and terminates a real child process"]
    fn terminates_a_child_process() {
        let mut child = std::process::Command::new("ping")
            .args(["-n", "30", "127.0.0.1"])
            .spawn()
            .expect("failed to spawn the child process");
        let pid = Pid::from_u32(child.id());
        assert!(
            is_running(pid).expect("the process table should be readable"),
            "the child should be running"
        );

        // Exercises the termination loop without the listening-port guard,
        // which only a real server process would satisfy.
        terminate(child.id()).expect("the child process should terminate");
        assert!(
            !is_running(pid).expect("the process table should be readable"),
            "the child should be gone"
        );

        let _ = child.wait();
    }
}
