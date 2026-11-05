//! Changes only a service's configured startup mode, never its running state.
//! Authority comes from a fresh SCM snapshot, not a path supplied by the UI.
use std::io::ErrorKind;

use serde::{Deserialize, Serialize};
use windows::Win32::System::Services::*;
use windows_core::{HSTRING, PCWSTR};
use winreg::{
    enums::{HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_READ, KEY_SET_VALUE, KEY_WOW64_64KEY},
    RegKey,
};

use super::services::{artifact_from_config, query_service_config, EnumeratedService};
use crate::platform::contracts::{PlatformError, PlatformErrorCode, PlatformResult};
use crate::startup::platform::{
    PlatformStartupChangeRequest, PlatformStartupChangeResult, PlatformStartupConfiguredState,
    PlatformStartupControlCapability, PlatformStartupDesiredState,
};

const RESTORE_VALUE: &str = "MangoDiskStartupRestoreV1";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreConfig {
    schema_version: u32,
    binary_digest: String,
    delayed: u32,
}

struct ServiceHandle(SC_HANDLE);
impl Drop for ServiceHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}

fn service_key(name: &str, access: u32) -> std::io::Result<RegKey> {
    RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
        format!(r"SYSTEM\CurrentControlSet\Services\{name}"),
        access | KEY_WOW64_64KEY,
    )
}

