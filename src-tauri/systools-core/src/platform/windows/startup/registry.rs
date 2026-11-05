//! Registry `Run`, `RunOnce`, and policy Run startup entries.
//!
//! Windows stores the enabled/disabled override for a Run value in the
//! `StartupApproved` key. Toggling therefore edits that override instead of
//! rewriting the command, which keeps the native command text intact.

use std::env;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::slice;
use std::time::{Instant, UNIX_EPOCH};

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::UI::Shell::CommandLineToArgvW;
use winreg::{
    enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_CREATE_SUB_KEY, KEY_READ, KEY_SET_VALUE,
        KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_BINARY,
    },
    types::FromRegValue,
    RegKey, RegValue, HKEY,
};

use crate::platform::contracts::diagnostics::text;
use crate::platform::contracts::{PlatformError, PlatformErrorCode, PlatformResult};
use crate::startup::platform::{
    PlatformStartupArtifact, PlatformStartupChangeRequest, PlatformStartupChangeResult,
    PlatformStartupConfiguredState, PlatformStartupControlCapability,
    PlatformStartupCoverageReason, PlatformStartupCoverageStatus, PlatformStartupDesiredState,
    PlatformStartupDiagnosticCode, PlatformStartupIdentityConfidence, PlatformStartupOwner,
    PlatformStartupRuntimeState, PlatformStartupScope, PlatformStartupSourceKind,
    PlatformStartupSourceResult, PlatformStartupSummarySource, PlatformStartupTarget,
    PlatformStartupTargetKind, PlatformStartupTrigger, StartupCancellation,
};

use super::super::path_identity;
use super::metadata::{
    file_version_metadata, filesystem_target_state, startup_trust, FilesystemTargetState,
};

const RUN_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_ONCE_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\RunOnce";
const POLICY_RUN_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\Run";
const STARTUP_APPROVED_PATH: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";

#[derive(Clone, Copy)]
struct RegistrySource {
    root: HKEY,
    root_name: &'static str,
    key_path: &'static str,
    view: u32,
    view_name: &'static str,
    scope: PlatformStartupScope,
    approval_bucket: Option<&'static str>,
    control_capability: PlatformStartupControlCapability,
}

pub(super) fn scan(cancellation: &StartupCancellation) -> PlatformStartupSourceResult {
    let started = Instant::now();
    let mut items = Vec::new();
    let mut partial_reason = None;
    for source in registry_sources() {
        if cancellation.is_cancelled() {
            return source_result(
                items,
                PlatformStartupCoverageStatus::Cancelled,
                Some(PlatformStartupCoverageReason::Cancelled),
                started,
            );
        }
        if let Err(reason) = scan_key(source, &mut items) {
            partial_reason.get_or_insert(reason);
        }
    }
    source_result(
        items,
        if partial_reason.is_some() {
            PlatformStartupCoverageStatus::Partial
        } else {
            PlatformStartupCoverageStatus::Complete
        },
        partial_reason,
        started,
    )
}

