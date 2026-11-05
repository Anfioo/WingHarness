//! Restarting the current application through the Windows elevation policy.
//!
//! Restarting is a separate, user-initiated recovery step after an uninstall
//! batch asked for a reboot. It relaunches the same executable through the
//! standard consent prompt and never accepts a caller-selected command line.

use std::{ffi::OsStr, os::windows::ffi::OsStrExt};

use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_CANCELLED},
    UI::{
        Shell::{ShellExecuteExW, ShellExecuteW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
        WindowsAndMessaging::SW_SHOWNORMAL,
    },
};

use crate::platform::contracts::{PlatformError, PlatformErrorCode, PlatformResult};

const APPS_FEATURES_URI: &str = "ms-settings:appsfeatures";
/// `ShellExecuteW`/`ShellExecuteExW` report values above 32 on success.
const SHELL_EXECUTE_MIN_SUCCESS: isize = 32;

/// Relaunches this executable through the Windows consent prompt.
///
/// A cancelled consent prompt is reported as `UserCancelled` and is never
/// retried, because a second prompt would be both surprising and unsafe.
// Wired to the restart command by the UI lane.
#[allow(dead_code)]
pub(crate) fn restart_current_application_elevated() -> PlatformResult<()> {
    let executable = std::env::current_exe()
        .map_err(|error| PlatformError::io("resolve the current executable", &error))?;
    let executable = wide(executable.as_os_str());
    let verb = wide(OsStr::new("runas"));
    let mut execution = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: verb.as_ptr(),
        lpFile: executable.as_ptr(),
        nShow: SW_SHOWNORMAL,
        ..Default::default()
    };
    // SAFETY: the struct is fully initialized, every string is NUL-terminated,
    // and the buffers outlive the call.
    if unsafe { ShellExecuteExW(&mut execution) } == 0 {
        return Err(launch_error(unsafe { GetLastError() }));
    }
    if execution.hProcess.is_null() {
        return Err(PlatformError::operation_failed(
            "Windows did not return a handle for the restarted application",
        ));
    }
    // The restarted instance owns its own lifetime. Closing this handle only
    // releases the reference; it does not terminate the elevated process.
    unsafe { windows_sys::Win32::Foundation::CloseHandle(execution.hProcess) };
    log::info!("systools_application_restart_elevated_dispatched");
    Ok(())
}

/// Opens the Windows settings page that lists installed applications.
pub(crate) fn open_windows_apps_settings() -> PlatformResult<()> {
    let operation = wide(OsStr::new("open"));
    let target = wide(OsStr::new(APPS_FEATURES_URI));
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if (result as isize) <= SHELL_EXECUTE_MIN_SUCCESS {
        return Err(PlatformError::operation_failed(
            "Windows Settings could not be opened",
        ));
    }
    Ok(())
}

fn launch_error(code: u32) -> PlatformError {
    if code == ERROR_CANCELLED {
        return PlatformError::new(
            PlatformErrorCode::UserCancelled,
            "Windows elevated restart consent was dismissed",
        );
    }
    let error = std::io::Error::from_raw_os_error(code as i32);
    PlatformError::new(
        PlatformErrorCode::OperationFailed,
        format!("Windows elevated restart failed: {error}"),
    )
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dismissed_consent_is_reported_as_cancelled() {
        let error = launch_error(ERROR_CANCELLED);
        assert_eq!(error.code(), PlatformErrorCode::UserCancelled);
        assert!(error.diagnostic().contains("dismissed"));
    }

    #[test]
    fn other_launch_failures_are_operation_failures() {
        let error = launch_error(2);
        assert_eq!(error.code(), PlatformErrorCode::OperationFailed);
        assert!(error.diagnostic().contains("restart failed"));
    }

    #[test]
    fn settings_uri_is_fixed() {
        assert_eq!(APPS_FEATURES_URI, "ms-settings:appsfeatures");
    }

    #[test]
    fn wide_strings_are_nul_terminated() {
        let units = wide(OsStr::new("runas"));
        assert_eq!(units.last(), Some(&0));
        assert_eq!(units.len(), 6);
    }
}