pub(super) fn configuration_modified_at(name: &str) -> Option<u64> {
    let time = service_key(name, KEY_READ)
        .ok()?
        .query_info()
        .ok()?
        .last_write_time;
    let ticks = (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    (ticks / 10_000).checked_sub(11_644_473_600_000)
}

fn service_name(request: &PlatformStartupChangeRequest) -> PlatformResult<&str> {
    let name = request
        .provider_item_id
        .strip_prefix("service:")
        .unwrap_or_default();
    if request.source_id != "windows.services"
        || name.is_empty()
        || name.len() > 256
        || name.contains(['\\', '/', '\0'])
    {
        return Err(PlatformError::invalid_path("service_change stage=identity"));
    }
    Ok(name)
}

pub(super) fn change(
    request: &PlatformStartupChangeRequest,
) -> PlatformResult<PlatformStartupChangeResult> {
    // Removal is deliberately outside this capability, including forged helper requests.
    if !matches!(
        request.desired_state,
        PlatformStartupDesiredState::Enabled | PlatformStartupDesiredState::Disabled
    ) {
        return Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "service_change stage=unsupported_action",
        ));
    }
    let name = service_name(request)?;
    let manager = ServiceHandle(
        unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT) }
            .map_err(|error| native_error("open_manager", error))?,
    );
    let service = ServiceHandle(
        unsafe {
            OpenServiceW(
                manager.0,
                &HSTRING::from(name),
                SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | SERVICE_CHANGE_CONFIG,
            )
        }
        .map_err(|error| native_error("open_service", error))?,
    );
    let config = query_service_config(service.0, name)
        .map_err(|_| PlatformError::operation_failed("service_change stage=read_config"))?;
    let mut status = SERVICE_STATUS::default();
    unsafe { QueryServiceStatus(service.0, &mut status) }
        .map_err(|error| native_error("read_status", error))?;
    let current = artifact_from_config(
        &EnumeratedService {
            name: name.to_owned(),
            display_name: request.expected_artifact.display_name.clone(),
            running: status.dwCurrentState == SERVICE_RUNNING,
        },
        &config,
        None,
    );
    if current.control_capability != PlatformStartupControlCapability::ElevationRequired
        || crate::platform::startup_helper::artifact_digest(&current)
            != crate::platform::startup_helper::artifact_digest(&request.expected_artifact)
    {
        return Err(PlatformError::item_changed(
            "service_change stage=preflight",
        ));
    }
    let desired = if request.desired_state == PlatformStartupDesiredState::Enabled {
        PlatformStartupConfiguredState::Enabled
    } else {
        PlatformStartupConfiguredState::Disabled
    };
    if current.configured_state == desired {
        return Ok(PlatformStartupChangeResult {
            previous_state: current.configured_state,
            configured_state: desired,
            verified: true,
        });
    }

    // Store only a versioned digest and the original delay flag under the SCM-owned
    // key. Its administrator ACL prevents an unelevated client from injecting a
    // restore target, and removal of the service naturally removes its backup.
    let key = service_key(name, KEY_QUERY_VALUE | KEY_SET_VALUE)
        .map_err(|error| PlatformError::io("service_change stage=open_backup", &error))?;
    let binary_digest = blake3::hash(config.binary_path.as_bytes())
        .to_hex()
        .to_string();
    let enabling = desired == PlatformStartupConfiguredState::Enabled;
    let delayed = if enabling {
        match key.get_value::<String, _>(RESTORE_VALUE) {
            Ok(value) => restore_delay(&value, &binary_digest, config.delayed.unwrap_or(0))?,
            Err(error) if error.kind() == ErrorKind::NotFound => config.delayed.unwrap_or(0),
            Err(error) => {
                return Err(PlatformError::io(
                    "service_change stage=read_backup",
                    &error,
                ))
            }
        }
    } else {
        let delayed = config.delayed.unwrap_or(0);
        let backup = serde_json::to_string(&RestoreConfig {
            schema_version: 1,
            binary_digest,
            delayed,
        })
        .map_err(|_| PlatformError::operation_failed("service_change stage=encode_backup"))?;
        key.set_value(RESTORE_VALUE, &backup)
            .map_err(|error| PlatformError::io("service_change stage=write_backup", &error))?;
        delayed
    };
    let start_type = if enabling {
        SERVICE_AUTO_START
    } else {
        SERVICE_DISABLED
    };
    set_start_type(service.0, start_type)
        .map_err(|error| native_error("write_start_type", error).with_possible_side_effects())?;
    let after_start_type = query_service_config(service.0, name).map_err(|_| {
        PlatformError::operation_failed("service_change stage=verify_read")
            .with_possible_side_effects()
    })?;
    // Avoid materializing a redundant DelayedAutoStart=0 registry value when
    // Windows already retained the intended setting during the start-type change.
    if enabling && after_start_type.delayed != Some(delayed) {
        let delay = SERVICE_DELAYED_AUTO_START_INFO {
            fDelayedAutostart: (delayed != 0).into(),
        };
        if let Err(error) = unsafe {
            ChangeServiceConfig2W(
                service.0,
                SERVICE_CONFIG_DELAYED_AUTO_START_INFO,
                Some((&delay as *const SERVICE_DELAYED_AUTO_START_INFO).cast()),
            )
        } {
            // A failed delay restore must not leave an apparently successful enable.
            // Return to disabled so the retained backup can be retried. Even a
            // verified rollback remains a possible mutation for Core reconciliation.
            let rollback_verified = set_start_type(service.0, SERVICE_DISABLED).is_ok()
                && query_service_config(service.0, name)
                    .is_ok_and(|value| value.start_type == SERVICE_DISABLED);
            let failure = native_error("restore_delay", error);
            let rollback = if rollback_verified {
                "verified"
            } else {
                "unverified"
            };
            return Err(PlatformError::new(
                failure.code(),
                format!("{} rollback={rollback}", failure.diagnostic()),
            )
            .with_possible_side_effects());
        }
    }
    let verified = query_service_config(service.0, name).map_err(|_| {
        PlatformError::operation_failed("service_change stage=verify_read")
            .with_possible_side_effects()
    })?;
    if verified.start_type != start_type || (enabling && verified.delayed != Some(delayed)) {
        return Err(
            PlatformError::operation_failed("service_change stage=verify_mismatch")
                .with_possible_side_effects(),
        );
    }
    if enabling {
        // A leftover backup cannot undo a verified configuration. A later disable
        // overwrites it, so cleanup failure must not falsely report the switch failed.
        if let Err(error) = key.delete_value(RESTORE_VALUE) {
            if error.kind() != ErrorKind::NotFound {
                log::warn!(
                    "service_change stage=cleanup_backup os_error={:?}",
                    error.raw_os_error()
                );
            }
        }
    }
    Ok(PlatformStartupChangeResult {
        previous_state: current.configured_state,
        configured_state: desired,
        verified: true,
    })
}

fn set_start_type(service: SC_HANDLE, start_type: SERVICE_START_TYPE) -> windows_core::Result<()> {
    unsafe {
        ChangeServiceConfigW(
            service,
            ENUM_SERVICE_TYPE(SERVICE_NO_CHANGE),
            start_type,
            SERVICE_ERROR(SERVICE_NO_CHANGE),
            PCWSTR::null(),
            PCWSTR::null(),
            None,
            PCWSTR::null(),
            PCWSTR::null(),
            PCWSTR::null(),
            PCWSTR::null(),
        )
    }
}

