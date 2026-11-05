//! Windows implementation of the system-settings platform contract.
//!
//! Every identifier is resolved through the compiled-in catalog, so this module
//! never accepts a registry path, value name or command from the caller. Writes
//! are verified by re-reading the native value. Settings that need administrator
//! access are routed through one elevated helper batch so a single UAC prompt
//! covers the whole action.
//!
//! `WM_SETTINGCHANGE` is intentionally not broadcast: the port's `windows` crate
//! feature set does not include `Win32_UI_WindowsAndMessaging`, so the adapter
//! writes the registry and reports `requires_restart` through the catalog.

use std::{collections::BTreeMap, io};

use winreg::{enums::*, RegKey, RegValue};

use crate::{
    platform::{
        contracts::{
            PlatformError, PlatformErrorCode, PlatformMutationState, PlatformResult,
            PlatformSystemSettingDiagnosticCode,
        },
        system_settings_helper::change_many_with_privileges,
    },
    system_settings::{
        catalog::{
            self, BuildApplicability, NativeContract, RegistryRoot, RegistryValueKind,
            SettingDefinition,
        },
        platform::{
            preflight_system_setting_change, PlatformSystemSettingChangeRequest,
            PlatformSystemSettingChangeResult, PlatformSystemSettingSnapshot,
            PlatformSystemSettingState, PlatformSystemSettingValue, SystemSettingsCancellation,
            SystemSettingsPlatform,
        },
    },
};

/// Durable recovery accepts at most 1 KiB of UTF-8 per text value. Native
/// baselines larger than this are rejected before any write can make them
/// unrecoverable.
const SHORTCUT_NAME_MAX_TEXT_BYTES: usize = 1_024;
const TRAY_CHEVRON_SNAPSHOT_KEY: &str = "chevron";
const TRAY_ICON_SNAPSHOT_PREFIX: &str = "icon:";
const TRAY_NOTIFY_AREA_SUBKEY: &str = r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\TrayNotify";
const TRAY_ICON_SETTINGS_SUBKEY: &str = r"Control Panel\NotifyIconSettings";
const WINDOWS_VERSION_SUBKEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

struct WindowsSystemSettings;

static WINDOWS_SYSTEM_SETTINGS: WindowsSystemSettings = WindowsSystemSettings;

pub(crate) fn platform() -> &'static dyn SystemSettingsPlatform {
    &WINDOWS_SYSTEM_SETTINGS
}

impl SystemSettingsPlatform for WindowsSystemSettings {
    fn scan_system_settings(
        &self,
        setting_ids: &[&str],
        cancellation: &SystemSettingsCancellation,
    ) -> PlatformResult<Vec<PlatformSystemSettingState>> {
        scan(setting_ids, cancellation)
    }

    fn change_system_setting(
        &self,
        request: &PlatformSystemSettingChangeRequest,
    ) -> PlatformResult<PlatformSystemSettingChangeResult> {
        change(request)
    }

    fn change_system_settings(
        &self,
        requests: &[PlatformSystemSettingChangeRequest],
    ) -> PlatformResult<Vec<PlatformResult<PlatformSystemSettingChangeResult>>> {
        change_many(requests)
    }
}

fn scan(
    setting_ids: &[&str],
    cancellation: &SystemSettingsCancellation,
) -> PlatformResult<Vec<PlatformSystemSettingState>> {
    let windows_build = current_windows_build();
    let mut states = Vec::with_capacity(setting_ids.len());
    for setting_id in setting_ids {
        if cancellation.is_cancelled() {
            // Core owns the public cancellation protocol. Returning the partial
            // read lets it convert the shared flag into the stable cancelled
            // error instead of reporting an incomplete catalog as complete.
            break;
        }
        let Some(definition) = catalog::definition(setting_id) else {
            states.push(unsupported_state(setting_id, false));
            continue;
        };
        if definition.native.contract == NativeContract::Unavailable
            || !is_applicable(definition, windows_build)
        {
            states.push(unsupported_state(setting_id, definition.requires_elevation));
            continue;
        }
        match native_key_available(definition) {
            Ok(true) => states.push(read_state(definition)),
            Ok(false) => {
                states.push(unsupported_state(setting_id, definition.requires_elevation));
            }
            Err(error) => states.push(error_state(definition, error)),
        }
    }
    Ok(states)
}

fn change(
    request: &PlatformSystemSettingChangeRequest,
) -> PlatformResult<PlatformSystemSettingChangeResult> {
    let definition = catalog::definition(&request.setting_id).ok_or_else(|| {
        PlatformError::new(
            PlatformErrorCode::Unsupported,
            "system setting identifier is unsupported",
        )
    })?;
    if definition.native.contract == NativeContract::Unavailable {
        return Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "system setting is not implemented on this platform",
        ));
    }
    if !is_applicable(definition, current_windows_build()) {
        return Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "system setting is unavailable on this Windows version",
        ));
    }
    if !native_key_available(definition)? {
        return Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "system setting component is not installed",
        ));
    }
    validate_value(definition, &request.desired_value)?;

    let before = read_value(definition)?;
    // Composite and per-icon settings expose an `effective_value` that differs
    // from their raw snapshot, so semantic idempotence must be checked before
    // the raw optimistic-concurrency comparison.
    if value_matches_desired(definition, &before, &request.desired_value) {
        return Ok(PlatformSystemSettingChangeResult {
            value: before,
            changed: false,
            verified: true,
        });
    }
    if let Some(result) = preflight_system_setting_change(&before, request)? {
        return Ok(result);
    }

    write_value(definition, &request.desired_value)
        .map_err(PlatformError::with_possible_side_effects)?;
    let after = read_value(definition).map_err(PlatformError::with_possible_side_effects)?;
    Ok(PlatformSystemSettingChangeResult {
        changed: after != before,
        verified: value_matches_desired(definition, &after, &request.desired_value),
        value: after,
    })
}

