//! Native uninstall capability served by the elevated broker.
//!
//! Two entry points are kept strictly separate:
//!
//! * [`launch_privileged_uninstaller`] is the broker's contract. It runs inside
//!   the elevated process and only launches a finite set of typed capabilities.
//!   The elevated process never receives a caller-selected executable.
//! * [`execute_registration`] runs in the desktop process. It reopens the exact
//!   registration, re-derives the command from the registry, verifies the
//!   reviewed digest, and only then launches the vendor uninstaller. A changed
//!   registration is rejected instead of executed.
//!
//! No module here builds a shell command line from free-form text. Registered
//! batch scripts are the single case that needs `cmd.exe /c`; even there the
//! command line is the digest-verified registered command, never user input.

use std::ffi::OsStr;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::IntoRawHandle;
use std::path::{Path, PathBuf};
use std::process::{Child, Output};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_CANCELLED, ERROR_INVALID_HANDLE, HANDLE,
    },
    System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
    UI::{
        Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
        WindowsAndMessaging::SW_SHOWNORMAL,
    },
};
use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY},
    RegKey,
};

use crate::applications::contracts::{
    ApplicationInstallScope, ApplicationUninstallExecutionOutcome,
    ApplicationUninstallPlatformError, ApplicationUninstallRegistration,
    ApplicationUninstallRegistrationState, WindowsRegisteredUninstallKind, WindowsRegistryView,
};
use crate::platform::contracts::{PlatformError, PlatformErrorCode, PlatformResult};
use crate::platform::elevation::{LaunchRequest, RejectionReason, UninstallRequest};
use crate::platform::windows::child_process::hidden_command;
use crate::platform::windows::package_sources::{self, ParsedUninstallCommand};

/// Registry root that owns uninstall registrations.
const UNINSTALL_PATH: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
/// Upper bound for a registry key name accepted from the catalog.
const MAX_KEY_NAME_BYTES: usize = 512;
/// Exit codes that mean "the removal completed, a restart is required".
const REBOOT_REQUIRED_CODES: [i32; 2] = [3010, 1641];
/// `msiexec` returns 1602 when the user cancels the installation wizard.
const MSI_USER_CANCELLED: i32 = 1602;

/// Static AppX query script. The package name is passed through the
/// environment, never interpolated into the script text.
const APPX_STATE_SCRIPT: &str = r#"
$name = $env:SYSTOOLS_APPX_QUERY_NAME
$found = @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.PackageFullName -eq $name })
if ($found.Count -gt 0) { 'installed' } else { 'absent' }
"#;

/// Static AppX removal script. The package name is passed through the
/// environment, never interpolated into the script text.
const APPX_REMOVE_SCRIPT: &str = r#"
$name = $env:SYSTOOLS_APPX_REMOVE_NAME
Remove-AppxPackage -Package $name -ErrorAction Stop
$remaining = @(Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.PackageFullName -eq $name })
if ($remaining.Count -gt 0) { exit 1 } else { exit 0 }
"#;

/// Broker entry point. `Ok(Some(handle))` means a process was started and the
/// broker must duplicate the handle to the caller. The request is always a
/// typed capability: no path, command line, or executable crosses the boundary.
pub(crate) fn launch_privileged_uninstaller(
    request: UninstallRequest,
) -> PlatformResult<Option<HANDLE>> {
    match request {
        UninstallRequest::Msi { product_code } => {
            if !valid_product_code(&product_code) {
                return Err(PlatformError::new(
                    PlatformErrorCode::InvalidData,
                    "windows_uninstall_msi_product_code_invalid",
                ));
            }
            let child = spawn_msiexec(&product_code, true).map_err(to_platform_error)?;
            Ok(Some(child.into_raw_handle() as HANDLE))
        }
        UninstallRequest::Registered {
            key_name,
            registry32,
            digest,
        } => {
            let view = if registry32 {
                WindowsRegistryView::Registry32
            } else {
                WindowsRegistryView::Registry64
            };
            let handle = execute_registered(
                &key_name,
                ApplicationInstallScope::Machine,
                view,
                &digest,
            )
            .map_err(to_platform_error)?;
            Ok(Some(handle))
        }
        UninstallRequest::Chocolatey { .. } => Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "windows_chocolatey_uninstall_unsupported",
        )),
    }
}