fn restore_delay(value: &str, binary_digest: &str, default: u32) -> PlatformResult<u32> {
    let backup: RestoreConfig = if value.len() <= 1024 {
        serde_json::from_str(value).ok()
    } else {
        None
    }
    .ok_or_else(|| {
        PlatformError::new(
            PlatformErrorCode::InvalidData,
            "service_change stage=invalid_backup",
        )
    })?;
    if backup.schema_version != 1 || backup.delayed > 1 {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "service_change stage=backup_version",
        ));
    }
    // An application update may replace the binary while disabled. Enabling still
    // means automatic startup, but must not replay another installation's delay.
    Ok(if backup.binary_digest == binary_digest {
        backup.delayed
    } else {
        default
    })
}

fn native_error(stage: &'static str, error: windows_core::Error) -> PlatformError {
    let code = match error.code().0 as u32 {
        0x8007_0005 => PlatformErrorCode::AccessDenied,
        0x8007_0424 | 0x8007_0430 => PlatformErrorCode::ItemChanged,
        _ => PlatformErrorCode::OperationFailed,
    };
    PlatformError::new(
        code,
        format!(
            "service_change stage={stage} hresult={:08x}",
            error.code().0 as u32
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_records_reject_corruption_and_preserve_delay() {
        let value = serde_json::to_string(&RestoreConfig {
            schema_version: 1,
            binary_digest: "fixture".into(),
            delayed: 1,
        })
        .unwrap();
        assert_eq!(restore_delay(&value, "fixture", 0).unwrap(), 1);
        assert_eq!(restore_delay(&value, "updated", 0).unwrap(), 0);
        for invalid in [
            "{}",
            "garbage",
            "{\"schema_version\":2,\"binary_digest\":\"fixture\",\"delayed\":1}",
        ] {
            assert!(restore_delay(invalid, "fixture", 0).is_err());
        }
    }

    #[test]
    fn service_identity_rejects_forged_or_malformed_ids() {
        let request = |source_id: &str, provider_item_id: &str| PlatformStartupChangeRequest {
            source_id: source_id.to_owned(),
            provider_item_id: provider_item_id.to_owned(),
            expected_artifact: crate::startup::platform::PlatformStartupArtifact {
                provider_item_id: provider_item_id.to_owned(),
                source_kind: crate::startup::platform::PlatformStartupSourceKind::Service,
                scope: crate::startup::platform::PlatformStartupScope::Machine,
                triggers: Vec::new(),
                display_name: String::new(),
                configuration_path: None,
                target: crate::startup::platform::PlatformStartupTarget {
                    kind: crate::startup::platform::PlatformStartupTargetKind::Service,
                    identity_key: String::new(),
                    path: None,
                    executable_name: None,
                    arguments: Vec::new(),
                },
                owner: crate::startup::platform::PlatformStartupOwner {
                    identity_key: None,
                    name: None,
                    publisher: None,
                    summary: None,
                    summary_source: crate::startup::platform::PlatformStartupSummarySource::Unavailable,
                    version: None,
                    icon_path: None,
                    confidence: crate::startup::platform::PlatformStartupIdentityConfidence::Unresolved,
                },
                configured_state: PlatformStartupConfiguredState::Unknown,
                runtime_state: crate::startup::platform::PlatformStartupRuntimeState::Unknown,
                control_capability: PlatformStartupControlCapability::ViewOnly,
                trust: crate::startup::platform::PlatformStartupTrustState::Unknown,
                modified_at_ms: None,
                diagnostics: Vec::new(),
            },
            desired_state: PlatformStartupDesiredState::Disabled,
        };

        assert_eq!(
            service_name(&request("windows.services", "service:Spooler"))
                .expect("a plain service name must be accepted"),
            "Spooler"
        );
        for (source_id, provider_item_id) in [
            ("windows.registry.run", "service:Spooler"),
            ("windows.services", "Spooler"),
            ("windows.services", "service:"),
            ("windows.services", r"service:..\evil"),
            ("windows.services", "service:bad/name"),
        ] {
            assert_eq!(
                service_name(&request(source_id, provider_item_id))
                    .expect_err("a forged identity must be rejected")
                    .code(),
                PlatformErrorCode::InvalidPath
            );
        }
    }
}