fn change_many(
    requests: &[PlatformSystemSettingChangeRequest],
) -> PlatformResult<Vec<PlatformResult<PlatformSystemSettingChangeResult>>> {
    let mut results = std::iter::repeat_with(|| None)
        .take(requests.len())
        .collect::<Vec<_>>();
    let mut direct_indexes = Vec::new();
    let mut privileged_indexes = Vec::new();
    let mut privileged_requests = Vec::new();

    for (index, request) in requests.iter().enumerate() {
        // Unavailable entries stay on the direct path so a degraded setting can
        // never trigger a UAC prompt that inevitably fails.
        let requires_helper = catalog::definition(&request.setting_id).is_some_and(|definition| {
            definition.requires_elevation
                && definition.native.contract != NativeContract::Unavailable
        });
        if requires_helper {
            privileged_indexes.push(index);
            privileged_requests.push(request);
        } else {
            direct_indexes.push(index);
        }
    }

    if !privileged_requests.is_empty() {
        match change_many_with_privileges(&privileged_requests) {
            Ok(privileged_results) if privileged_results.len() == privileged_indexes.len() => {
                // The elevated response is advisory until the ordinary process
                // re-reads every value. This closes the response-file race and
                // prevents a forged or truncated response from discarding
                // recovery for a setting that did not reach its target.
                let verified_results = privileged_requests
                    .iter()
                    .zip(privileged_results)
                    .map(|(request, result)| verify_privileged_change_result(request, result))
                    .collect::<Vec<_>>();
                let uncertain_mutation_count = verified_results
                    .iter()
                    .filter(|result| {
                        result.as_ref().is_err_and(|error| {
                            error.mutation_state() == PlatformMutationState::MayHaveChanged
                        })
                    })
                    .count();
                log::info!(
                    "windows_system_settings_elevated_batch_finished item_count={} uncertain_mutation_count={}",
                    verified_results.len(),
                    uncertain_mutation_count
                );
                for (index, result) in privileged_indexes.into_iter().zip(verified_results) {
                    results[index] = Some(result);
                }
            }
            Ok(_) => {
                for index in privileged_indexes {
                    results[index] = Some(Err(PlatformError::new(
                        PlatformErrorCode::InvalidData,
                        "system settings helper returned an invalid result count",
                    )
                    .with_possible_side_effects()));
                }
            }
            Err(error) => {
                let code = error.code();
                let mutation_state = error.mutation_state();
                log::warn!(
                    "windows_system_settings_elevated_batch_failed item_count={} code={code:?} mutation_state={mutation_state:?}",
                    privileged_indexes.len(),
                );
                if code == PlatformErrorCode::UserCancelled {
                    // The UAC prompt is the authorization boundary for the whole
                    // user action. Cancelling it must leave every setting
                    // untouched instead of producing a partial batch.
                    return Ok(requests
                        .iter()
                        .map(|_| {
                            Err(PlatformError::new(
                                PlatformErrorCode::UserCancelled,
                                "system settings authorization was cancelled",
                            ))
                        })
                        .collect());
                }
                for index in privileged_indexes {
                    let item_error =
                        PlatformError::new(code, "system settings privileged batch failed");
                    results[index] = Some(Err(
                        if mutation_state == PlatformMutationState::MayHaveChanged {
                            item_error.with_possible_side_effects()
                        } else {
                            item_error
                        },
                    ));
                }
            }
        }
    }

    // Current-user writes are deliberately delayed until any required UAC prompt
    // succeeds or fails normally, which preserves whole-batch cancellation.
    for index in direct_indexes {
        results[index] = Some(change(&requests[index]));
    }

    results
        .into_iter()
        .map(|result| {
            result.ok_or_else(|| {
                PlatformError::new(
                    PlatformErrorCode::InvalidData,
                    "system settings batch result is missing",
                )
            })
        })
        .collect()
}

fn verify_privileged_change_result(
    request: &PlatformSystemSettingChangeRequest,
    reported: PlatformResult<PlatformSystemSettingChangeResult>,
) -> PlatformResult<PlatformSystemSettingChangeResult> {
    let definition = catalog::definition(&request.setting_id).ok_or_else(|| {
        PlatformError::new(
            PlatformErrorCode::Unsupported,
            "system setting identifier is unsupported during post-elevation verification",
        )
    })?;
    let current = read_value(definition).map_err(PlatformError::with_possible_side_effects)?;
    if value_matches_desired(definition, &current, &request.desired_value) {
        return Ok(PlatformSystemSettingChangeResult {
            changed: current != request.expected_value,
            verified: true,
            value: current,
        });
    }
    match reported {
        Err(error) => Err(error),
        Ok(_) => Err(PlatformError::operation_failed(
            "elevated system setting did not match the desired value during parent verification",
        )
        .with_possible_side_effects()),
    }
}

/// Applies one batch inside the elevated helper process.
///
/// Only identifiers in the compiled catalog that require administrator access
/// are accepted; the helper never receives a registry path or command.
pub(crate) fn helper_change_many(
    requests: &[PlatformSystemSettingChangeRequest],
) -> Vec<PlatformResult<PlatformSystemSettingChangeResult>> {
    requests
        .iter()
        .map(|request| {
            let definition = catalog::definition(&request.setting_id).ok_or_else(|| {
                PlatformError::new(
                    PlatformErrorCode::Unsupported,
                    "system setting identifier is unsupported by the elevated helper",
                )
            })?;
            if !definition.requires_elevation {
                return Err(PlatformError::new(
                    PlatformErrorCode::Unsupported,
                    "system setting does not require the elevated helper",
                ));
            }
            if definition.native.contract == NativeContract::Unavailable {
                return Err(PlatformError::new(
                    PlatformErrorCode::Unsupported,
                    "system setting is not implemented on this platform",
                ));
            }
            change(request)
        })
        .collect()
}