/// Re-reads one exact registration and reports whether it is still installed.
pub(crate) fn registration_state(
    registration: &ApplicationUninstallRegistration,
) -> Result<ApplicationUninstallRegistrationState, ApplicationUninstallPlatformError> {
    match registration {
        ApplicationUninstallRegistration::WindowsMsi {
            product_code,
            scope,
            ..
        } => msi_state(product_code, *scope),
        ApplicationUninstallRegistration::WindowsAppx {
            package_full_name,
            ..
        } => appx_state(package_full_name),
        ApplicationUninstallRegistration::WindowsRegistered {
            key_name,
            scope,
            registry_view,
            command_digest,
            ..
        } => registered_state(key_name, *scope, *registry_view, command_digest),
        ApplicationUninstallRegistration::Winget { .. } => {
            Err(ApplicationUninstallPlatformError::Unsupported)
        }
    }
}

/// Executes one reviewed registration and waits for the vendor process.
///
/// Callers still verify [`registration_state`] afterwards: a vendor exit code
/// says how the process ended, not whether the exact installation is gone.
pub(crate) fn execute_registration(
    registration: &ApplicationUninstallRegistration,
) -> Result<ApplicationUninstallExecutionOutcome, ApplicationUninstallPlatformError> {
    match registration {
        ApplicationUninstallRegistration::WindowsMsi {
            product_code,
            scope,
            ..
        } => {
            if !valid_product_code(product_code) {
                return Err(ApplicationUninstallPlatformError::Unsupported);
            }
            let exit_code = match scope {
                ApplicationInstallScope::Machine => {
                    let handle = launch_through_broker(UninstallRequest::Msi {
                        product_code: product_code.clone(),
                    })?;
                    wait_for_handle(handle)?
                }
                ApplicationInstallScope::CurrentUser => {
                    let mut child = spawn_msiexec(product_code, true)?;
                    wait_for_child(&mut child)?
                }
            };
            outcome_from_exit(exit_code, registration)
        }
        ApplicationUninstallRegistration::WindowsAppx {
            package_full_name, ..
        } => {
            if !valid_package_full_name(package_full_name) {
                return Err(ApplicationUninstallPlatformError::Unsupported);
            }
            let mut child = spawn_appx_removal(package_full_name)?;
            let exit_code = wait_for_child(&mut child)?;
            outcome_from_exit(exit_code, registration)
        }
        ApplicationUninstallRegistration::WindowsRegistered {
            key_name,
            scope,
            registry_view,
            command_digest,
            ..
        } => {
            let exit_code = match scope {
                ApplicationInstallScope::Machine => {
                    let handle = launch_through_broker(UninstallRequest::Registered {
                        key_name: key_name.clone(),
                        registry32: *registry_view == WindowsRegistryView::Registry32,
                        digest: command_digest.clone(),
                    })?;
                    wait_for_handle(handle)?
                }
                ApplicationInstallScope::CurrentUser => {
                    let parsed = validated_command(
                        key_name,
                        *scope,
                        *registry_view,
                        command_digest,
                    )?;
                    launch_parsed(&parsed)?
                }
            };
            outcome_from_exit(exit_code, registration)
        }
        ApplicationUninstallRegistration::Winget { .. } => {
            Err(ApplicationUninstallPlatformError::Unsupported)
        }
    }
}

// ---------------------------------------------------------------------------
// Registry evidence
// ---------------------------------------------------------------------------

