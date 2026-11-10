// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

//! One-shot elevation: `ShellExecuteExW` with the `runas` verb starts
//! `%SystemRoot%\System32\taskkill.exe /PID <pid> /F` behind one UAC prompt.
//!
//! This module is only compiled against the Windows APIs. Other platforms
//! answer with an `internal` error.

use crate::error::{PortsError, PortsResult};
use crate::process::ensure_killable;

/// How long the elevated `taskkill` may run before it is reported as stuck.
const ELEVATION_TIMEOUT_MS: u32 = 15_000;

/// Builds the `taskkill` arguments for one PID. The string never comes from
/// the caller, so no switch or path can be injected.
pub(crate) fn taskkill_arguments(pid: u32) -> String {
    format!("/PID {pid} /F")
}

/// Maps the exit code of the elevated `taskkill` to a command result.
pub(crate) fn map_exit_code(exit_code: u32) -> PortsResult<()> {
    match exit_code {
        0 => Ok(()),
        128 => Err(PortsError::not_found("The process no longer exists.")),
        other => Err(
            PortsError::elevation_failed(format!("taskkill exited with code {other}."))
                .with_detail(serde_json::json!({ "exitCode": other })),
        ),
    }
}

pub fn kill_elevated(pid: u32) -> PortsResult<()> {
    ensure_killable(pid)?;
    log::debug!("Requesting elevation to terminate process {pid}");

    #[cfg(target_os = "windows")]
    {
        run_taskkill(pid)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(PortsError::internal(
            "Elevation is only implemented on Windows.",
        ))
    }
}

#[cfg(target_os = "windows")]
fn taskkill_path() -> std::path::PathBuf {
    std::env::var_os("SystemRoot")
        .filter(|root| !root.is_empty())
        .map(|root| {
            std::path::PathBuf::from(root)
                .join("System32")
                .join("taskkill.exe")
        })
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows\System32\taskkill.exe"))
}

#[cfg(target_os = "windows")]
fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
struct OwnedHandle(windows::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(target_os = "windows")]
fn run_taskkill(pid: u32) -> PortsResult<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        GetLastError, ERROR_CANCELLED, ERROR_INVALID_DATA, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let executable = wide(taskkill_path().as_os_str());
    let verb = wide(std::ffi::OsStr::new("runas"));
    let arguments = wide(std::ffi::OsStr::new(&taskkill_arguments(pid)));

    let mut execution = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR::from_raw(verb.as_ptr()),
        lpFile: PCWSTR::from_raw(executable.as_ptr()),
        lpParameters: PCWSTR::from_raw(arguments.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };

    if unsafe { ShellExecuteExW(&mut execution) }.is_err() {
        let native = unsafe { GetLastError() };
        if native == ERROR_CANCELLED {
            return Err(PortsError::elevation_cancelled());
        }
        return Err(PortsError::elevation_failed(format!(
            "Could not start the elevated taskkill: error {}.",
            native.0
        ))
        .with_detail(serde_json::json!({ "nativeCode": native.0 })));
    }
    if execution.hProcess.0.is_null() {
        return Err(
            PortsError::elevation_failed("The elevated taskkill handle is missing.")
                .with_detail(serde_json::json!({ "nativeCode": ERROR_INVALID_DATA.0 })),
        );
    }

    // Closed on every path, including the early returns below.
    let handle = OwnedHandle(execution.hProcess);

    let wait = unsafe { WaitForSingleObject(handle.0, ELEVATION_TIMEOUT_MS) };
    if wait == WAIT_TIMEOUT {
        return Err(PortsError::elevation_failed(
            "The elevated taskkill did not finish in time.",
        ));
    }
    if wait != WAIT_OBJECT_0 {
        let native = unsafe { GetLastError() };
        return Err(
            PortsError::elevation_failed("Waiting for the elevated taskkill failed.")
                .with_detail(serde_json::json!({ "nativeCode": native.0 })),
        );
    }

    let mut exit_code = 0u32;
    if unsafe { GetExitCodeProcess(handle.0, &mut exit_code) }.is_err() {
        let native = unsafe { GetLastError() };
        return Err(
            PortsError::elevation_failed("Could not read the elevated taskkill exit code.")
                .with_detail(serde_json::json!({ "nativeCode": native.0 })),
        );
    }
    map_exit_code(exit_code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::PortsErrorCode;

    #[test]
    fn builds_taskkill_arguments_from_the_pid_only() {
        assert_eq!(taskkill_arguments(1), "/PID 1 /F");
        assert_eq!(taskkill_arguments(4321), "/PID 4321 /F");
        assert_eq!(taskkill_arguments(u32::MAX), "/PID 4294967295 /F");
    }

    #[test]
    fn taskkill_arguments_are_not_quoted_and_carry_no_extra_switches() {
        let arguments = taskkill_arguments(4321);
        assert!(!arguments.contains('"'));
        assert_eq!(
            arguments.split_whitespace().collect::<Vec<_>>(),
            ["/PID", "4321", "/F"]
        );
    }

    #[test]
    fn maps_taskkill_exit_codes() {
        assert!(map_exit_code(0).is_ok());

        assert_eq!(
            map_exit_code(128).expect_err("128 is not found").code,
            PortsErrorCode::NotFound
        );

        let failed = map_exit_code(1).expect_err("1 is ElevationFailed");
        assert_eq!(failed.code, PortsErrorCode::ElevationFailed);
        assert_eq!(failed.detail, Some(serde_json::json!({ "exitCode": 1 })));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn taskkill_path_points_into_system32() {
        let path = taskkill_path();
        assert_eq!(path.file_name(), Some(std::ffi::OsStr::new("taskkill.exe")));
        assert_eq!(
            path.parent().and_then(|parent| parent.file_name()),
            Some(std::ffi::OsStr::new("System32"))
        );
    }
}