fn unsupported_state(setting_id: &str, requires_elevation: bool) -> PlatformSystemSettingState {
    PlatformSystemSettingState {
        setting_id: setting_id.to_owned(),
        value: PlatformSystemSettingValue::Missing,
        effective_value: PlatformSystemSettingValue::Missing,
        requires_elevation,
        diagnostic: Some(PlatformSystemSettingDiagnosticCode::Unsupported),
    }
}

fn error_state(
    definition: &SettingDefinition,
    error: PlatformError,
) -> PlatformSystemSettingState {
    log::warn!(
        "windows_system_setting_availability_failed setting_id={} code={:?}",
        definition.setting_id,
        error.code()
    );
    PlatformSystemSettingState {
        setting_id: definition.setting_id.to_owned(),
        value: PlatformSystemSettingValue::Missing,
        effective_value: PlatformSystemSettingValue::Missing,
        requires_elevation: definition.requires_elevation,
        diagnostic: Some(diagnostic_for_error(error.code())),
    }
}

fn read_state(definition: &SettingDefinition) -> PlatformSystemSettingState {
    match read_value(definition) {
        Ok(value) => {
            let effective_value = effective_value(definition, &value);
            PlatformSystemSettingState {
                setting_id: definition.setting_id.to_owned(),
                value,
                effective_value,
                requires_elevation: definition.requires_elevation,
                diagnostic: None,
            }
        }
        Err(error) => {
            log::warn!(
                "windows_system_setting_read_failed setting_id={} code={:?}",
                definition.setting_id,
                error.code()
            );
            PlatformSystemSettingState {
                setting_id: definition.setting_id.to_owned(),
                value: PlatformSystemSettingValue::Missing,
                effective_value: PlatformSystemSettingValue::Missing,
                requires_elevation: definition.requires_elevation,
                diagnostic: Some(diagnostic_for_error(error.code())),
            }
        }
    }
}

fn diagnostic_for_error(code: PlatformErrorCode) -> PlatformSystemSettingDiagnosticCode {
    match code {
        PlatformErrorCode::AccessDenied => PlatformSystemSettingDiagnosticCode::AccessDenied,
        PlatformErrorCode::Unsupported => PlatformSystemSettingDiagnosticCode::Unsupported,
        _ => PlatformSystemSettingDiagnosticCode::StateUnavailable,
    }
}

/// Reports whether an optional native component is present.
///
/// Service availability varies by Windows edition and installed components.
/// Creating a missing `Services` key would make verification pass even though
/// no service exists, so optional definitions fail closed and stay hidden on
/// machines where the component is absent.
fn native_key_available(definition: &SettingDefinition) -> PlatformResult<bool> {
    if !definition.native.requires_existing_key {
        return Ok(true);
    }
    match registry_root(definition.native.root)
        .open_subkey_with_flags(definition.native.subkey, KEY_READ)
    {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(registry_error("check system setting component", error)),
    }
}

fn is_applicable(definition: &SettingDefinition, windows_build: Option<u32>) -> bool {
    match definition.native.applicability {
        BuildApplicability::Any => true,
        // Version-scoped registry contracts fail closed when the build cannot be
        // read: writing a policy for the wrong generation can report success
        // without changing the user interface.
        BuildApplicability::Before(exclusive_build) => {
            windows_build.is_some_and(|build| build < exclusive_build)
        }
        BuildApplicability::AtLeast(inclusive_build) => {
            windows_build.is_some_and(|build| build >= inclusive_build)
        }
        BuildApplicability::Range {
            inclusive_start,
            exclusive_end,
        } => windows_build.is_some_and(|build| (inclusive_start..exclusive_end).contains(&build)),
    }
}

fn current_windows_build() -> Option<u32> {
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(WINDOWS_VERSION_SUBKEY, KEY_READ | KEY_WOW64_64KEY)
        .ok()?;
    key.get_value::<String, _>("CurrentBuildNumber")
        .ok()?
        .parse()
        .ok()
}

fn read_value(
    definition: &SettingDefinition,
) -> PlatformResult<PlatformSystemSettingValue> {
    match definition.native.contract {
        NativeContract::Unavailable => Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "system setting is not implemented on this platform",
        )),
        NativeContract::ShortcutNameTemplate => read_shortcut_name_template(definition),
        NativeContract::Windows11TrayIcons if uses_windows_11_tray_contract(definition) => {
            read_windows_11_tray_icons()
        }
        NativeContract::Registry | NativeContract::Windows11TrayIcons => {
            read_registry_value(definition)
        }
    }
}

fn read_registry_value(
    definition: &SettingDefinition,
) -> PlatformResult<PlatformSystemSettingValue> {
    let key = match registry_root(definition.native.root)
        .open_subkey_with_flags(definition.native.subkey, KEY_READ)
    {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(PlatformSystemSettingValue::Missing)
        }
        Err(error) => return Err(registry_error("read system setting key", error)),
    };
    match definition.native.kind {
        RegistryValueKind::Dword => match key.get_value::<u32, _>(definition.native.value_name) {
            Ok(value) => Ok(PlatformSystemSettingValue::Integer(i64::from(value))),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                Ok(PlatformSystemSettingValue::Missing)
            }
            Err(error) => Err(registry_error("read system setting value", error)),
        },
        RegistryValueKind::Text => {
            match key.get_value::<String, _>(definition.native.value_name) {
                Ok(value) if definition.native.composite_text_key.is_some() => {
                    Ok(PlatformSystemSettingValue::Snapshot(
                        PlatformSystemSettingSnapshot::Text(value),
                    ))
                }
                Ok(value) => Ok(PlatformSystemSettingValue::Text(value)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    Ok(PlatformSystemSettingValue::Missing)
                }
                Err(error) => Err(registry_error("read system setting value", error)),
            }
        }
    }
}