fn source_result(
    items: Vec<PlatformStartupArtifact>,
    status: PlatformStartupCoverageStatus,
    reason: Option<PlatformStartupCoverageReason>,
    started: Instant,
) -> PlatformStartupSourceResult {
    PlatformStartupSourceResult {
        source_id: "windows.registry.run".to_string(),
        required: true,
        status,
        reason,
        items,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

fn registry_sources() -> Vec<RegistrySource> {
    let roots_and_views = [
        (
            HKEY_CURRENT_USER,
            "hkcu",
            PlatformStartupScope::CurrentUser,
            PlatformStartupControlCapability::Toggleable,
            KEY_WOW64_64KEY,
            "64",
            "Run",
        ),
        (
            HKEY_LOCAL_MACHINE,
            "hklm",
            PlatformStartupScope::Machine,
            PlatformStartupControlCapability::ElevationRequired,
            KEY_WOW64_64KEY,
            "64",
            "Run",
        ),
        (
            HKEY_LOCAL_MACHINE,
            "hklm",
            PlatformStartupScope::Machine,
            PlatformStartupControlCapability::ElevationRequired,
            KEY_WOW64_32KEY,
            "32",
            "Run32",
        ),
    ];
    roots_and_views
        .into_iter()
        .flat_map(
            |(root, root_name, scope, control_capability, view, view_name, approval_bucket)| {
                [
                    RegistrySource {
                        root,
                        root_name,
                        key_path: RUN_PATH,
                        view,
                        view_name,
                        scope,
                        approval_bucket: Some(approval_bucket),
                        control_capability,
                    },
                    RegistrySource {
                        root,
                        root_name,
                        key_path: RUN_ONCE_PATH,
                        view,
                        view_name,
                        scope,
                        approval_bucket: None,
                        control_capability: PlatformStartupControlCapability::RemoveOnly,
                    },
                    RegistrySource {
                        root,
                        root_name,
                        key_path: POLICY_RUN_PATH,
                        view,
                        view_name,
                        scope,
                        approval_bucket: None,
                        control_capability: PlatformStartupControlCapability::PolicyManaged,
                    },
                ]
            },
        )
        .collect()
}

fn scan_key(
    source: RegistrySource,
    items: &mut Vec<PlatformStartupArtifact>,
) -> Result<(), PlatformStartupCoverageReason> {
    let root = RegKey::predef(source.root);
    let key = match root.open_subkey_with_flags(source.key_path, KEY_READ | source.view) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return Err(PlatformStartupCoverageReason::AccessDenied);
        }
        Err(_) => return Err(PlatformStartupCoverageReason::InvalidData),
    };
    let approval_key = source.approval_bucket.and_then(|bucket| {
        root.open_subkey_with_flags(
            format!(r"{STARTUP_APPROVED_PATH}\{bucket}"),
            KEY_READ | source.view,
        )
        .ok()
    });
    for value in key.enum_values() {
        let Ok((value_name, value)) = value else {
            return Err(PlatformStartupCoverageReason::InvalidData);
        };
        let Ok(command) = String::from_reg_value(&value) else {
            continue;
        };
        items.push(artifact_from_value(
            source,
            &value_name,
            &command,
            approval_key.as_ref(),
        ));
    }
    Ok(())
}

pub(super) fn log_change_request(request: &PlatformStartupChangeRequest) {
    if request.source_id != "windows.registry.run" {
        return;
    }
    for source in registry_sources() {
        let prefix = provider_item_prefix(source);
        let Some(value_name) = request.provider_item_id.strip_prefix(&prefix) else {
            continue;
        };
        let display_name = &request.expected_artifact.display_name;
        // Provider IDs normalize case. A default value instead has a derived display label,
        // which must never replace its empty native value name in diagnostics.
        let value_name = if display_name.to_lowercase() == value_name {
            display_name.as_str()
        } else {
            value_name
        };
        log::info!(
            "windows_startup_registry_change_requested provider_item_id={} display_name={} registry_root={} registry_key={} registry_view={} registry_value_name={} approval_key={} desired_state={:?}",
            text(&request.provider_item_id),
            text(display_name),
            source.root_name,
            text(source.key_path),
            source.view_name,
            text(value_name),
            text(
                &source.approval_bucket.map(|bucket| format!(r"{STARTUP_APPROVED_PATH}\{bucket}")).unwrap_or_default()
            ),
            request.desired_state
        );
        break;
    }
}

