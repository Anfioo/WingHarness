//! User and common Startup folder entries.
//!
//! Each regular file in a Startup folder is one logon payload. Shortcut files
//! are resolved to their target, while the enabled/disabled override lives in
//! the per-folder `StartupApproved` registry key next to the file name.

use std::ffi::OsString;
use std::fs;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::time::Instant;

use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{
    FOLDERID_CommonStartup, FOLDERID_Startup, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
};
use windows_core::PWSTR;
use winreg::{
    enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_CREATE_SUB_KEY, KEY_READ, KEY_SET_VALUE,
        REG_BINARY,
    },
    RegKey, RegValue,
};

use crate::platform::contracts::{PlatformError, PlatformErrorCode, PlatformResult};
use crate::startup::platform::{
    PlatformStartupArtifact, PlatformStartupChangeRequest, PlatformStartupChangeResult,
    PlatformStartupConfiguredState, PlatformStartupControlCapability,
    PlatformStartupCoverageReason, PlatformStartupCoverageStatus, PlatformStartupDesiredState,
    PlatformStartupDiagnosticCode, PlatformStartupIdentityConfidence, PlatformStartupOwner,
    PlatformStartupRuntimeState, PlatformStartupScope, PlatformStartupSourceKind,
    PlatformStartupSourceResult, PlatformStartupSummarySource, PlatformStartupTarget,
    PlatformStartupTrigger, StartupCancellation,
};

use super::metadata::{
    file_version_metadata, filesystem_target_state, startup_trust, FilesystemTargetState,
};
use super::registry::{
    changed_startup_approved_bytes, desired_configured_state, modified_at_ms, normalized_path,
    split_command_line, startup_approved_state, target_kind,
};

const STARTUP_APPROVED_FOLDER_PATH: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";

#[derive(Clone, Copy)]
struct FolderSource {
    source_id: &'static str,
    folder_id: &'static windows_core::GUID,
    scope: PlatformStartupScope,
    approval_root: winreg::HKEY,
    control_capability: PlatformStartupControlCapability,
}

pub(super) fn scan(cancellation: &StartupCancellation) -> Vec<PlatformStartupSourceResult> {
    folder_sources()
        .into_iter()
        .map(|source| scan_folder(source, cancellation))
        .collect()
}

fn scan_folder(
    source: FolderSource,
    cancellation: &StartupCancellation,
) -> PlatformStartupSourceResult {
    let started = Instant::now();
    let folder = match known_folder_path(source.folder_id) {
        Ok(folder) => folder,
        Err(_) => {
            return result(
                source.source_id,
                Vec::new(),
                PlatformStartupCoverageStatus::Unavailable,
                Some(PlatformStartupCoverageReason::ApiUnavailable),
                started,
            );
        }
    };
    let approval = RegKey::predef(source.approval_root)
        .open_subkey_with_flags(STARTUP_APPROVED_FOLDER_PATH, KEY_READ)
        .ok();
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return result(
                source.source_id,
                Vec::new(),
                PlatformStartupCoverageStatus::Complete,
                None,
                started,
            );
        }
        Err(error) => {
            let reason = if error.kind() == std::io::ErrorKind::PermissionDenied {
                PlatformStartupCoverageReason::AccessDenied
            } else {
                PlatformStartupCoverageReason::InvalidData
            };
            return result(
                source.source_id,
                Vec::new(),
                PlatformStartupCoverageStatus::Unavailable,
                Some(reason),
                started,
            );
        }
    };
    let mut items = Vec::new();
    let mut partial_reason = None;
    for entry in entries {
        if cancellation.is_cancelled() {
            return result(
                source.source_id,
                items,
                PlatformStartupCoverageStatus::Cancelled,
                Some(PlatformStartupCoverageReason::Cancelled),
                started,
            );
        }
        let Ok(entry) = entry else {
            partial_reason.get_or_insert(PlatformStartupCoverageReason::InvalidData);
            continue;
        };
        let path = entry.path();
        if is_startup_folder_metadata(&path) {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                partial_reason.get_or_insert(PlatformStartupCoverageReason::InvalidData);
                continue;
            }
        };
        if file_type.is_dir() || file_type.is_symlink() {
            continue;
        }
        items.push(folder_artifact(source, &path, approval.as_ref()));
    }
    result(
        source.source_id,
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

pub(super) fn change(
    request: &PlatformStartupChangeRequest,
) -> PlatformResult<PlatformStartupChangeResult> {
    let (source, source_path, current) = find_item(&request.provider_item_id)?;
    if current != request.expected_artifact {
        return Err(PlatformError::item_changed(
            "startup folder item changed after preflight",
        ));
    }
    if request.desired_state == PlatformStartupDesiredState::Removed {
        return remove_startup_shortcut(source, &source_path, &current);
    }
    if !matches!(
        current.control_capability,
        PlatformStartupControlCapability::Toggleable
            | PlatformStartupControlCapability::ElevationRequired
    ) {
        return Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "startup folder item is not toggleable",
        ));
    }
    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| PlatformError::item_changed("startup folder item name is unavailable"))?;
    let root = RegKey::predef(source.approval_root);
    let (approval, _) = root
        .create_subkey_with_flags(
            STARTUP_APPROVED_FOLDER_PATH,
            KEY_READ | KEY_SET_VALUE | KEY_CREATE_SUB_KEY,
        )
        .map_err(|error| PlatformError::io("open startup folder approval state", &error))?;
    let desired = desired_configured_state(request.desired_state);
    let existing = approval.get_raw_value(file_name).ok();
    if current.configured_state != desired {
        let bytes = changed_startup_approved_bytes(existing.as_ref(), request.desired_state)?;
        approval
            .set_raw_value(
                file_name,
                &RegValue {
                    bytes: bytes.into(),
                    vtype: REG_BINARY,
                },
            )
            .map_err(|error| PlatformError::io("write startup folder approval state", &error))?;
    }
    let verified = folder_artifact(source, &source_path, Some(&approval));
    Ok(PlatformStartupChangeResult {
        previous_state: current.configured_state,
        configured_state: verified.configured_state,
        verified: verified.configured_state == desired,
    })
}

