//! Windows installed-application inventory.
//!
//! The inventory merges four uninstall-registry views with one optional AppX
//! snapshot and one best-effort `winget list` hint. Registry and AppX data are
//! authoritative; `winget list` can only add an identity to an application that
//! is already known, and its failure never fails a scan.
//!
//! All PowerShell is executed from the trusted inbox path with a static script
//! and a bounded wait. No user-controlled text is interpolated into a script.

use std::path::PathBuf;
use std::process::{Child, Output, Stdio};
use std::time::{Duration, Instant};

use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
};
use winreg::RegKey;

use crate::applications::contracts::{
    ApplicationInstallScope, ApplicationUninstallRegistration, Cancellation, InstalledApplication,
    SystemInventory, WindowsRegistryView,
};
use crate::applications::models::ApplicationScanStage;
use crate::applications::progress::ApplicationScanProgressReporter;
use crate::platform::contracts::{
    ApplicationUninstallDiagnostic, PlatformError, PlatformErrorCode, PlatformFailureReason,
    PlatformResult,
};

use super::child_process::hidden_command;
use super::directories;
use super::package_locations;
use super::package_reconciliation::{self, RegistryRecord};
use super::package_sources::{self, PackagedApplicationInventory, WingetProduct};

const UNINSTALL_PATH: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
const APPX_REPOSITORY_PATH: &str = r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";
const POWERSHELL_TIMEOUT: Duration = Duration::from_secs(30);
const WINGET_TIMEOUT: Duration = Duration::from_secs(15);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_SCRIPT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_ATTEMPTS: usize = 2;

/// Captures the merged installed-application inventory.
///
/// The revision is sampled before and after the capture. When a registration
/// or AppX package changes during the walk, the capture runs once more so the
/// returned catalog never describes a half-updated registry.
pub(crate) fn capture_inventory(
    cancellation: &Cancellation,
    progress: &ApplicationScanProgressReporter<'_>,
) -> PlatformResult<SystemInventory> {
    let started = Instant::now();
    let mut revision_before = inventory_revision().ok();
    for attempt in 1..=MAX_ATTEMPTS {
        let captured = capture_once(cancellation, progress)?;
        if cancellation.is_cancelled() {
            return Err(cancelled_error("windows_application_inventory_cancelled"));
        }
        let revision_after = inventory_revision().ok();
        let stable = revision_before
            .as_deref()
            .zip(revision_after.as_deref())
            .is_some_and(|(before, after)| before == after);
        if stable || attempt == MAX_ATTEMPTS {
            let complete = captured.registry_complete && captured.appx_complete && stable;
            log::info!(
                "windows_application_inventory_ready application_count={} registry_complete={} appx_complete={} winget_hint_count={} catalog_stable={} elapsed_ms={}",
                captured.applications.len(),
                captured.registry_complete,
                captured.appx_complete,
                captured.winget_hint_count,
                stable,
                started.elapsed().as_millis(),
            );
            return Ok(SystemInventory {
                applications: captured.applications,
                complete,
                revision: revision_after.unwrap_or_default(),
            });
        }
        revision_before = revision_after;
    }
    Err(PlatformError::operation_failed(
        "windows_application_inventory_unavailable",
    ))
}

/// Computes the opaque revision of every authoritative inventory source.
pub(crate) fn inventory_revision() -> PlatformResult<String> {
    let cancellation = Cancellation::new();
    let mut parts = Vec::new();
    for (root, view) in [
        (RegKey::predef(HKEY_CURRENT_USER), KEY_WOW64_64KEY),
        (RegKey::predef(HKEY_CURRENT_USER), KEY_WOW64_32KEY),
        (RegKey::predef(HKEY_LOCAL_MACHINE), KEY_WOW64_64KEY),
        (RegKey::predef(HKEY_LOCAL_MACHINE), KEY_WOW64_32KEY),
    ] {
        match root.open_subkey_with_flags(UNINSTALL_PATH, KEY_READ | view) {
            Ok(uninstall) => parts.push(format!(
                "{view}:{}",
                uninstall_view_revision(&uninstall, &cancellation)?
            )),
            Err(_) => parts.push(format!("{view}:missing")),
        }
    }
    parts.push(format!("appx:{}", appx_repository_revision()));
    Ok(blake3::hash(parts.join("|").as_bytes())
        .to_hex()
        .to_string())
}