pub(super) fn change(
    request: &PlatformStartupChangeRequest,
) -> PlatformResult<PlatformStartupChangeResult> {
    let (source, value_name, current) = find_item(&request.provider_item_id)?;
    if current != request.expected_artifact {
        return Err(PlatformError::item_changed(
            "registry startup item changed after preflight",
        ));
    }
    if request.desired_state == PlatformStartupDesiredState::Removed {
        return remove_startup_value(source, &value_name, &current);
    }
    if !matches!(
        current.control_capability,
        PlatformStartupControlCapability::Toggleable
            | PlatformStartupControlCapability::ElevationRequired
    ) {
        return Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "registry startup item is not toggleable",
        ));
    }
    let bucket = source.approval_bucket.ok_or_else(|| {
        PlatformError::new(
            PlatformErrorCode::Unsupported,
            "registry startup item has no compatible state store",
        )
    })?;
    let root = RegKey::predef(source.root);
    let approval_path = format!(r"{STARTUP_APPROVED_PATH}\{bucket}");
    let (approval_key, _) = root
        .create_subkey_with_flags(
            approval_path,
            KEY_READ | KEY_SET_VALUE | KEY_CREATE_SUB_KEY | source.view,
        )
        .map_err(|error| PlatformError::io("open startup approval state", &error))?;
    let existing = approval_key.get_raw_value(&value_name).ok();
    if existing
        .as_ref()
        .is_some_and(|value| value.vtype != REG_BINARY)
    {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup approval state has an unsupported registry type",
        ));
    }
    let desired = desired_configured_state(request.desired_state);
    if current.configured_state != desired {
        match request.desired_state {
            PlatformStartupDesiredState::Enabled => {
                // Absence is Windows' native enabled state for Run entries. Removing the disabled
                // override restores that state without leaving app-owned registry residue.
                if let Err(error) = approval_key.delete_value(&value_name) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        return Err(PlatformError::io("remove startup approval state", &error));
                    }
                }
            }
            PlatformStartupDesiredState::Disabled => {
                let bytes =
                    changed_startup_approved_bytes(existing.as_ref(), request.desired_state)?;
                approval_key
                    .set_raw_value(
                        &value_name,
                        &RegValue {
                            bytes: bytes.into(),
                            vtype: REG_BINARY,
                        },
                    )
                    .map_err(|error| PlatformError::io("write startup approval state", &error))?;
            }
            PlatformStartupDesiredState::Removed => {
                return Err(PlatformError::new(
                    PlatformErrorCode::Unsupported,
                    "removed startup items do not use approval state bytes",
                ));
            }
        }
    }
    let command_key = root
        .open_subkey_with_flags(source.key_path, KEY_READ | source.view)
        .map_err(|error| PlatformError::io("reopen registry startup item", &error))?;
    let command = command_key
        .get_raw_value(&value_name)
        .ok()
        .and_then(|value| String::from_reg_value(&value).ok())
        .ok_or_else(|| PlatformError::item_changed("registry startup item disappeared"))?;
    let verified = artifact_from_value(source, &value_name, &command, Some(&approval_key));
    Ok(PlatformStartupChangeResult {
        previous_state: current.configured_state,
        configured_state: verified.configured_state,
        verified: verified.configured_state == desired,
    })
}

fn remove_startup_value(
    source: RegistrySource,
    value_name: &str,
    current: &PlatformStartupArtifact,
) -> PlatformResult<PlatformStartupChangeResult> {
    if !matches!(
        current.control_capability,
        PlatformStartupControlCapability::Toggleable
            | PlatformStartupControlCapability::ElevationRequired
            | PlatformStartupControlCapability::RemoveOnly
    ) {
        return Err(PlatformError::item_changed(
            "registry startup item is no longer removable",
        ));
    }

    let root = RegKey::predef(source.root);
    let key = root
        .open_subkey_with_flags(source.key_path, KEY_READ | KEY_SET_VALUE | source.view)
        .map_err(|error| PlatformError::io("open registry startup item for removal", &error))?;
    key.delete_value(value_name)
        .map_err(|error| PlatformError::io("remove registry startup item", &error))?;
    if let Some(bucket) = source.approval_bucket {
        if let Ok(approval) = root.open_subkey_with_flags(
            format!(r"{STARTUP_APPROVED_PATH}\{bucket}"),
            KEY_SET_VALUE | source.view,
        ) {
            let _ = approval.delete_value(value_name);
        }
    }
    let verified = matches!(
        key.get_raw_value(value_name),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    );
    Ok(PlatformStartupChangeResult {
        previous_state: current.configured_state,
        configured_state: PlatformStartupConfiguredState::NotApplicable,
        verified,
    })
}