fn registry_root(scope: ApplicationInstallScope) -> RegKey {
    match scope {
        ApplicationInstallScope::CurrentUser => RegKey::predef(HKEY_CURRENT_USER),
        ApplicationInstallScope::Machine => RegKey::predef(HKEY_LOCAL_MACHINE),
    }
}

const fn registry_flags(view: WindowsRegistryView) -> u32 {
    match view {
        WindowsRegistryView::Registry32 => KEY_WOW64_32KEY,
        WindowsRegistryView::Registry64 => KEY_WOW64_64KEY,
    }
}

fn open_uninstall_key(
    key_name: &str,
    scope: ApplicationInstallScope,
    view: WindowsRegistryView,
) -> io::Result<RegKey> {
    validate_key_name(key_name)?;
    registry_root(scope).open_subkey_with_flags(
        format!(r"{UNINSTALL_PATH}\{key_name}"),
        KEY_READ | registry_flags(view),
    )
}

fn read_uninstall_string(key: &RegKey) -> io::Result<String> {
    key.get_value::<String, _>("UninstallString")
}

/// Reopens a registered command and proves it still matches the reviewed
/// digest. Any mismatch is reported as `RegistrationChanged`, never retried.
fn validated_command(
    key_name: &str,
    scope: ApplicationInstallScope,
    view: WindowsRegistryView,
    expected_digest: &str,
) -> Result<ParsedUninstallCommand, ApplicationUninstallPlatformError> {
    let key = open_uninstall_key(key_name, scope, view)
        .map_err(|error| registration_error(&error))?;
    let command = read_uninstall_string(&key).map_err(|error| registration_error(&error))?;
    let parsed = package_sources::parse_uninstall_command(&command, key_name, scope)
        .map_err(|_| ApplicationUninstallPlatformError::RegistrationChanged)?;
    if package_sources::command_digest(&parsed) != expected_digest {
        log::warn!("windows_uninstall_registration_changed reason=digest_mismatch");
        return Err(ApplicationUninstallPlatformError::RegistrationChanged);
    }
    Ok(parsed)
}

fn registered_state(
    key_name: &str,
    scope: ApplicationInstallScope,
    view: WindowsRegistryView,
    expected_digest: &str,
) -> Result<ApplicationUninstallRegistrationState, ApplicationUninstallPlatformError> {
    let key = match open_uninstall_key(key_name, scope, view) {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ApplicationUninstallRegistrationState::Absent);
        }
        Err(error) => return Err(registration_error(&error)),
    };
    let command = match read_uninstall_string(&key) {
        Ok(command) => command,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ApplicationUninstallRegistrationState::Incomplete);
        }
        Err(error) => return Err(registration_error(&error)),
    };
    let Ok(parsed) = package_sources::parse_uninstall_command(&command, key_name, scope) else {
        return Ok(ApplicationUninstallRegistrationState::Incomplete);
    };
    if package_sources::command_digest(&parsed) != expected_digest {
        return Ok(ApplicationUninstallRegistrationState::Incomplete);
    }
    Ok(ApplicationUninstallRegistrationState::Installed)
}

fn msi_state(
    product_code: &str,
    scope: ApplicationInstallScope,
) -> Result<ApplicationUninstallRegistrationState, ApplicationUninstallPlatformError> {
    if !valid_product_code(product_code) {
        return Err(ApplicationUninstallPlatformError::Unsupported);
    }
    let root = registry_root(scope);
    for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
        match root.open_subkey_with_flags(format!(r"{UNINSTALL_PATH}\{product_code}"), KEY_READ | view)
        {
            Ok(_) => return Ok(ApplicationUninstallRegistrationState::Installed),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(registration_error(&error)),
        }
    }
    Ok(ApplicationUninstallRegistrationState::Absent)
}