/// Runs a static PowerShell script with the inventory timeout.
pub(crate) fn run_powershell(script: &str) -> PlatformResult<Output> {
    run_powershell_with_timeout(script, POWERSHELL_TIMEOUT, None)
}

/// Runs a static PowerShell script and parses its trimmed standard output as
/// JSON.
pub(crate) fn run_powershell_json(script: &str) -> PlatformResult<serde_json::Value> {
    let output = run_powershell(script)?;
    if !output.status.success() {
        return Err(PlatformError::operation_failed(format!(
            "windows_powershell_exit_code={:?}",
            output.status.code()
        )));
    }
    let text = String::from_utf8(output.stdout).map_err(|error| {
        PlatformError::new(
            PlatformErrorCode::InvalidData,
            format!("windows_powershell_output_invalid error={error}"),
        )
    })?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(PlatformError::operation_failed(
            "windows_powershell_output_empty",
        ));
    }
    serde_json::from_str(trimmed).map_err(|error| {
        PlatformError::new(
            PlatformErrorCode::InvalidData,
            format!("windows_powershell_output_parse_failed error={error}"),
        )
    })
}

/// Runs a static PowerShell script with an explicit timeout and optional
/// cooperative cancellation. Used by the process lane, which must not wait the
/// full inventory timeout for a short snapshot.
pub(crate) fn run_powershell_with_timeout(
    script: &str,
    timeout: Duration,
    cancellation: Option<&Cancellation>,
) -> PlatformResult<Output> {
    if script.len() > MAX_SCRIPT_BYTES {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "windows_powershell_script_too_large",
        ));
    }
    let powershell = powershell_path()?;
    run_command_with_timeout(
        &powershell,
        &["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", script],
        timeout,
        cancellation,
    )
}

fn capture_once(
    cancellation: &Cancellation,
    progress: &ApplicationScanProgressReporter<'_>,
) -> PlatformResult<CapturedInventory> {
    let mut records = Vec::new();
    let mut opened_views = 0_usize;
    let mut complete_views = 0_usize;
    progress.report(ApplicationScanStage::DiscoveringApplications, 4);
    for (root, view, scope) in [
        (
            RegKey::predef(HKEY_CURRENT_USER),
            KEY_WOW64_64KEY,
            ApplicationInstallScope::CurrentUser,
        ),
        (
            RegKey::predef(HKEY_CURRENT_USER),
            KEY_WOW64_32KEY,
            ApplicationInstallScope::CurrentUser,
        ),
        (
            RegKey::predef(HKEY_LOCAL_MACHINE),
            KEY_WOW64_64KEY,
            ApplicationInstallScope::Machine,
        ),
        (
            RegKey::predef(HKEY_LOCAL_MACHINE),
            KEY_WOW64_32KEY,
            ApplicationInstallScope::Machine,
        ),
    ] {
        if cancellation.is_cancelled() {
            return Err(cancelled_error("windows_application_inventory_cancelled"));
        }
        let (opened, complete) = read_uninstall_view(&root, view, scope, &mut records);
        opened_views += usize::from(opened);
        complete_views += usize::from(complete);
    }
    if opened_views == 0 {
        return Err(PlatformError::operation_failed(
            "windows_application_registry_unavailable",
        ));
    }

    let mut applications = package_reconciliation::merge_registry_records(records);
    progress.report(ApplicationScanStage::DiscoveringApplications, 12);

    let mut appx_complete = false;
    match read_packaged_applications() {
        Ok(packages) => {
            package_reconciliation::merge_packaged_applications(&mut applications, packages);
            appx_complete = true;
        }
        Err(error) => {
            log::warn!(
                "windows_packaged_application_inventory_failed code={:?} diagnostic={}",
                error.code(),
                error.diagnostic()
            );
        }
    }
    progress.report(ApplicationScanStage::DiscoveringApplications, 68);

    let winget_hints = winget_products(cancellation);
    let winget_hint_count = winget_hints.len();
    package_reconciliation::merge_winget_products(&mut applications, winget_hints);
    progress.report(ApplicationScanStage::DiscoveringApplications, 74);

    applications.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.catalog_identifier.cmp(&right.catalog_identifier))
    });

    Ok(CapturedInventory {
        applications,
        registry_complete: opened_views == complete_views,
        appx_complete,
        winget_hint_count,
    })
}