fn find_item(
    provider_item_id: &str,
) -> PlatformResult<(RegistrySource, String, PlatformStartupArtifact)> {
    for source in registry_sources() {
        let root = RegKey::predef(source.root);
        let key = match root.open_subkey_with_flags(source.key_path, KEY_READ | source.view) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(PlatformError::io("read registry startup item", &error)),
        };
        let approval_key = source.approval_bucket.and_then(|bucket| {
            root.open_subkey_with_flags(
                format!(r"{STARTUP_APPROVED_PATH}\{bucket}"),
                KEY_READ | source.view,
            )
            .ok()
        });
        for value in key.enum_values() {
            let (value_name, value) = value
                .map_err(|error| PlatformError::io("enumerate registry startup item", &error))?;
            let Ok(command) = String::from_reg_value(&value) else {
                continue;
            };
            let artifact =
                artifact_from_value(source, &value_name, &command, approval_key.as_ref());
            if artifact.provider_item_id == provider_item_id {
                return Ok((source, value_name, artifact));
            }
        }
    }
    Err(PlatformError::item_changed(
        "registry startup item no longer exists",
    ))
}

pub(super) fn desired_configured_state(
    desired: PlatformStartupDesiredState,
) -> PlatformStartupConfiguredState {
    match desired {
        PlatformStartupDesiredState::Enabled => PlatformStartupConfiguredState::Enabled,
        PlatformStartupDesiredState::Disabled => PlatformStartupConfiguredState::Disabled,
        PlatformStartupDesiredState::Removed => PlatformStartupConfiguredState::NotApplicable,
    }
}

pub(super) fn changed_startup_approved_bytes(
    existing: Option<&RegValue<'_>>,
    desired: PlatformStartupDesiredState,
) -> PlatformResult<Vec<u8>> {
    let mut bytes = existing
        .map(|value| value.bytes.to_vec())
        .unwrap_or_else(|| vec![0; 12]);
    if bytes.len() < 12 {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "startup approval state has an unsupported format",
        ));
    }
    bytes[0] = match (bytes[0], desired) {
        (0x06 | 0x07, PlatformStartupDesiredState::Enabled) => 0x06,
        (0x06 | 0x07, PlatformStartupDesiredState::Disabled) => 0x07,
        (_, PlatformStartupDesiredState::Enabled) => 0x02,
        (_, PlatformStartupDesiredState::Disabled) => 0x03,
        (_, PlatformStartupDesiredState::Removed) => {
            return Err(PlatformError::new(
                PlatformErrorCode::Unsupported,
                "removed startup items do not use approval state bytes",
            ));
        }
    };
    Ok(bytes)
}

fn provider_item_prefix(source: RegistrySource) -> String {
    format!(
        "registry:{}:{}:{}:",
        source.root_name,
        source.view_name,
        source.key_path.to_lowercase()
    )
}