fn write_value(
    definition: &SettingDefinition,
    value: &PlatformSystemSettingValue,
) -> PlatformResult<()> {
    match definition.native.contract {
        NativeContract::Unavailable => {
            return Err(PlatformError::new(
                PlatformErrorCode::Unsupported,
                "system setting is not implemented on this platform",
            ))
        }
        NativeContract::ShortcutNameTemplate => {
            return write_shortcut_name_template(definition, value)
        }
        NativeContract::Windows11TrayIcons if uses_windows_11_tray_contract(definition) => {
            return write_windows_11_tray_icons(value)
        }
        NativeContract::Registry | NativeContract::Windows11TrayIcons => {}
    }
    write_registry_value(definition, value)
}

fn write_registry_value(
    definition: &SettingDefinition,
    value: &PlatformSystemSettingValue,
) -> PlatformResult<()> {
    let root = registry_root(definition.native.root);
    if matches!(value, PlatformSystemSettingValue::Missing) {
        if let Some(tree_subkey) = definition.native.delete_tree_subkey {
            let result = match root.delete_subkey_all(tree_subkey) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(registry_error("delete system setting registry tree", error)),
            };
            if result.is_ok() {
                log::info!(
                    "windows_system_setting_tree_removed setting_id={}",
                    definition.setting_id
                );
            }
            return result;
        }
    }
    let (key, _) = root
        .create_subkey_with_flags(
            definition.native.subkey,
            if definition.native.composite_text_key.is_some() {
                KEY_READ | KEY_SET_VALUE
            } else {
                KEY_SET_VALUE
            },
        )
        .map_err(|error| registry_error("open system setting key for writing", error))?;
    let result = match value {
        PlatformSystemSettingValue::Missing => match key.delete_value(definition.native.value_name)
        {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(registry_error("delete system setting value", error)),
        },
        PlatformSystemSettingValue::Integer(value) => {
            let value = u32::try_from(*value).map_err(|_| {
                PlatformError::operation_failed("system setting integer is outside DWORD range")
            })?;
            key.set_value(definition.native.value_name, &value)
                .map_err(|error| registry_error("write system setting value", error))
        }
        PlatformSystemSettingValue::Text(value)
            if definition.native.composite_text_key.is_some() =>
        {
            let existing = match key.get_value::<String, _>(definition.native.value_name) {
                Ok(existing) => existing,
                Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
                Err(error) => {
                    return Err(registry_error(
                        "read composite system setting before writing",
                        error,
                    ))
                }
            };
            let composite_key = definition.native.composite_text_key.unwrap_or_default();
            let merged = update_composite_text(&existing, composite_key, value)?;
            let result = key
                .set_value(definition.native.value_name, &merged)
                .map_err(|error| registry_error("write composite system setting value", error));
            if result.is_ok() {
                log::info!(
                    "windows_composite_system_setting_changed setting_id={} retained_entry_count={}",
                    definition.setting_id,
                    merged.split(';').filter(|entry| !entry.is_empty()).count()
                );
            }
            result
        }
        PlatformSystemSettingValue::Text(value) => key
            .set_value(definition.native.value_name, value)
            .map_err(|error| registry_error("write system setting value", error)),
        PlatformSystemSettingValue::Snapshot(PlatformSystemSettingSnapshot::Text(value))
            if definition.native.composite_text_key.is_some() =>
        {
            let result = key
                .set_value(definition.native.value_name, value)
                .map_err(|error| registry_error("restore composite system setting value", error));
            if result.is_ok() {
                log::info!(
                    "windows_composite_system_setting_restored setting_id={} restored_entry_count={}",
                    definition.setting_id,
                    value.split(';').filter(|entry| !entry.is_empty()).count()
                );
            }
            result
        }
        PlatformSystemSettingValue::Boolean(_) | PlatformSystemSettingValue::Snapshot(_) => Err(
            PlatformError::operation_failed("boolean value is invalid for this system setting"),
        ),
    };
    result
}

fn effective_value(
    definition: &SettingDefinition,
    value: &PlatformSystemSettingValue,
) -> PlatformSystemSettingValue {
    if uses_windows_11_tray_contract(definition) {
        return windows_11_tray_effective_value(value);
    }
    let Some(composite_key) = definition.native.composite_text_key else {
        return value.clone();
    };
    let PlatformSystemSettingValue::Snapshot(PlatformSystemSettingSnapshot::Text(snapshot)) = value
    else {
        return value.clone();
    };
    composite_entry(snapshot, composite_key)
        .map(|entry| PlatformSystemSettingValue::Text(format!("{composite_key}={entry};")))
        .unwrap_or_else(|| PlatformSystemSettingValue::Text(String::new()))
}

fn value_matches_desired(
    definition: &SettingDefinition,
    current: &PlatformSystemSettingValue,
    desired: &PlatformSystemSettingValue,
) -> bool {
    match desired {
        // A snapshot is an exact native baseline used for restore; comparing the
        // derived scalar would hide a partially restored native value.
        PlatformSystemSettingValue::Snapshot(_) => current == desired,
        _ => effective_value(definition, current) == *desired,
    }
}

fn composite_entry<'a>(value: &'a str, key: &str) -> Option<&'a str> {
    value.split(';').find_map(|entry| {
        let (entry_key, entry_value) = entry.split_once('=')?;
        entry_key.eq_ignore_ascii_case(key).then_some(entry_value)
    })
}