struct CapturedInventory {
    applications: Vec<InstalledApplication>,
    registry_complete: bool,
    appx_complete: bool,
    winget_hint_count: usize,
}

fn read_uninstall_view(
    root: &RegKey,
    view: u32,
    scope: ApplicationInstallScope,
    records: &mut Vec<RegistryRecord>,
) -> (bool, bool) {
    let uninstall = match root.open_subkey_with_flags(UNINSTALL_PATH, KEY_READ | view) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            log::debug!(
                "windows_uninstall_inventory_view_absent scope={scope:?} registry_view={}",
                registry_view(view) as u8
            );
            return (false, false);
        }
        Err(error) => {
            log::warn!(
                "windows_uninstall_inventory_view_unavailable scope={scope:?} native_code={:?} error_kind={:?}",
                error.raw_os_error(),
                error.kind()
            );
            return (false, false);
        }
    };
    let mut complete = true;
    for key_name in uninstall.enum_keys() {
        let key_name = match key_name {
            Ok(name) => name,
            Err(error) => {
                log::warn!(
                    "windows_uninstall_inventory_entry_failed stage=enumerate native_code={:?} error_kind={:?}",
                    error.raw_os_error(),
                    error.kind()
                );
                complete = false;
                continue;
            }
        };
        let entry = match uninstall.open_subkey_with_flags(&key_name, KEY_READ | view) {
            Ok(entry) => entry,
            Err(error) => {
                log::warn!(
                    "windows_uninstall_inventory_entry_failed stage=open_entry native_code={:?} error_kind={:?}",
                    error.raw_os_error(),
                    error.kind()
                );
                complete = false;
                continue;
            }
        };
        let system_component = entry.get_value::<u32, _>("SystemComponent").ok();
        let release_type = string_value(&entry, "ReleaseType");
        if uninstall_entry_exclusion_reason(
            system_component,
            string_value(&entry, "ParentKeyName").is_some(),
            release_type.as_deref(),
        )
        .is_some()
        {
            continue;
        }
        let Some(name) = string_value(&entry, "DisplayName")
            .or_else(|| string_value(&entry, "QuietDisplayName"))
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let estimated_kib = entry.get_value::<u32, _>("EstimatedSize").ok();
        let estimated_bytes = estimated_kib
            .map(u64::from)
            .unwrap_or_default()
            .saturating_mul(1024);
        let install_location = string_value(&entry, "InstallLocation")
            .as_deref()
            .and_then(package_locations::parse_registry_path);
        let icon_path = package_locations::resolve_icon_path(
            string_value(&entry, "DisplayIcon").as_deref(),
            install_location.as_deref(),
        );
        let executable_paths = icon_path
            .iter()
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
            })
            .cloned()
            .collect::<Vec<_>>();
        let registry_view = registry_view(view);
        let (uninstall_registration, uninstall_diagnostic) =
            registration_for_entry(&entry, &key_name, scope, registry_view, estimated_bytes);
        let installed_at_ms = string_value(&entry, "InstallDate")
            .as_deref()
            .and_then(package_locations::parse_install_date)
            .or_else(|| {
                install_location
                    .as_deref()
                    .or_else(|| executable_paths.first().and_then(|path| path.parent()))
                    .and_then(package_locations::path_timestamp_millis)
            });
        records.push(RegistryRecord {
            key_name,
            scope,
            registry_view,
            name,
            version: string_value(&entry, "DisplayVersion").filter(|value| !value.trim().is_empty()),
            publisher: string_value(&entry, "Publisher").filter(|value| !value.trim().is_empty()),
            estimated_bytes,
            installed_at_ms,
            icon_path,
            install_location,
            executable_paths,
            uninstall_registration,
            uninstall_diagnostic,
        });
    }
    (true, complete)
}