fn artifact_from_value(
    source: RegistrySource,
    value_name: &str,
    command: &str,
    approval_key: Option<&RegKey>,
) -> PlatformStartupArtifact {
    let command_parts = split_command_line(command);
    let raw_target = command_parts.first().cloned();
    let target_path = raw_target
        .as_deref()
        .map(expand_environment_variables)
        .map(PathBuf::from);
    let diagnostics = if target_path.as_deref().is_some_and(|path| {
        is_definitive_filesystem_target(path)
            && filesystem_target_state(path) == FilesystemTargetState::Missing
    }) {
        vec![PlatformStartupDiagnosticCode::MissingTarget]
    } else if target_path.is_none() {
        vec![PlatformStartupDiagnosticCode::InvalidData]
    } else {
        Vec::new()
    };
    let configured_state = approval_key
        .and_then(|key| key.get_raw_value(value_name).ok())
        .map(|value| startup_approved_state(&value.bytes))
        .unwrap_or(PlatformStartupConfiguredState::Enabled);
    let executable_name = target_path
        .as_deref()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .or_else(|| raw_target.as_deref().and_then(command_file_name));
    let normalized_target = target_path
        .as_deref()
        .map(normalized_path)
        .unwrap_or_else(|| command.trim().to_lowercase());
    let version_metadata = target_path
        .as_deref()
        .and_then(file_version_metadata)
        .unwrap_or_default();
    let metadata_description_available = version_metadata.file_description.is_some();
    PlatformStartupArtifact {
        provider_item_id: format!(
            "{}{}",
            provider_item_prefix(source),
            value_name.to_lowercase()
        ),
        source_kind: PlatformStartupSourceKind::RegistryRun,
        scope: source.scope,
        triggers: vec![PlatformStartupTrigger::UserLogon],
        display_name: if value_name.trim().is_empty() {
            executable_name
                .clone()
                .unwrap_or_else(|| "Unnamed startup item".to_string())
        } else {
            value_name.to_string()
        },
        configuration_path: None,
        target: PlatformStartupTarget {
            kind: target_kind(target_path.as_deref()),
            identity_key: format!("path:{normalized_target}"),
            path: target_path.clone(),
            executable_name,
            arguments: command_parts.into_iter().skip(1).collect(),
        },
        owner: PlatformStartupOwner {
            identity_key: target_path
                .as_deref()
                .map(|path| format!("path:{}", normalized_path(path))),
            name: version_metadata
                .product_name
                .or_else(|| Some(value_name.to_string()).filter(|name| !name.trim().is_empty())),
            publisher: version_metadata.company_name,
            summary: version_metadata.file_description,
            summary_source: if metadata_description_available {
                PlatformStartupSummarySource::VersionInfo
            } else {
                PlatformStartupSummarySource::SourceLabel
            },
            version: version_metadata.file_version,
            icon_path: target_path.clone().filter(|path| path.exists()),
            confidence: if target_path.is_some() {
                PlatformStartupIdentityConfidence::Strong
            } else {
                PlatformStartupIdentityConfidence::Unresolved
            },
        },
        configured_state,
        runtime_state: PlatformStartupRuntimeState::Unknown,
        control_capability: source.control_capability,
        trust: startup_trust(
            target_path.as_deref(),
            target_path
                .as_deref()
                .is_some_and(|path| normalized_path(path).starts_with("c:\\windows\\")),
        ),
        modified_at_ms: target_path.as_deref().and_then(modified_at_ms),
        diagnostics,
    }
}

fn is_definitive_filesystem_target(path: &Path) -> bool {
    path.is_absolute()
        && matches!(
            target_kind(Some(path)),
            PlatformStartupTargetKind::Executable | PlatformStartupTargetKind::Script
        )
}

pub(super) fn startup_approved_state(bytes: &[u8]) -> PlatformStartupConfiguredState {
    match bytes.first().copied() {
        Some(0x02) | Some(0x06) => PlatformStartupConfiguredState::Enabled,
        Some(0x03) | Some(0x07) => PlatformStartupConfiguredState::Disabled,
        _ => PlatformStartupConfiguredState::Unknown,
    }
}

pub(super) fn split_command_line(command: &str) -> Vec<String> {
    let wide: Vec<u16> = command.encode_utf16().chain(Some(0)).collect();
    let mut count = 0;
    // Windows startup commands often depend on subtle quote and backslash escaping rules. The
    // native parser preserves those semantics and avoids a second, incomplete command grammar.
    let argv = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut count) };
    if argv.is_null() || count <= 0 {
        return Vec::new();
    }
    let values = unsafe { slice::from_raw_parts(argv, count as usize) }
        .iter()
        .map(|argument| {
            let argument = *argument;
            let mut length = 0;
            unsafe {
                while *argument.add(length) != 0 {
                    length += 1;
                }
                OsString::from_wide(slice::from_raw_parts(argument, length))
                    .to_string_lossy()
                    .into_owned()
            }
        })
        .collect();
    unsafe {
        LocalFree(argv.cast());
    }
    values
}

pub(super) fn expand_environment_variables(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut remaining = value;
    while let Some(start) = remaining.find('%') {
        output.push_str(&remaining[..start]);
        let after_start = &remaining[start + 1..];
        let Some(end) = after_start.find('%') else {
            output.push_str(&remaining[start..]);
            return output;
        };
        let name = &after_start[..end];
        if let Some(replacement) = env::var_os(name) {
            output.push_str(&replacement.to_string_lossy());
        } else {
            output.push('%');
            output.push_str(name);
            output.push('%');
        }
        remaining = &after_start[end + 1..];
    }
    output.push_str(remaining);
    output
}

pub(super) fn normalized_path(path: &Path) -> String {
    path_identity::comparison_key(path)
}