/// Updates one field inside Windows' semicolon-delimited DirectX value while
/// preserving sibling fields such as VRR and Auto HDR. An empty desired value
/// removes only the owned field.
fn update_composite_text(existing: &str, key: &str, desired: &str) -> PlatformResult<String> {
    let desired_value = composite_entry(desired, key);
    let mut entries = existing
        .split(';')
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let is_owned = entry
                .split_once('=')
                .is_some_and(|(entry_key, _)| entry_key.eq_ignore_ascii_case(key));
            (!is_owned).then(|| entry.to_string())
        })
        .collect::<Vec<_>>();
    if let Some(desired_value) = desired_value {
        entries.push(format!("{key}={desired_value}"));
    } else if !desired.is_empty() {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "composite system setting does not contain the owned field",
        ));
    }
    Ok(entries
        .into_iter()
        .map(|entry| format!("{entry};"))
        .collect())
}

fn uses_windows_11_tray_contract(definition: &SettingDefinition) -> bool {
    definition.native.contract == NativeContract::Windows11TrayIcons
        && current_windows_build().is_some_and(|build| build >= 22_000)
}

/// Reads the Windows 11 per-application tray visibility contract.
///
/// Windows 10 exposes one `EnableAutoTray` switch. Windows 11 keeps an
/// `IsPromoted` value for every known notification icon instead, so continuing
/// to read the legacy value reports success without reflecting what the taskbar
/// actually renders. The product switch is considered on only when every known
/// icon is promoted; a mixed user configuration remains off until the user
/// explicitly chooses to show all icons.
fn read_windows_11_tray_icons() -> PlatformResult<PlatformSystemSettingValue> {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let mut snapshot = BTreeMap::new();
    snapshot.insert(
        TRAY_CHEVRON_SNAPSHOT_KEY.to_owned(),
        read_windows_11_tray_chevron_raw()?,
    );
    let settings = match root.open_subkey_with_flags(TRAY_ICON_SETTINGS_SUBKEY, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(PlatformSystemSettingValue::Snapshot(
                PlatformSystemSettingSnapshot::IntegerMap(snapshot),
            ))
        }
        Err(error) => return Err(registry_error("read notification icon settings", error)),
    };

    for subkey_name in settings.enum_keys() {
        let subkey_name = subkey_name
            .map_err(|error| registry_error("enumerate notification icon settings", error))?;
        let subkey = settings
            .open_subkey_with_flags(&subkey_name, KEY_READ)
            .map_err(|error| registry_error("read notification icon setting", error))?;
        let value = match subkey.get_value::<u32, _>("IsPromoted") {
            Ok(value) => Some(i64::from(value)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(registry_error("read notification icon value", error)),
        };
        snapshot.insert(format!("{TRAY_ICON_SNAPSHOT_PREFIX}{subkey_name}"), value);
    }
    Ok(PlatformSystemSettingValue::Snapshot(
        PlatformSystemSettingSnapshot::IntegerMap(snapshot),
    ))
}

fn read_windows_11_tray_chevron_raw() -> PlatformResult<Option<i64>> {
    let key = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(TRAY_NOTIFY_AREA_SUBKEY, KEY_READ)
    {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(registry_error("read notification area state", error)),
    };
    match key.get_value::<u32, _>("SystemTrayChevronVisibility") {
        Ok(value) => Ok(Some(i64::from(value))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(registry_error("read notification area value", error)),
    }
}

fn windows_11_tray_effective_value(
    value: &PlatformSystemSettingValue,
) -> PlatformSystemSettingValue {
    let PlatformSystemSettingValue::Snapshot(PlatformSystemSettingSnapshot::IntegerMap(snapshot)) =
        value
    else {
        return value.clone();
    };
    let mut known_count = 0_usize;
    let mut every_icon_promoted = true;
    for (_, value) in snapshot
        .iter()
        .filter(|(key, _)| key.starts_with(TRAY_ICON_SNAPSHOT_PREFIX))
    {
        known_count += 1;
        every_icon_promoted &= *value == Some(1);
    }
    let show_all = if known_count == 0 {
        snapshot.get(TRAY_CHEVRON_SNAPSHOT_KEY).copied().flatten() == Some(0)
    } else {
        every_icon_promoted
    };
    PlatformSystemSettingValue::Integer(i64::from(!show_all))
}

/// Applies the Windows 11 tray choice to the chevron and every icon Windows
/// currently knows.
///
/// The per-icon registry layout is dynamic: applications create their own
/// opaque subkeys. The adapter therefore enumerates existing entries instead of
/// persisting application identifiers or guessing paths. Newly installed
/// applications continue to follow Windows defaults until the user applies this
/// switch again.
fn write_windows_11_tray_icons(value: &PlatformSystemSettingValue) -> PlatformResult<()> {
    if let PlatformSystemSettingValue::Snapshot(PlatformSystemSettingSnapshot::IntegerMap(
        snapshot,
    )) = value
    {
        return restore_windows_11_tray_icons(snapshot);
    }
    let show_all = match value {
        PlatformSystemSettingValue::Integer(0) => true,
        PlatformSystemSettingValue::Integer(1) => false,
        _ => {
            return Err(PlatformError::operation_failed(
                "notification icon setting requires a zero or one value",
            ))
        }
    };
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let (chevron, _) = root
        .create_subkey_with_flags(TRAY_NOTIFY_AREA_SUBKEY, KEY_SET_VALUE)
        .map_err(|error| registry_error("open notification area state for writing", error))?;
    chevron
        .set_value("SystemTrayChevronVisibility", &u32::from(!show_all))
        .map_err(|error| registry_error("write notification area state", error))?;

    let settings = match root.open_subkey_with_flags(TRAY_ICON_SETTINGS_SUBKEY, KEY_READ | KEY_SET_VALUE)
    {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            log::info!("windows_tray_visibility_changed show_all={show_all} known_icon_count=0");
            return Ok(());
        }
        Err(error) => return Err(registry_error("open notification icon settings", error)),
    };

    let mut changed_count = 0_u32;
    for subkey_name in settings.enum_keys() {
        let subkey_name = subkey_name
            .map_err(|error| registry_error("enumerate notification icon settings", error))?;
        let subkey = settings
            .open_subkey_with_flags(&subkey_name, KEY_SET_VALUE)
            .map_err(|error| registry_error("open notification icon setting for writing", error))?;
        subkey
            .set_value("IsPromoted", &u32::from(show_all))
            .map_err(|error| registry_error("write notification icon setting", error))?;
        changed_count += 1;
    }
    log::info!(
        "windows_tray_visibility_changed show_all={show_all} known_icon_count={changed_count}"
    );
    Ok(())
}