fn registration_for_entry(
    entry: &RegKey,
    key_name: &str,
    scope: ApplicationInstallScope,
    registry_view: WindowsRegistryView,
    estimated_bytes: u64,
) -> (
    Option<ApplicationUninstallRegistration>,
    Option<ApplicationUninstallDiagnostic>,
) {
    if let Some(product_code) = msi_product_code(entry, key_name) {
        return (
            Some(ApplicationUninstallRegistration::WindowsMsi {
                product_code,
                scope,
                estimated_bytes,
            }),
            None,
        );
    }
    let command = match entry.get_value::<String, _>("UninstallString") {
        Ok(command) => command,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (
                None,
                Some(ApplicationUninstallDiagnostic::CommandMissing),
            );
        }
        Err(_) => {
            return (
                None,
                Some(ApplicationUninstallDiagnostic::CommandUnreadable),
            );
        }
    };
    match package_sources::parse_uninstall_command(&command, key_name, scope) {
        Ok(parsed) => (
            Some(ApplicationUninstallRegistration::WindowsRegistered {
                key_name: key_name.to_string(),
                scope,
                registry_view,
                command_kind: parsed.kind,
                command_digest: package_sources::command_digest(&parsed),
                estimated_bytes,
            }),
            None,
        ),
        Err(reason) => (None, Some(reason)),
    }
}

fn msi_product_code(entry: &RegKey, key_name: &str) -> Option<String> {
    (entry.get_value::<u32, _>("WindowsInstaller").ok() == Some(1))
        .then(|| normalize_product_code(key_name))
        .flatten()
}

fn normalize_product_code(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() != 38
        || bytes.first() != Some(&b'{')
        || bytes.last() != Some(&b'}')
        || [9, 14, 19, 24]
            .into_iter()
            .any(|index| bytes.get(index) != Some(&b'-'))
        || bytes[1..37].iter().enumerate().any(|(index, byte)| {
            !matches!(index + 1, 9 | 14 | 19 | 24) && !byte.is_ascii_hexdigit()
        })
    {
        return None;
    }
    Some(value.to_ascii_uppercase())
}

fn uninstall_entry_exclusion_reason(
    system_component: Option<u32>,
    has_parent_key: bool,
    release_type: Option<&str>,
) -> Option<&'static str> {
    if system_component == Some(1) {
        Some("hidden_component")
    } else if has_parent_key {
        Some("child_registration")
    } else if matches!(release_type, Some("Update" | "Hotfix" | "Security Update")) {
        Some("system_update")
    } else {
        None
    }
}

fn read_packaged_applications() -> PlatformResult<Vec<package_sources::PackagedApplicationRecord>> {
    let value = run_powershell_json(package_sources::APPX_INVENTORY_SCRIPT)?;
    let inventory: PackagedApplicationInventory =
        serde_json::from_value(value).map_err(|error| {
            PlatformError::new(
                PlatformErrorCode::InvalidData,
                format!("windows_packaged_application_parse_failed error={error}"),
            )
        })?;
    if inventory.schema_version != 1 {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "windows_packaged_application_schema_unsupported",
        ));
    }
    Ok(inventory.items)
}