fn appx_state(
    package_full_name: &str,
) -> Result<ApplicationUninstallRegistrationState, ApplicationUninstallPlatformError> {
    if !valid_package_full_name(package_full_name) {
        return Err(ApplicationUninstallPlatformError::Unsupported);
    }
    let output = run_powershell(
        APPX_STATE_SCRIPT,
        "SYSTOOLS_APPX_QUERY_NAME",
        package_full_name,
    )?;
    if !output.status.success() {
        return Ok(ApplicationUninstallRegistrationState::Incomplete);
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "installed" => Ok(ApplicationUninstallRegistrationState::Installed),
        "absent" => Ok(ApplicationUninstallRegistrationState::Absent),
        _ => Ok(ApplicationUninstallRegistrationState::Incomplete),
    }
}

fn registration_error(error: &io::Error) -> ApplicationUninstallPlatformError {
    log::warn!(
        "windows_uninstall_registration_read_failed kind={:?} os_code={:?}",
        error.kind(),
        error.raw_os_error()
    );
    match error.kind() {
        io::ErrorKind::NotFound => ApplicationUninstallPlatformError::RegistrationChanged,
        io::ErrorKind::PermissionDenied => ApplicationUninstallPlatformError::RequiresElevation,
        _ => ApplicationUninstallPlatformError::NativeFailure(
            error.raw_os_error().unwrap_or_default().max(0) as u32,
        ),
    }
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

/// Launches one validated registered command and waits for its exit code.
fn launch_parsed(
    parsed: &ParsedUninstallCommand,
) -> Result<i32, ApplicationUninstallPlatformError> {
    match parsed.kind {
        WindowsRegisteredUninstallKind::Executable
        | WindowsRegisteredUninstallKind::Rundll32 => {
            let handle = shell_execute(&parsed.executable, &parsed.arguments, false)?;
            wait_for_handle(handle)
        }
        WindowsRegisteredUninstallKind::BatchScript => {
            // `cmd.exe /c` is allowed only here: the script and its arguments
            // come from the digest-verified registration, never from a caller.
            let mut child = spawn_batch(parsed)?;
            wait_for_child(&mut child)
        }
        WindowsRegisteredUninstallKind::UserPowerShellScript
        | WindowsRegisteredUninstallKind::WingetProduct => {
            Err(ApplicationUninstallPlatformError::Unsupported)
        }
    }
}

/// Launches the registered command inside the elevated broker and returns the
/// newly started process handle.
fn execute_registered(
    key_name: &str,
    scope: ApplicationInstallScope,
    view: WindowsRegistryView,
    digest: &str,
) -> Result<HANDLE, ApplicationUninstallPlatformError> {
    let parsed = validated_command(key_name, scope, view, digest)?;
    match parsed.kind {
        WindowsRegisteredUninstallKind::Executable
        | WindowsRegisteredUninstallKind::Rundll32 => {
            shell_execute(&parsed.executable, &parsed.arguments, false)
        }
        WindowsRegisteredUninstallKind::BatchScript => {
            let child = spawn_batch(&parsed)?;
            Ok(child.into_raw_handle() as HANDLE)
        }
        WindowsRegisteredUninstallKind::UserPowerShellScript
        | WindowsRegisteredUninstallKind::WingetProduct => {
            Err(ApplicationUninstallPlatformError::Unsupported)
        }
    }
}

fn spawn_msiexec(
    product_code: &str,
    silent: bool,
) -> Result<Child, ApplicationUninstallPlatformError> {
    hidden_command(system_executable("msiexec.exe"))
        .args(["/x", product_code, if silent { "/qn" } else { "/qb" }])
        .spawn()
        .map_err(spawn_error)
}

fn spawn_batch(parsed: &ParsedUninstallCommand) -> Result<Child, ApplicationUninstallPlatformError> {
    let line = if parsed.arguments.trim().is_empty() {
        format!("\"{}\"", parsed.executable.to_string_lossy())
    } else {
        format!(
            "\"{}\" {}",
            parsed.executable.to_string_lossy(),
            parsed.arguments
        )
    };
    hidden_command(system_executable("cmd.exe"))
        .args(["/d", "/s", "/c"])
        .arg(line)
        .spawn()
        .map_err(spawn_error)
}

fn spawn_appx_removal(
    package_full_name: &str,
) -> Result<Child, ApplicationUninstallPlatformError> {
    hidden_command(powershell_path())
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-Command",
            APPX_REMOVE_SCRIPT,
        ])
        .env("SYSTOOLS_APPX_REMOVE_NAME", package_full_name)
        .spawn()
        .map_err(spawn_error)
}