fn restore_windows_11_tray_icons(snapshot: &BTreeMap<String, Option<i64>>) -> PlatformResult<()> {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let (chevron, _) = root
        .create_subkey_with_flags(TRAY_NOTIFY_AREA_SUBKEY, KEY_SET_VALUE)
        .map_err(|error| registry_error("open notification area state for restoration", error))?;
    match snapshot.get(TRAY_CHEVRON_SNAPSHOT_KEY).copied().flatten() {
        Some(value) => chevron
            .set_value("SystemTrayChevronVisibility", &(value as u32))
            .map_err(|error| registry_error("restore notification area state", error))?,
        None => match chevron.delete_value("SystemTrayChevronVisibility") {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(registry_error("clear notification area state", error)),
        },
    }

    let expected_icon_count = snapshot
        .keys()
        .filter(|key| key.starts_with(TRAY_ICON_SNAPSHOT_PREFIX))
        .count();
    let settings = match root.open_subkey_with_flags(TRAY_ICON_SETTINGS_SUBKEY, KEY_READ | KEY_SET_VALUE)
    {
        Ok(settings) => settings,
        Err(error) if error.kind() == io::ErrorKind::NotFound && expected_icon_count == 0 => {
            log::info!("windows_tray_visibility_restored restored_icon_count=0 missing_icon_count=0");
            return Ok(());
        }
        Err(error) => {
            return Err(registry_error(
                "open notification icons for restoration",
                error,
            ))
        }
    };
    let mut restored_count = 0_u32;
    let mut missing_count = 0_u32;
    for (key, value) in snapshot
        .iter()
        .filter(|(key, _)| key.starts_with(TRAY_ICON_SNAPSHOT_PREFIX))
    {
        let subkey_name = &key[TRAY_ICON_SNAPSHOT_PREFIX.len()..];
        let subkey = match settings.open_subkey_with_flags(subkey_name, KEY_SET_VALUE) {
            Ok(subkey) => subkey,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing_count += 1;
                continue;
            }
            Err(error) => {
                return Err(registry_error(
                    "open notification icon for restoration",
                    error,
                ))
            }
        };
        match value {
            Some(value) => subkey
                .set_value("IsPromoted", &(*value as u32))
                .map_err(|error| registry_error("restore notification icon state", error))?,
            None => match subkey.delete_value("IsPromoted") {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(registry_error("clear notification icon state", error)),
            },
        }
        restored_count += 1;
    }
    log::info!(
        "windows_tray_visibility_restored restored_icon_count={restored_count} missing_icon_count={missing_count}"
    );
    Ok(())
}

fn shortcut_name_path(definition: &SettingDefinition) -> &'static str {
    definition.native.subkey
}

fn valid_shortcut_name_value(value: &PlatformSystemSettingValue) -> bool {
    match value {
        PlatformSystemSettingValue::Missing => true,
        PlatformSystemSettingValue::Text(text) => {
            !text.contains('\0') && text.len() <= SHORTCUT_NAME_MAX_TEXT_BYTES
        }
        _ => false,
    }
}

/// Decodes the shortcut naming template losslessly.
///
/// REG_EXPAND_SZ, malformed UTF-16 and embedded NULs are rejected instead of
/// being coerced into a plausible string: the durable recovery record must be
/// able to reproduce the original value.
fn decode_shortcut_name(
    value: RegValue<'_>,
) -> PlatformResult<PlatformSystemSettingValue> {
    if value.vtype != REG_SZ
        || value.bytes.len() < 2
        || value.bytes.len() > (SHORTCUT_NAME_MAX_TEXT_BYTES + 1) * 2
        || value.bytes.len() % 2 != 0
    {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "shortcut name template is not a recoverable REG_SZ",
        ));
    }
    let units = value
        .bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let text = units
        .strip_suffix(&[0u16])
        .and_then(|units| String::from_utf16(units).ok())
        .filter(|text| !text.contains('\0') && text.len() <= SHORTCUT_NAME_MAX_TEXT_BYTES)
        .ok_or_else(|| {
            PlatformError::new(
                PlatformErrorCode::InvalidData,
                "shortcut name template has invalid encoding or exceeds the recovery limit",
            )
        })?;
    Ok(PlatformSystemSettingValue::Text(text))
}

fn read_shortcut_name_template(
    definition: &SettingDefinition,
) -> PlatformResult<PlatformSystemSettingValue> {
    let key = match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(shortcut_name_path(definition), KEY_QUERY_VALUE)
    {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(PlatformSystemSettingValue::Missing)
        }
        Err(error) => return Err(registry_error("access shortcut naming preference", error)),
    };
    match key.get_raw_value(definition.native.value_name) {
        Ok(value) => decode_shortcut_name(value),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(PlatformSystemSettingValue::Missing)
        }
        Err(error) => Err(registry_error("access shortcut naming preference", error)),
    }
}