fn winget_products(cancellation: &Cancellation) -> Vec<WingetProduct> {
    let Some(winget) = winget_path() else {
        return Vec::new();
    };
    let arguments = ["list", "--disable-interactivity"];
    match run_command_with_timeout(&winget, &arguments, WINGET_TIMEOUT, Some(cancellation)) {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            package_sources::parse_winget_list(&text)
        }
        Ok(output) => {
            log::debug!(
                "windows_winget_list_unavailable exit_code={:?}",
                output.status.code()
            );
            Vec::new()
        }
        Err(error) => {
            log::debug!(
                "windows_winget_list_failed code={:?} diagnostic={}",
                error.code(),
                error.diagnostic()
            );
            Vec::new()
        }
    }
}

fn winget_path() -> Option<PathBuf> {
    let path = directories::local_data_directory()
        .ok()?
        .join("Microsoft")
        .join("WindowsApps")
        .join("winget.exe");
    path.is_file().then_some(path)
}

fn powershell_path() -> PlatformResult<PathBuf> {
    // `system_directory` returns `%SystemRoot%`; PowerShell lives under
    // `System32`, which WOW64 maps to `SysWOW64` for a 32-bit process.
    let root = directories::system_directory()?;
    let candidates = [
        root.join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
        root.join("Sysnative")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe"),
    ];
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            PlatformError::new(
                PlatformErrorCode::Unsupported,
                "windows_powershell_unavailable",
            )
        })
}