fn run_powershell(
    script: &str,
    variable: &str,
    value: &str,
) -> Result<Output, ApplicationUninstallPlatformError> {
    hidden_command(powershell_path())
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-Command",
            script,
        ])
        .env(variable, value)
        .output()
        .map_err(spawn_error)
}

/// `ShellExecuteExW` with the default verb. The registered command is passed
/// as two already-parsed fields, so no shell evaluates it.
fn shell_execute(
    executable: &Path,
    arguments: &str,
    run_as: bool,
) -> Result<HANDLE, ApplicationUninstallPlatformError> {
    let executable = wide(executable.as_os_str());
    let verb = run_as.then(|| wide(OsStr::new("runas")));
    let parameters = wide(OsStr::new(arguments));
    let mut execution = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: verb
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr()),
        lpFile: executable.as_ptr(),
        lpParameters: if arguments.is_empty() {
            std::ptr::null()
        } else {
            parameters.as_ptr()
        },
        nShow: SW_SHOWNORMAL,
        ..Default::default()
    };
    // SAFETY: every pointer refers to a NUL-terminated buffer that outlives the call.
    if unsafe { ShellExecuteExW(&mut execution) } == 0 {
        let code = unsafe { GetLastError() };
        return Err(native_error(code));
    }
    if execution.hProcess.is_null() {
        return Err(ApplicationUninstallPlatformError::LaunchUnconfirmed(
            ERROR_INVALID_HANDLE,
        ));
    }
    Ok(execution.hProcess)
}

fn wait_for_handle(handle: HANDLE) -> Result<i32, ApplicationUninstallPlatformError> {
    let waited = unsafe { WaitForSingleObject(handle, INFINITE) };
    if waited == u32::MAX {
        let code = unsafe { GetLastError() };
        unsafe { CloseHandle(handle) };
        return Err(ApplicationUninstallPlatformError::NativeFailure(code));
    }
    let mut exit_code = 0_u32;
    let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
    let error = unsafe { GetLastError() };
    // SAFETY: this handle was returned by ShellExecuteExW and is owned here.
    unsafe { CloseHandle(handle) };
    if queried == 0 {
        return Err(ApplicationUninstallPlatformError::NativeFailure(error));
    }
    Ok(exit_code as i32)
}

fn wait_for_child(child: &mut Child) -> Result<i32, ApplicationUninstallPlatformError> {
    let status = child
        .wait()
        .map_err(|error| ApplicationUninstallPlatformError::NativeFailure(
            error.raw_os_error().unwrap_or_default().max(0) as u32,
        ))?;
    match status.code() {
        Some(code) => Ok(code),
        None => Ok(-1),
    }
}

fn launch_through_broker(
    request: UninstallRequest,
) -> Result<HANDLE, ApplicationUninstallPlatformError> {
    crate::platform::elevation::launch(LaunchRequest::Uninstall(request))
        .map_err(|error| {
            log::warn!(
                "windows_uninstall_broker_rejected native_code={} may_have_started={} reason={:?}",
                error.code,
                error.may_have_started,
                error.reason
            );
            if error.reason == RejectionReason::ItemChanged {
                ApplicationUninstallPlatformError::RegistrationChanged
            } else if error.code == ERROR_CANCELLED {
                ApplicationUninstallPlatformError::UserCancelled
            } else if error.may_have_started {
                ApplicationUninstallPlatformError::LaunchUnconfirmed(error.code)
            } else {
                ApplicationUninstallPlatformError::NativeFailure(error.code)
            }
        })
}