fn write_shortcut_name_template(
    definition: &SettingDefinition,
    value: &PlatformSystemSettingValue,
) -> PlatformResult<()> {
    if !valid_shortcut_name_value(value) {
        return Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "shortcut name template request is invalid",
        ));
    }
    let root = RegKey::predef(HKEY_CURRENT_USER);
    match value {
        PlatformSystemSettingValue::Text(text) => {
            let (key, _) = root
                .create_subkey_with_flags(shortcut_name_path(definition), KEY_SET_VALUE)
                .map_err(|error| registry_error("access shortcut naming preference", error))?;
            key.set_value(definition.native.value_name, text)
                .map_err(|error| registry_error("access shortcut naming preference", error))?;
        }
        PlatformSystemSettingValue::Missing => {
            let key = match root.open_subkey_with_flags(shortcut_name_path(definition), KEY_SET_VALUE)
            {
                Ok(key) => key,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => {
                    return Err(registry_error("access shortcut naming preference", error))
                }
            };
            match key.delete_value(definition.native.value_name) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(registry_error("access shortcut naming preference", error))
                }
            }
        }
        _ => unreachable!("validated shortcut naming value"),
    }
    // Existing links, CopyNameTemplate, the Explorer `link` value and shortcut
    // file-type registration remain outside this setting's capability boundary.
    log::info!(
        "windows_shortcut_name_written removed={} restart_required=true",
        matches!(value, PlatformSystemSettingValue::Missing)
    );
    Ok(())
}

fn validate_value(
    definition: &SettingDefinition,
    value: &PlatformSystemSettingValue,
) -> PlatformResult<()> {
    if definition.native.contract == NativeContract::ShortcutNameTemplate {
        return if valid_shortcut_name_value(value) {
            Ok(())
        } else {
            Err(PlatformError::new(
                PlatformErrorCode::InvalidData,
                "shortcut name template has an invalid type or encoding",
            ))
        };
    }
    let valid_snapshot = match value {
        PlatformSystemSettingValue::Snapshot(PlatformSystemSettingSnapshot::Text(value)) => {
            definition.native.composite_text_key.is_some() && value.len() <= 16 * 1024
        }
        PlatformSystemSettingValue::Snapshot(PlatformSystemSettingSnapshot::IntegerMap(values)) => {
            uses_windows_11_tray_contract(definition)
                && values.len() <= 512
                && values.iter().all(|(key, value)| {
                    !key.is_empty()
                        && key.len() <= 256
                        && value.is_none_or(|value| (0..=i64::from(u32::MAX)).contains(&value))
                })
        }
        _ => false,
    };
    let valid = valid_snapshot
        || matches!(value, PlatformSystemSettingValue::Missing)
        || matches!(
            (definition.native.kind, value),
            (
                RegistryValueKind::Dword,
                PlatformSystemSettingValue::Integer(_)
            ) | (RegistryValueKind::Text, PlatformSystemSettingValue::Text(_))
        );
    if valid && privileged_value_is_allowlisted(definition, value) {
        Ok(())
    } else {
        Err(PlatformError::operation_failed(
            "system setting value has an invalid type",
        ))
    }
}

/// Restricts the elevated helper to values meaningful for each compiled setting.
///
/// The desktop process normally supplies values from the catalog. This second
/// allowlist exists because the helper can also be launched directly from a
/// command line after a UAC confirmation; accepting an arbitrary DWORD there
/// would make a known setting identifier broader than the product UI.
fn privileged_value_is_allowlisted(
    definition: &SettingDefinition,
    value: &PlatformSystemSettingValue,
) -> bool {
    if !definition.requires_elevation || matches!(value, PlatformSystemSettingValue::Missing) {
        return true;
    }
    match (definition.setting_id, value) {
        (
            "windows.performance.reduce-service-shutdown-timeout",
            PlatformSystemSettingValue::Text(value),
        ) => value
            .parse::<u32>()
            .is_ok_and(|value| (1_000..=600_000).contains(&value)),
        ("windows.performance.reduce-crash-dump", PlatformSystemSettingValue::Integer(value)) => {
            matches!(*value, 0..=3 | 7)
        }
        (
            "windows.performance.disable-network-throttling",
            PlatformSystemSettingValue::Integer(value),
        ) => (0..=70).contains(value) || *value == i64::from(u32::MAX),
        (
            "windows.performance.remove-reserved-bandwidth"
            | "windows.performance.multimedia-responsiveness",
            PlatformSystemSettingValue::Integer(value),
        ) => (0..=100).contains(value),
        (
            "windows.services.print-spooler-manual"
            | "windows.services.disable-sysmain"
            | "windows.services.disable-compatibility-assistant"
            | "windows.services.disable-search-indexing"
            | "windows.services.disable-diagnostic-tracking"
            | "windows.services.disable-error-reporting"
            | "windows.services.disable-sensors"
            | "windows.services.disable-insider"
            | "windows.services.disable-xbox-auth"
            | "windows.services.disable-fax"
            | "windows.services.disable-media-player-sharing",
            PlatformSystemSettingValue::Integer(value),
        ) => (0..=4).contains(value),
        (
            "windows.storage.disable-ntfs-last-access",
            PlatformSystemSettingValue::Integer(value),
        ) => {
            // Windows 10 version 1803 and later uses bit 31 as an initialized
            // marker and bit 1 for system-managed behavior. Recovery must accept
            // those native values so toggling can restore the exact policy mode
            // instead of only its enabled bit.
            matches!(*value, 0..=3 | 0x8000_0000..=0x8000_0003)
        }
        ("windows.update.notify-before-download", PlatformSystemSettingValue::Integer(value)) => {
            (2..=5).contains(value)
        }
        ("windows.update.disable-peer-sharing", PlatformSystemSettingValue::Integer(value)) => {
            matches!(*value, 0..=3 | 99 | 100)
        }
        ("windows.update.disable-preview-builds", PlatformSystemSettingValue::Integer(value)) => {
            (0..=2).contains(value)
        }
        (
            "windows.privacy.limit-diagnostic-data" | "windows.taskbar.hide-search-policy",
            PlatformSystemSettingValue::Integer(value),
        ) => (0..=3).contains(value),
        ("windows.edge.limit-diagnostic-data", PlatformSystemSettingValue::Integer(value)) => {
            (0..=2).contains(value)
        }
        (
            "windows.office.disable-optional-telemetry",
            PlatformSystemSettingValue::Integer(value),
        ) => (1..=3).contains(value),
        ("windows.security.disable-autorun", PlatformSystemSettingValue::Integer(value)) => {
            matches!(*value, 145 | 255)
        }
        ("windows.explorer.remove-cast-to-device", PlatformSystemSettingValue::Text(value)) => {
            value == "Play to Menu"
        }
        (
            "windows.update.disable-store-auto-updates",
            PlatformSystemSettingValue::Integer(value),
        ) => matches!(*value, 2 | 4),
        (
            "windows.gaming.enable-hardware-gpu-scheduling",
            PlatformSystemSettingValue::Integer(value),
        ) => matches!(*value, 1 | 2),
        (_, PlatformSystemSettingValue::Integer(value)) => matches!(*value, 0 | 1),
        _ => false,
    }
}