fn remove_startup_shortcut(
    source: FolderSource,
    source_path: &Path,
    current: &PlatformStartupArtifact,
) -> PlatformResult<PlatformStartupChangeResult> {
    let expected_folder = known_folder_path(source.folder_id).map_err(|error| {
        PlatformError::new(
            PlatformErrorCode::OperationFailed,
            format!("resolve startup folder: {error}"),
        )
    })?;
    let is_shortcut = source_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"));
    let metadata = fs::symlink_metadata(source_path)
        .map_err(|error| PlatformError::io("inspect startup shortcut for removal", &error))?;
    if source_path.parent() != Some(expected_folder.as_path())
        || !is_shortcut
        || !metadata.is_file()
        || metadata.file_type().is_symlink()
    {
        return Err(PlatformError::invalid_path(
            "startup shortcut is outside the removable source boundary",
        ));
    }

    fs::remove_file(source_path)
        .map_err(|error| PlatformError::io("remove startup shortcut", &error))?;
    if let Some(file_name) = source_path.file_name().and_then(|name| name.to_str()) {
        let root = RegKey::predef(source.approval_root);
        if let Ok(approval) =
            root.open_subkey_with_flags(STARTUP_APPROVED_FOLDER_PATH, KEY_SET_VALUE)
        {
            let _ = approval.delete_value(file_name);
        }
    }
    let verified = matches!(
        fs::symlink_metadata(source_path),
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
) -> PlatformResult<(FolderSource, PathBuf, PlatformStartupArtifact)> {
    for source in folder_sources() {
        let folder = known_folder_path(source.folder_id).map_err(|error| {
            PlatformError::new(
                PlatformErrorCode::OperationFailed,
                format!("resolve startup folder: {error}"),
            )
        })?;
        let root = RegKey::predef(source.approval_root);
        let approval = root
            .open_subkey_with_flags(STARTUP_APPROVED_FOLDER_PATH, KEY_READ)
            .ok();
        let entries = match fs::read_dir(folder) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(PlatformError::io("read startup folder", &error)),
        };
        for entry in entries {
            let entry =
                entry.map_err(|error| PlatformError::io("read startup folder item", &error))?;
            let path = entry.path();
            if is_startup_folder_metadata(&path) {
                continue;
            }
            let file_type = entry
                .file_type()
                .map_err(|error| PlatformError::io("inspect startup folder item", &error))?;
            if file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let artifact = folder_artifact(source, &path, approval.as_ref());
            if artifact.provider_item_id == provider_item_id {
                return Ok((source, path, artifact));
            }
        }
    }
    Err(PlatformError::item_changed(
        "startup folder item no longer exists",
    ))
}

fn folder_sources() -> [FolderSource; 2] {
    [
        FolderSource {
            source_id: "windows.startup_folder.user",
            folder_id: &FOLDERID_Startup,
            scope: PlatformStartupScope::CurrentUser,
            approval_root: HKEY_CURRENT_USER,
            control_capability: PlatformStartupControlCapability::Toggleable,
        },
        FolderSource {
            source_id: "windows.startup_folder.common",
            folder_id: &FOLDERID_CommonStartup,
            scope: PlatformStartupScope::AllUsers,
            approval_root: HKEY_LOCAL_MACHINE,
            control_capability: PlatformStartupControlCapability::ElevationRequired,
        },
    ]
}

fn is_startup_folder_metadata(path: &Path) -> bool {
    // Explorer keeps desktop.ini in both known startup folders to localize their display names.
    // The file is shell metadata rather than a logon payload, even though it is a regular file.
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("desktop.ini"))
}