/// Maps a native exit code to the stable execution outcome.
fn outcome_from_exit(
    code: i32,
    registration: &ApplicationUninstallRegistration,
) -> Result<ApplicationUninstallExecutionOutcome, ApplicationUninstallPlatformError> {
    if code == 0 {
        return Ok(ApplicationUninstallExecutionOutcome::Completed);
    }
    if REBOOT_REQUIRED_CODES.contains(&code) {
        return Ok(ApplicationUninstallExecutionOutcome::RestartRequired);
    }
    if code == ERROR_CANCELLED as i32 || code == MSI_USER_CANCELLED {
        return Err(ApplicationUninstallPlatformError::UserCancelled);
    }
    let removed = matches!(
        registration_state(registration),
        Ok(ApplicationUninstallRegistrationState::Absent)
    );
    let code = code.max(0) as u32;
    if removed {
        Err(ApplicationUninstallPlatformError::NativeFailureAfterRemoval(code))
    } else {
        Err(ApplicationUninstallPlatformError::NativeFailure(code))
    }
}

fn native_error(code: u32) -> ApplicationUninstallPlatformError {
    if code == ERROR_CANCELLED {
        ApplicationUninstallPlatformError::UserCancelled
    } else {
        ApplicationUninstallPlatformError::NativeFailure(code)
    }
}

fn spawn_error(error: io::Error) -> ApplicationUninstallPlatformError {
    log::warn!(
        "windows_uninstall_spawn_failed kind={:?} os_code={:?}",
        error.kind(),
        error.raw_os_error()
    );
    if error.raw_os_error() == Some(ERROR_CANCELLED as i32) {
        return ApplicationUninstallPlatformError::UserCancelled;
    }
    ApplicationUninstallPlatformError::NativeFailure(
        error.raw_os_error().unwrap_or_default().max(0) as u32,
    )
}

fn to_platform_error(error: ApplicationUninstallPlatformError) -> PlatformError {
    match error {
        ApplicationUninstallPlatformError::Unsupported => PlatformError::new(
            PlatformErrorCode::Unsupported,
            "windows_uninstall_unsupported",
        ),
        ApplicationUninstallPlatformError::RequiresElevation => PlatformError::new(
            PlatformErrorCode::AccessDenied,
            "windows_uninstall_requires_elevation",
        ),
        ApplicationUninstallPlatformError::UserCancelled => PlatformError::new(
            PlatformErrorCode::UserCancelled,
            "windows_uninstall_cancelled",
        ),
        ApplicationUninstallPlatformError::RegistrationChanged => PlatformError::new(
            PlatformErrorCode::ItemChanged,
            "windows_uninstall_registration_changed",
        ),
        ApplicationUninstallPlatformError::RemovalUnconfirmed => {
            PlatformError::operation_failed("windows_uninstall_removal_unconfirmed")
                .with_possible_side_effects()
        }
        ApplicationUninstallPlatformError::LaunchUnconfirmed(code)
        | ApplicationUninstallPlatformError::NativeFailure(code)
        | ApplicationUninstallPlatformError::NativeFailureAfterRemoval(code) => {
            PlatformError::operation_failed(format!(
                "windows_uninstall_native_failure code={code}"
            ))
            .with_possible_side_effects()
        }
    }
}

fn system_executable(name: &str) -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join(name)
}

fn powershell_path() -> PathBuf {
    system_executable(r"WindowsPowerShell\v1.0\powershell.exe")
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn validate_key_name(key_name: &str) -> io::Result<()> {
    let valid = !key_name.is_empty()
        && key_name.len() <= MAX_KEY_NAME_BYTES
        && !key_name
            .chars()
            .any(|character| matches!(character, '\\' | '\0' | '\r' | '\n'));
    if valid {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid registry key name",
        ))
    }
}