fn registry_root(root: RegistryRoot) -> RegKey {
    match root {
        RegistryRoot::CurrentUser => RegKey::predef(HKEY_CURRENT_USER),
        RegistryRoot::LocalMachine => RegKey::predef(HKEY_LOCAL_MACHINE),
    }
}

fn registry_error(operation: &'static str, error: io::Error) -> PlatformError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        PlatformError::new(PlatformErrorCode::AccessDenied, operation)
    } else {
        PlatformError::io(operation, &error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composite_updates_preserve_unowned_fields() {
        let existing = "SwapEffectUpgradeEnable=0;VRROptimizeEnable=1;AutoHDREnable=1;";
        assert_eq!(
            update_composite_text(existing, "SwapEffectUpgradeEnable", "SwapEffectUpgradeEnable=1;",)
                .unwrap(),
            "VRROptimizeEnable=1;AutoHDREnable=1;SwapEffectUpgradeEnable=1;"
        );
        assert_eq!(composite_entry(existing, "vrroptimizeenable"), Some("1"));
        assert_eq!(composite_entry(existing, "missing"), None);
    }

    #[test]
    fn empty_composite_desire_removes_only_the_owned_field() {
        let existing = "SwapEffectUpgradeEnable=1;VRROptimizeEnable=1;";
        assert_eq!(
            update_composite_text(existing, "SwapEffectUpgradeEnable", "").unwrap(),
            "VRROptimizeEnable=1;"
        );
        assert!(update_composite_text(existing, "SwapEffectUpgradeEnable", "VRR=1;").is_err());
    }

    #[test]
    fn composite_idempotence_uses_the_effective_value() {
        let definition = catalog::definition("windows.gaming.optimize-windowed-games")
            .expect("the composite setting should exist");
        let current = PlatformSystemSettingValue::Snapshot(PlatformSystemSettingSnapshot::Text(
            "VRROptimizeEnable=1;SwapEffectUpgradeEnable=1;".to_owned(),
        ));
        assert!(value_matches_desired(
            definition,
            &current,
            &PlatformSystemSettingValue::Text("SwapEffectUpgradeEnable=1;".to_owned())
        ));
        assert!(!value_matches_desired(
            definition,
            &current,
            &PlatformSystemSettingValue::Text("SwapEffectUpgradeEnable=0;".to_owned())
        ));
    }

    #[test]
    fn version_scoped_contracts_fail_closed_without_a_build() {
        let definition = catalog::definition("windows.gaming.optimize-windowed-games")
            .expect("the composite setting should exist");
        assert!(!is_applicable(definition, None));
        assert!(!is_applicable(definition, Some(21_999)));
        assert!(is_applicable(definition, Some(22_000)));
    }

    #[test]
    fn every_catalog_entry_is_reachable_through_the_adapter() {
        for definition in catalog::definitions() {
            assert!(
                !definition.native.subkey.is_empty(),
                "{} has no native subkey",
                definition.setting_id
            );
            assert_eq!(
                catalog::definition(definition.setting_id)
                    .map(|entry| entry.setting_id)
                    .as_deref(),
                Some(definition.setting_id)
            );
        }
    }

    #[test]
    fn shortcut_name_decoding_is_lossless_and_fail_closed() {
        let decode_units = |units: &[u16]| {
            let bytes = units
                .iter()
                .flat_map(|unit| unit.to_le_bytes())
                .collect::<Vec<u8>>();
            decode_shortcut_name(RegValue {
                vtype: REG_SZ,
                bytes: bytes.into(),
            })
        };
        assert_eq!(
            decode_units(&[b'%' as u16, b's' as u16, b'.' as u16, b'l' as u16, b'n' as u16, b'k' as u16, 0])
                .unwrap(),
            PlatformSystemSettingValue::Text("%s.lnk".to_owned())
        );
        // Missing the terminating NUL, embedded NULs and odd byte counts are
        // rejected instead of being silently normalized.
        assert!(decode_units(&[b'a' as u16]).is_err());
        assert!(decode_units(&[b'a' as u16, 0, b'b' as u16, 0]).is_err());
        assert!(decode_shortcut_name(RegValue {
            vtype: REG_EXPAND_SZ,
            bytes: vec![0, 0].into(),
        })
        .is_err());
        assert!(!valid_shortcut_name_value(&PlatformSystemSettingValue::Text(
            "x".repeat(SHORTCUT_NAME_MAX_TEXT_BYTES + 1)
        )));
    }

    #[test]
    fn elevated_values_are_restricted_to_their_semantic_range() {
        let definition = catalog::definition("windows.services.disable-search-indexing")
            .expect("the service setting should exist");
        assert!(validate_value(
            definition,
            &PlatformSystemSettingValue::Integer(4)
        )
        .is_ok());
        assert!(validate_value(
            definition,
            &PlatformSystemSettingValue::Integer(9)
        )
        .is_err());
        assert!(validate_value(
            definition,
            &PlatformSystemSettingValue::Text("4".to_owned())
        )
        .is_err());
    }
}