fn command_file_name(value: &str) -> Option<String> {
    Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
}

pub(super) fn target_kind(path: Option<&Path>) -> PlatformStartupTargetKind {
    match path
        .and_then(Path::extension)
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("exe") | Some("com") => PlatformStartupTargetKind::Executable,
        Some("cmd") | Some("bat") | Some("ps1") | Some("vbs") | Some("js") => {
            PlatformStartupTargetKind::Script
        }
        Some(_) => PlatformStartupTargetKind::Other,
        None => PlatformStartupTargetKind::Unknown,
    }
}

pub(super) fn modified_at_ms(path: &Path) -> Option<u64> {
    path.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::{
        artifact_from_value, changed_startup_approved_bytes, expand_environment_variables,
        registry_sources, split_command_line, startup_approved_state,
    };
    use crate::startup::platform::{
        PlatformStartupConfiguredState, PlatformStartupDesiredState, PlatformStartupDiagnosticCode,
    };
    use winreg::{enums::REG_BINARY, RegValue};

    #[test]
    fn registry_provider_identity_preserves_value_name_boundaries() {
        let source = registry_sources()
            .into_iter()
            .next()
            .expect("the current-user Run source must exist");
        let artifact = artifact_from_value(source, "Fixture:\u{503c}\nName", "cmd.exe", None);
        assert_eq!(
            artifact.provider_item_id,
            "registry:hkcu:64:software\\microsoft\\windows\\currentversion\\run:fixture:\u{503c}\nname"
        );
    }

    #[test]
    fn quoted_command_preserves_executable_and_arguments() {
        let values =
            split_command_line(r#""C:\Program Files\Example\agent.exe" --silent "two words""#);

        assert_eq!(values[0], r"C:\Program Files\Example\agent.exe");
        assert_eq!(values[1..], ["--silent", "two words"]);
    }

    #[test]
    fn startup_approved_unknown_data_remains_unknown() {
        assert_eq!(
            startup_approved_state(&[0xff, 0, 0, 0]),
            PlatformStartupConfiguredState::Unknown
        );
        assert_eq!(
            startup_approved_state(&[]),
            PlatformStartupConfiguredState::Unknown
        );
    }

    #[test]
    fn unknown_environment_variable_is_preserved() {
        let value = expand_environment_variables(r"%MANGODISK_TEST_UNKNOWN%\agent.exe");

        assert_eq!(value, r"%MANGODISK_TEST_UNKNOWN%\agent.exe");
    }

    #[test]
    fn bare_executable_is_not_reported_as_a_missing_target() {
        let source = registry_sources()
            .into_iter()
            .next()
            .expect("at least one registry source must exist");
        let artifact = artifact_from_value(source, "Fixture", "cmd.exe /c exit", None);

        assert!(!artifact
            .diagnostics
            .contains(&PlatformStartupDiagnosticCode::MissingTarget));
    }

    #[test]
    fn relative_targets_fail_closed() {
        let source = registry_sources()
            .into_iter()
            .next()
            .expect("at least one registry source must exist");
        let artifact = artifact_from_value(source, "Fixture", r"tools\agent.exe --silent", None);

        assert!(!artifact
            .diagnostics
            .contains(&PlatformStartupDiagnosticCode::MissingTarget));
    }

    #[test]
    fn startup_approved_change_preserves_native_payload() {
        let original = RegValue {
            bytes: vec![0x02, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11].into(),
            vtype: REG_BINARY,
        };

        let disabled =
            changed_startup_approved_bytes(Some(&original), PlatformStartupDesiredState::Disabled)
                .expect("a recognized startup approval payload must be mutable");

        assert_eq!(disabled[0], 0x03);
        assert_eq!(disabled[1..], original.bytes[1..]);
    }

    #[test]
    fn startup_approved_change_rejects_truncated_payload() {
        let original = RegValue {
            bytes: vec![0x02, 0].into(),
            vtype: REG_BINARY,
        };

        assert!(changed_startup_approved_bytes(
            Some(&original),
            PlatformStartupDesiredState::Disabled,
        )
        .is_err());
    }
}