/// Accepts only a canonical MSI product code.
pub(crate) fn valid_product_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 38
        && bytes.first() == Some(&b'{')
        && bytes.last() == Some(&b'}')
        && [9, 14, 19, 24]
            .into_iter()
            .all(|index| bytes.get(index) == Some(&b'-'))
        && bytes[1..37].iter().enumerate().all(|(index, byte)| {
            matches!(index + 1, 9 | 14 | 19 | 24) || byte.is_ascii_hexdigit()
        })
}

/// Accepts only the characters Windows allows in a package identity. The
/// validated name is passed to PowerShell through the environment.
pub(crate) fn valid_package_full_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_codes_must_be_canonical_guids() {
        assert!(valid_product_code("{9627E855-337D-45EC-A2D9-CBB92B447399}"));
        for invalid in [
            "9627E855-337D-45EC-A2D9-CBB92B447399",
            "{9627E855337D45ECA2D9CBB92B447399}",
            "{9627E855-337D-45EC-A2D9-CBB92B44739Z}",
            "{9627E855-337D-45EC-A2D9-CBB92B447399} ",
            "{9627E855-337D-45EC-A2D9-CBB92B447399}; calc",
        ] {
            assert!(!valid_product_code(invalid), "{invalid}");
        }
    }

    #[test]
    fn package_names_reject_script_metacharacters() {
        assert!(valid_package_full_name("Example.1234_1.0.0.0_x64__abcd"));
        for invalid in [
            "",
            "Example; Remove-Item C:\\",
            "Example$(whoami)",
            "Example package",
            "Example`nWrite-Host",
            "Example'quote",
        ] {
            assert!(!valid_package_full_name(invalid), "{invalid}");
        }
    }

    #[test]
    fn exit_codes_map_to_stable_outcomes() {
        let registration = ApplicationUninstallRegistration::Winget {
            package_id: "Example".into(),
            source_name: "winget".into(),
            estimated_bytes: 0,
        };
        assert_eq!(
            outcome_from_exit(0, &registration),
            Ok(ApplicationUninstallExecutionOutcome::Completed)
        );
        for code in REBOOT_REQUIRED_CODES {
            assert_eq!(
                outcome_from_exit(code, &registration),
                Ok(ApplicationUninstallExecutionOutcome::RestartRequired)
            );
        }
        assert_eq!(
            outcome_from_exit(ERROR_CANCELLED as i32, &registration),
            Err(ApplicationUninstallPlatformError::UserCancelled)
        );
        assert_eq!(
            outcome_from_exit(MSI_USER_CANCELLED, &registration),
            Err(ApplicationUninstallPlatformError::UserCancelled)
        );
    }

    #[test]
    fn cancelled_uac_and_registry_key_validation_are_stable() {
        assert_eq!(
            native_error(ERROR_CANCELLED),
            ApplicationUninstallPlatformError::UserCancelled
        );
        assert_eq!(
            native_error(5),
            ApplicationUninstallPlatformError::NativeFailure(5)
        );
        assert!(validate_key_name("Example.Key").is_ok());
        assert!(validate_key_name(r"Example\Child").is_err());
        assert!(validate_key_name("").is_err());
        assert!(validate_key_name("Example\0Key").is_err());
    }

    #[test]
    fn digest_rejection_reports_registration_changed() {
        // A missing key is treated as a changed registration, never retried.
        let error = validated_command(
            "Systools.Test.Missing.Key",
            ApplicationInstallScope::CurrentUser,
            WindowsRegistryView::Registry64,
            &"a".repeat(64),
        )
        .unwrap_err();
        assert_eq!(
            error,
            ApplicationUninstallPlatformError::RegistrationChanged
        );
    }
}