fn run_command_with_timeout(
    program: &PathBuf,
    arguments: &[&str],
    timeout: Duration,
    cancellation: Option<&Cancellation>,
) -> PlatformResult<Output> {
    let mut child = hidden_command(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| PlatformError::io("windows_process_spawn", &error))?;
    // The child must never block on a full pipe: a process table or package
    // list is larger than the pipe buffer, and a blocked child never exits.
    let stdout_reader = child
        .stdout
        .take()
        .map(|stdout| std::thread::spawn(move || read_stream(stdout)));
    let stderr_reader = child
        .stderr
        .take()
        .map(|stderr| std::thread::spawn(move || read_stream(stderr)));
    let started = Instant::now();
    let status = loop {
        if cancellation.is_some_and(Cancellation::is_cancelled) {
            terminate(&mut child);
            return Err(cancelled_error("windows_process_cancelled"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                terminate(&mut child);
                return Err(PlatformError::new(
                    PlatformErrorCode::OperationFailed,
                    "windows_process_timeout",
                )
                .with_failure_reason(PlatformFailureReason::TimedOut));
            }
            Ok(None) => std::thread::sleep(PROCESS_POLL_INTERVAL),
            Err(error) => {
                terminate(&mut child);
                return Err(PlatformError::io("windows_process_poll", &error));
            }
        }
    };
    let stdout = join_stream(stdout_reader, "windows_process_stdout")?;
    let stderr = join_stream(stderr_reader, "windows_process_stderr")?;
    if stdout.len() > MAX_OUTPUT_BYTES || stderr.len() > MAX_OUTPUT_BYTES {
        return Err(PlatformError::new(
            PlatformErrorCode::OperationFailed,
            "windows_process_output_exceeded",
        ));
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

/// Drains one child pipe while retaining a bounded prefix.
fn read_stream(mut reader: impl std::io::Read) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(retained),
            Ok(read) => {
                let remaining = MAX_OUTPUT_BYTES.saturating_add(1).saturating_sub(retained.len());
                let keep = remaining.min(read);
                retained.extend_from_slice(&buffer[..keep]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
}

fn join_stream(
    handle: Option<std::thread::JoinHandle<std::io::Result<Vec<u8>>>>,
    operation: &'static str,
) -> PlatformResult<Vec<u8>> {
    let Some(handle) = handle else {
        return Ok(Vec::new());
    };
    match handle.join() {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(error)) => Err(PlatformError::io(operation, &error)),
        Err(_) => Err(PlatformError::operation_failed(operation)),
    }
}

fn terminate(child: &mut Child) {
    if let Err(error) = child.kill() {
        log::debug!("windows_process_kill_failed error={error}");
    }
    let _ = child.wait();
}

fn cancelled_error(operation: &'static str) -> PlatformError {
    PlatformError::new(PlatformErrorCode::UserCancelled, operation)
}

fn uninstall_view_revision(
    uninstall: &RegKey,
    cancellation: &Cancellation,
) -> PlatformResult<String> {
    let metadata = uninstall.query_info().map_err(|error| {
        PlatformError::io("windows_inventory_revision", &error)
    })?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(format!("{:?}", metadata.last_write_time).as_bytes());
    hasher.update(&metadata.sub_keys.to_le_bytes());
    let mut key_names = uninstall
        .enum_keys()
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    key_names.sort_by_key(|name| name.to_ascii_lowercase());
    for key_name in key_names {
        if cancellation.is_cancelled() {
            return Err(cancelled_error("windows_inventory_revision_cancelled"));
        }
        hasher.update(key_name.to_ascii_lowercase().as_bytes());
        match uninstall
            .open_subkey_with_flags(&key_name, KEY_READ)
            .and_then(|key| key.query_info())
        {
            Ok(metadata) => {
                hasher.update(format!("{:?}", metadata.last_write_time).as_bytes());
                hasher.update(&metadata.values.to_le_bytes());
            }
            Err(_) => {
                hasher.update(b"unavailable");
            }
        }
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn appx_repository_revision() -> String {
    match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(APPX_REPOSITORY_PATH, KEY_READ)
        .and_then(|key| key.query_info())
    {
        Ok(metadata) => format!("{:?}:{}", metadata.last_write_time, metadata.sub_keys),
        Err(_) => "unavailable".to_string(),
    }
}

fn registry_view(view: u32) -> WindowsRegistryView {
    if view == KEY_WOW64_32KEY {
        WindowsRegistryView::Registry32
    } else {
        WindowsRegistryView::Registry64
    }
}

fn string_value(key: &RegKey, name: &str) -> Option<String> {
    key.get_value::<String, _>(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_codes_require_the_canonical_guid_shape() {
        assert_eq!(
            normalize_product_code("{26A24AE4-039D-4CA4-87B4-2F83217017FF}").as_deref(),
            Some("{26A24AE4-039D-4CA4-87B4-2F83217017FF}")
        );
        assert_eq!(
            normalize_product_code("{26a24ae4-039d-4ca4-87b4-2f83217017ff}").as_deref(),
            Some("{26A24AE4-039D-4CA4-87B4-2F83217017FF}")
        );
        for invalid in [
            "26A24AE4-039D-4CA4-87B4-2F83217017FF",
            "{26A24AE4-039D-4CA4-87B4-2F83217017F}",
            "{26A24AE4-039D-4CA4-87B4-2F83217017FG}",
            "{26A24AE4_039D-4CA4-87B4-2F83217017FF}",
            "",
        ] {
            assert_eq!(normalize_product_code(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn hidden_updates_and_child_registrations_are_excluded() {
        assert_eq!(
            uninstall_entry_exclusion_reason(Some(1), false, None),
            Some("hidden_component")
        );
        assert_eq!(
            uninstall_entry_exclusion_reason(None, true, None),
            Some("child_registration")
        );
        for release_type in ["Update", "Hotfix", "Security Update"] {
            assert_eq!(
                uninstall_entry_exclusion_reason(None, false, Some(release_type)),
                Some("system_update")
            );
        }
        assert_eq!(
            uninstall_entry_exclusion_reason(None, false, Some("Patch")),
            None
        );
        assert_eq!(uninstall_entry_exclusion_reason(Some(0), false, None), None);
    }

    #[test]
    fn registry_view_mapping_is_stable() {
        assert_eq!(registry_view(KEY_WOW64_32KEY), WindowsRegistryView::Registry32);
        assert_eq!(registry_view(KEY_WOW64_64KEY), WindowsRegistryView::Registry64);
    }
}