fn folder_artifact(
    source: FolderSource,
    source_path: &Path,
    approval: Option<&RegKey>,
) -> PlatformStartupArtifact {
    let file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Unnamed startup item");
    let display_name = source_path
        .file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(file_name)
        .to_string();
    let is_link = source_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"));
    let (target_path, arguments, mut diagnostics) = if is_link {
        match super::super::shortcut_name::shortcut_target(source_path) {
            Some((target, arguments)) => (
                target,
                if arguments.trim().is_empty() {
                    Vec::new()
                } else {
                    split_command_line(&arguments)
                },
                Vec::new(),
            ),
            None => (
                source_path.to_path_buf(),
                Vec::new(),
                vec![PlatformStartupDiagnosticCode::UnsupportedFormat],
            ),
        }
    } else {
        (source_path.to_path_buf(), Vec::new(), Vec::new())
    };
    if filesystem_target_state(&target_path) == FilesystemTargetState::Missing {
        diagnostics.push(PlatformStartupDiagnosticCode::MissingTarget);
    }
    let configured_state = approval
        .and_then(|key| key.get_raw_value(file_name).ok())
        .map(|value| startup_approved_state(&value.bytes))
        .unwrap_or(PlatformStartupConfiguredState::Enabled);
    let identity = normalized_path(&target_path);
    let version_metadata = file_version_metadata(&target_path).unwrap_or_default();
    // The shared shortcut resolver does not expose the link description, so the
    // version-resource description is the only optional summary text available.
    let summary = version_metadata.file_description.clone();
    let summary_source = if summary.is_some() {
        if version_metadata.product_name.is_some()
            || version_metadata.company_name.is_some()
            || version_metadata.file_version.is_some()
        {
            PlatformStartupSummarySource::VersionInfo
        } else {
            PlatformStartupSummarySource::SourceLabel
        }
    } else {
        PlatformStartupSummarySource::Unavailable
    };
    PlatformStartupArtifact {
        provider_item_id: format!(
            "startup-folder:{}:{}",
            source.source_id,
            normalized_path(source_path)
        ),
        source_kind: PlatformStartupSourceKind::StartupFolder,
        scope: source.scope,
        triggers: vec![PlatformStartupTrigger::UserLogon],
        display_name: display_name.clone(),
        configuration_path: Some(source_path.to_path_buf()),
        target: PlatformStartupTarget {
            kind: target_kind(Some(&target_path)),
            identity_key: format!("path:{identity}"),
            path: Some(target_path.clone()),
            executable_name: target_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(ToOwned::to_owned),
            arguments,
        },
        owner: PlatformStartupOwner {
            identity_key: Some(format!("path:{identity}")),
            name: version_metadata.product_name.or(Some(display_name)),
            publisher: version_metadata.company_name,
            summary,
            summary_source,
            version: version_metadata.file_version,
            icon_path: Some(target_path.clone()).filter(|path| path.exists()),
            confidence: PlatformStartupIdentityConfidence::Strong,
        },
        configured_state,
        runtime_state: PlatformStartupRuntimeState::Unknown,
        control_capability: source.control_capability,
        trust: startup_trust(Some(&target_path), identity.starts_with("c:\\windows\\")),
        modified_at_ms: modified_at_ms(source_path),
        diagnostics,
    }
}

fn known_folder_path(folder_id: &windows_core::GUID) -> windows_core::Result<PathBuf> {
    let path: PWSTR = unsafe { SHGetKnownFolderPath(folder_id, KF_FLAG_DEFAULT, None)? };
    let mut length = 0;
    unsafe {
        while *path.0.add(length) != 0 {
            length += 1;
        }
    }
    let value = unsafe { OsString::from_wide(std::slice::from_raw_parts(path.0, length)) };
    unsafe {
        CoTaskMemFree(Some(path.0.cast()));
    }
    Ok(PathBuf::from(value))
}

fn result(
    source_id: &str,
    items: Vec<PlatformStartupArtifact>,
    status: PlatformStartupCoverageStatus,
    reason: Option<PlatformStartupCoverageReason>,
    started: Instant,
) -> PlatformStartupSourceResult {
    PlatformStartupSourceResult {
        source_id: source_id.to_string(),
        required: true,
        status,
        reason,
        items,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::is_startup_folder_metadata;

    #[test]
    fn desktop_ini_is_excluded_case_insensitively() {
        assert!(is_startup_folder_metadata(Path::new(
            r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Startup\desktop.ini"
        )));
        assert!(is_startup_folder_metadata(Path::new(
            r"C:\Users\fixture\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\DESKTOP.INI"
        )));
        assert!(!is_startup_folder_metadata(Path::new(
            r"C:\Users\fixture\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Desktop.lnk"
        )));
    }
}
