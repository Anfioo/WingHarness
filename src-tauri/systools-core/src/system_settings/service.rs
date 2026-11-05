//! Product-level system-settings service.
//!
//! The service turns the finite catalog of known settings into a user-facing
//! inventory, derives a deterministic change plan, applies it through the
//! platform adapter, and keeps a durable recovery document so a later
//! `Default` plan can restore the exact values observed before optimization.
//!
//! All native access goes through the platform trait; nothing below knows a
//! registry path, a service name, or a command line. Unreadable state is
//! reported as `Unavailable` and never as "off".

mod recovery;
mod recovery_policy;

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Mutex, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use recovery::{
    load_recovery, recovery_exists, remove_recovery, save_recovery, RecoveryDocument, RecoveryItem,
};
use recovery_policy::{
    desired_value_for_target, mark_restore_availability, reconciled_recovery_items,
    recovery_intent, recovery_items_by_id, valid_recovery_baseline,
};

use crate::{
    platform::contracts::{
        diagnostics, PlatformError, PlatformErrorCode, PlatformMutationState,
        PlatformSystemSettingDiagnosticCode,
    },
    shared::{
        operation::{CoordinatedOperationKind, OperationCancellationToken, OperationGuard},
        CoreError, CoreErrorCode, CoreResult,
    },
    system_settings::{
        catalog::SettingDefinition,
        models::{
            SystemSettingCategory, SystemSettingChangeFailureReason, SystemSettingChangeItemResult,
            SystemSettingChangeOutcomeStatus, SystemSettingChangePlanItem,
            SystemSettingChangeSkipReason, SystemSettingChangeSkippedItem, SystemSettingItem,
            SystemSettingRiskLevel, SystemSettingSelectionKind, SystemSettingStatus,
            SystemSettingTargetState, SystemSettingsCatalog, SystemSettingsCatalogSummary,
            SystemSettingsChangePlan, SystemSettingsChangeResult, SystemSettingsChangeSelection,
            SystemSettingsPlatform, SYSTEM_SETTINGS_CATALOG_SCHEMA_VERSION,
            SYSTEM_SETTINGS_CHANGE_PLAN_SCHEMA_VERSION,
        },
        platform::{
            current_platform, PlatformSystemSettingChangeRequest, PlatformSystemSettingState,
            PlatformSystemSettingValue, SystemSettingsCancellation,
        },
    },
};

const CHANGE_PLAN_TTL_MS: u64 = 5 * 60 * 1_000;
const MAX_CHANGE_ITEMS: usize = 256;

static CATALOG_SESSION: OnceLock<Mutex<Option<CatalogSession>>> = OnceLock::new();
static CHANGE_PLAN: OnceLock<Mutex<Option<PendingChangePlan>>> = OnceLock::new();
static SERVICE: SystemSettingsService = SystemSettingsService;

/// Single catalog coupling point.
///
/// The catalog lane owns the definition table. Every field the service reads
/// lives here so a renamed or added definition field is a one-line change at
/// merge time instead of a change to the scan logic.
mod catalog_view {
    use super::*;
    use crate::system_settings::catalog::definitions;

    pub(super) fn all() -> &'static [SettingDefinition] {
        definitions()
    }

    pub(super) fn setting_id(definition: &SettingDefinition) -> &'static str {
        definition.setting_id
    }

    /// Value applied when the user optimizes a setting.
    pub(super) fn optimized_value(definition: &SettingDefinition) -> PlatformSystemSettingValue {
        definition.recommended_value.owned()
    }

    /// Value applied when the user restores a setting without a recovery baseline.
    pub(super) fn default_value(definition: &SettingDefinition) -> PlatformSystemSettingValue {
        definition.default_value.owned()
    }

    /// Value applied when an already optimized setting is switched off.
    ///
    /// It differs from the catalog default when the operating-system default is
    /// itself the recommended value.
    pub(super) fn disabled_value(definition: &SettingDefinition) -> PlatformSystemSettingValue {
        definition
            .disabled_value
            .unwrap_or(definition.default_value)
            .owned()
    }

    pub(super) fn requires_elevation(definition: &SettingDefinition) -> bool {
        definition.requires_elevation
    }

    pub(super) fn selected_by_default(definition: &SettingDefinition) -> bool {
        definition.selected_by_default
    }

    pub(super) fn category(definition: &SettingDefinition) -> SystemSettingCategory {
        definition.category
    }

    pub(super) fn selection_kind(definition: &SettingDefinition) -> SystemSettingSelectionKind {
        definition.selection_kind
    }

    pub(super) fn risk_level(definition: &SettingDefinition) -> SystemSettingRiskLevel {
        definition.risk_level
    }

    pub(super) fn requires_restart(definition: &SettingDefinition) -> bool {
        definition.requires_restart
    }
}

/// Exact native state captured for one setting during the last scan.
#[derive(Clone)]
struct CatalogNativeItem {
    public: SystemSettingItem,
    current_value: PlatformSystemSettingValue,
    effective_value: PlatformSystemSettingValue,
    disabled_value: PlatformSystemSettingValue,
    recommended_value: PlatformSystemSettingValue,
}

#[derive(Clone)]
struct CatalogSession {
    public: SystemSettingsCatalog,
    native_items: Vec<CatalogNativeItem>,
}

#[derive(Clone)]
struct PendingChangeItem {
    public: SystemSettingChangePlanItem,
    expected_value: PlatformSystemSettingValue,
    desired_value: PlatformSystemSettingValue,
    /// A matching durable baseline or the native value observed before this enablement.
    recovery_value: PlatformSystemSettingValue,
}

#[derive(Clone)]
struct PendingChangePlan {
    public: SystemSettingsChangePlan,
    items: Vec<PendingChangeItem>,
}

/// Process-wide system-settings service.
pub(crate) struct SystemSettingsService;

pub(crate) fn service() -> &'static SystemSettingsService {
    &SERVICE
}

impl SystemSettingsService {
    pub(crate) fn cancel_scan() {
        OperationCancellationToken::system_settings_scan().cancel();
    }

    pub(crate) fn scan(&self) -> CoreResult<SystemSettingsCatalog> {
        let operation = OperationGuard::start(CoordinatedOperationKind::SystemSettingsScan)?;
        let session = capture_catalog(&operation)?;
        replace_catalog_session(session.clone())?;
        log_catalog(operation.id(), &session.public);
        operation.complete();
        Ok(session.public)
    }

    pub(crate) fn prepare_change(
        &self,
        selection: SystemSettingsChangeSelection,
    ) -> CoreResult<SystemSettingsChangePlan> {
        validate_selection(&selection)?;
        let operation = OperationGuard::start(CoordinatedOperationKind::SystemSettingsChange)?;
        let session = current_catalog_session()?;
        if session.public.scan_id != selection.scan_id {
            return Err(CoreError::invalid_input(
                "system settings catalog session has expired",
            ));
        }

        let document = load_recovery()?;
        let pending = build_change_plan(selection, session, document.as_ref(), unix_time_ms());
        let public = pending.public.clone();
        replace_change_plan(pending)?;
        log::info!(
            "system_settings_change_prepared operation_id={} target_count={} optimize_count={} restore_count={} skipped_count={} restart_required={}",
            operation.id(),
            public.items.len(),
            public
                .items
                .iter()
                .filter(|item| item.target == SystemSettingTargetState::Optimized)
                .count(),
            public
                .items
                .iter()
                .filter(|item| item.target == SystemSettingTargetState::Default)
                .count(),
            public.skipped_items.len(),
            public.requires_restart
        );
        operation.complete();
        Ok(public)
    }

    pub(crate) fn execute_change(
        &self,
        plan_id: String,
    ) -> CoreResult<SystemSettingsChangeResult> {
        validate_plan_id(&plan_id)?;
        let operation = OperationGuard::start(CoordinatedOperationKind::SystemSettingsChange)?;
        let pending = take_change_plan(&plan_id)?;
        if unix_time_ms() > pending.public.expires_at_ms {
            return Err(CoreError::invalid_input(
                "system settings change plan has expired",
            ));
        }

        // Cancellation must be observed before replacing the durable recovery
        // record. Once the preflight intent is persisted there is no further
        // cancellable Core step before the platform batch.
        operation.ensure_not_cancelled()?;
        let platform = current_platform();
        let mut results = Vec::with_capacity(pending.items.len());
        let mut possibly_changed = BTreeSet::new();
        let previous_recovery = load_recovery()?;
        let preflight_recovery = recovery_intent(previous_recovery.as_ref(), &pending.items);
        // Persist the merged per-setting baseline before the first operating
        // system mutation so earlier settings stay reversible when a later
        // batch changes unrelated items.
        if !preflight_recovery.is_empty() {
            save_recovery(&plan_id, preflight_recovery.clone(), operation.id())?;
        }
        let requests = pending
            .items
            .iter()
            .map(|item| PlatformSystemSettingChangeRequest {
                setting_id: item.public.setting_id.clone(),
                expected_value: item.expected_value.clone(),
                desired_value: item.desired_value.clone(),
            })
            .collect::<Vec<_>>();
        let platform_results = match platform.change_system_settings(&requests) {
            Ok(platform_results) if platform_results.len() == pending.items.len() => {
                Some(platform_results)
            }
            Ok(platform_results) => {
                log::error!(
                    "system_settings_change_batch_count_invalid operation_id={} expected_count={} actual_count={}",
                    operation.id(),
                    pending.items.len(),
                    platform_results.len()
                );
                for item in &pending.items {
                    possibly_changed.insert(item.public.setting_id.clone());
                    results.push(change_result(
                        item.public.setting_id.clone(),
                        SystemSettingChangeOutcomeStatus::Failed,
                        false,
                        Some(SystemSettingChangeFailureReason::PlatformFailure),
                    ));
                }
                None
            }
            Err(error) => {
                log::warn!(
                    "system_settings_change_batch_failed operation_id={} code={:?} error={}",
                    operation.id(),
                    error.code(),
                    diagnostics::text(&error)
                );
                for item in &pending.items {
                    if error.mutation_state() == PlatformMutationState::MayHaveChanged {
                        possibly_changed.insert(item.public.setting_id.clone());
                    }
                    results.push(change_result(
                        item.public.setting_id.clone(),
                        SystemSettingChangeOutcomeStatus::Failed,
                        false,
                        Some(failure_reason(error.code())),
                    ));
                }
                None
            }
        };
        for (item, platform_result) in pending
            .items
            .iter()
            .zip(platform_results.into_iter().flatten())
        {
            match platform_result {
                Ok(result) if result.verified => {
                    let status = if result.changed {
                        SystemSettingChangeOutcomeStatus::Changed
                    } else {
                        SystemSettingChangeOutcomeStatus::Unchanged
                    };
                    log::info!(
                        "system_setting_change_completed operation_id={} setting_id={} target={:?} changed={} restart_required={}",
                        operation.id(),
                        item.public.setting_id,
                        item.public.target,
                        result.changed,
                        item.public.requires_restart
                    );
                    results.push(change_result(
                        item.public.setting_id.clone(),
                        status,
                        true,
                        None,
                    ));
                }
                Ok(_) => {
                    possibly_changed.insert(item.public.setting_id.clone());
                    log::warn!(
                        "system_setting_change_verification_failed operation_id={} setting_id={} mutation_state=may_have_changed",
                        operation.id(),
                        item.public.setting_id
                    );
                    results.push(change_result(
                        item.public.setting_id.clone(),
                        SystemSettingChangeOutcomeStatus::Failed,
                        false,
                        Some(SystemSettingChangeFailureReason::VerificationFailed),
                    ));
                }
                Err(error) => {
                    let mutation_state = error.mutation_state();
                    if mutation_state == PlatformMutationState::MayHaveChanged {
                        possibly_changed.insert(item.public.setting_id.clone());
                    }
                    log::warn!(
                        "system_setting_change_failed operation_id={} setting_id={} code={:?} mutation_state={:?} error={}",
                        operation.id(),
                        item.public.setting_id,
                        error.code(),
                        mutation_state,
                        diagnostics::text(&error)
                    );
                    results.push(change_result(
                        item.public.setting_id.clone(),
                        SystemSettingChangeOutcomeStatus::Failed,
                        false,
                        Some(failure_reason(error.code())),
                    ));
                }
            }
        }

        // A partial batch leaves the machine in a mixed state. Items that
        // verified successfully are written back to the exact value observed
        // before the plan so the user does not have to inspect and undo half a
        // plan by hand. Uncertain mutations are never compensated here: their
        // current value is unknown, so the durable ledger keeps them for a
        // later explicit restore instead.
        if results
            .iter()
            .any(|result| result.status == SystemSettingChangeOutcomeStatus::Failed)
        {
            rollback_changed_items(platform, &pending.items, &results, operation.id());
        }

        let persisted_recovery_available = reconcile_recovery(
            previous_recovery.as_ref(),
            &plan_id,
            preflight_recovery,
            &pending.items,
            &results,
            &possibly_changed,
            operation.id(),
        );
        let changed_count = count_status(&results, SystemSettingChangeOutcomeStatus::Changed);
        let failed_count = count_status(&results, SystemSettingChangeOutcomeStatus::Failed);
        let requires_restart = changed_items_require_restart(&pending.items, &results);
        let catalog = capture_catalog(&operation)
            .and_then(|session| {
                replace_catalog_session(session.clone())?;
                Ok(session.public)
            })
            .ok();
        let recovery_available = catalog
            .as_ref()
            .map(|catalog| catalog.recovery_available)
            .unwrap_or(persisted_recovery_available);
        log::info!(
            "system_settings_change_finished operation_id={} changed_count={} failed_count={} uncertain_mutation_count={} recovery_available={}",
            operation.id(),
            changed_count,
            failed_count,
            possibly_changed.len(),
            recovery_available
        );
        operation.complete();
        Ok(SystemSettingsChangeResult {
            plan_id,
            changed_count,
            failed_count,
            requires_restart,
            recovery_available,
            items: results,
            catalog,
        })
    }
}

/// Builds a deterministic, side-effect-free change plan from one authoritative
/// catalog. Keeping selection decisions in one function prevents adapters from
/// diverging and lets recovery-sensitive skip behavior be tested without
/// reading or changing real settings.
fn build_change_plan(
    selection: SystemSettingsChangeSelection,
    session: CatalogSession,
    document: Option<&RecoveryDocument>,
    created_at_ms: u64,
) -> PendingChangePlan {
    let recovery_items = recovery_items_by_id(document);
    let mut items = Vec::new();
    let mut skipped_items = Vec::new();
    for change in selection.items {
        let setting_id = change.setting_id;
        let Some(item) = session
            .native_items
            .iter()
            .find(|item| item.public.setting_id == setting_id)
        else {
            skipped_items.push(skipped(
                setting_id,
                SystemSettingChangeSkipReason::SettingMissing,
            ));
            continue;
        };
        if item.public.status == SystemSettingStatus::Unavailable {
            skipped_items.push(skipped(
                setting_id,
                skip_reason_for_diagnostic(item.public.diagnostic),
            ));
            continue;
        }
        if change.target == SystemSettingTargetState::Optimized
            && item.public.status == SystemSettingStatus::Optimized
        {
            skipped_items.push(skipped(
                setting_id,
                SystemSettingChangeSkipReason::AlreadyOptimized,
            ));
            continue;
        }
        if change.target == SystemSettingTargetState::Default
            && item.public.status != SystemSettingStatus::Optimized
            && !item.public.restore_available
        {
            skipped_items.push(skipped(
                setting_id,
                SystemSettingChangeSkipReason::AlreadyDefault,
            ));
            continue;
        }
        let Some(desired_value) =
            desired_value_for_target(item, change.target, recovery_items.get(&setting_id))
        else {
            skipped_items.push(skipped(
                setting_id,
                SystemSettingChangeSkipReason::SettingChanged,
            ));
            continue;
        };
        let public = SystemSettingChangePlanItem {
            setting_id: setting_id.clone(),
            category: item.public.category,
            target: change.target,
            requires_restart: item.public.requires_restart,
            requires_elevation: item.public.requires_elevation,
        };
        items.push(PendingChangeItem {
            public,
            expected_value: item.current_value.clone(),
            desired_value,
            recovery_value: recovery_items
                .get(&setting_id)
                .filter(|recovery| valid_recovery_baseline(recovery, item))
                .map_or_else(
                    || item.current_value.clone(),
                    |recovery| recovery.original_value.clone(),
                ),
        });
    }

    let expires_at_ms = created_at_ms.saturating_add(CHANGE_PLAN_TTL_MS);
    let plan_id = stable_id(
        "system-settings-plan",
        &[
            session.public.catalog_revision.as_str(),
            created_at_ms.to_string().as_str(),
            items
                .iter()
                .map(|item| {
                    format!(
                        "{}:{}",
                        item.public.setting_id,
                        target_state_name(item.public.target)
                    )
                })
                .collect::<Vec<_>>()
                .join("|")
                .as_str(),
        ],
    );
    let public = SystemSettingsChangePlan {
        schema_version: SYSTEM_SETTINGS_CHANGE_PLAN_SCHEMA_VERSION,
        plan_id,
        scan_id: session.public.scan_id,
        catalog_revision: session.public.catalog_revision,
        created_at_ms,
        expires_at_ms,
        items: items.iter().map(|item| item.public.clone()).collect(),
        skipped_items,
        requires_confirmation: !items.is_empty(),
        requires_restart: items.iter().any(|item| item.public.requires_restart),
    };
    PendingChangePlan { public, items }
}

fn capture_catalog(operation: &OperationGuard) -> CoreResult<CatalogSession> {
    let started = Instant::now();
    let definitions = catalog_view::all();
    let setting_ids = definitions
        .iter()
        .map(catalog_view::setting_id)
        .collect::<Vec<_>>();
    let cancellation =
        SystemSettingsCancellation::scan_with_flag(operation.cancellation_flag());
    let states = current_platform()
        .scan_system_settings(&setting_ids, &cancellation)
        .map_err(platform_failure)?;
    operation.ensure_not_cancelled()?;
    let native_items = catalog_native_items(definitions, states)?;
    let document = load_recovery()?;
    Ok(assemble_catalog_session(
        started,
        native_items,
        document.as_ref(),
    ))
}

/// Validates the adapter inventory before applying declarative definitions.
/// Missing states remain visible as unavailable settings, while duplicate or
/// unknown identifiers fail closed because silently overwriting them could
/// authorize a change from ambiguous evidence.
fn catalog_native_items(
    definitions: &'static [SettingDefinition],
    states: Vec<PlatformSystemSettingState>,
) -> CoreResult<Vec<CatalogNativeItem>> {
    let known_ids = definitions
        .iter()
        .map(catalog_view::setting_id)
        .collect::<BTreeSet<_>>();
    let mut indexed_states = BTreeMap::new();
    for state in states {
        if !known_ids.contains(state.setting_id.as_str()) {
            return Err(CoreError::new(
                CoreErrorCode::Platform,
                "system settings adapter returned an unknown setting",
            ));
        }
        if indexed_states
            .insert(state.setting_id.clone(), state)
            .is_some()
        {
            return Err(CoreError::new(
                CoreErrorCode::Platform,
                "system settings adapter returned a duplicate setting",
            ));
        }
    }
    Ok(definitions
        .iter()
        .map(|definition| native_item(definition, indexed_states.get(catalog_view::setting_id(definition))))
        .collect())
}

fn assemble_catalog_session(
    started: Instant,
    mut native_items: Vec<CatalogNativeItem>,
    document: Option<&RecoveryDocument>,
) -> CatalogSession {
    let recovery_available = mark_restore_availability(&mut native_items, document);
    let scanned_at_ms = unix_time_ms();
    let catalog_revision = catalog_revision(&native_items);
    let scan_id = stable_id(
        "system-settings-scan",
        &[
            catalog_revision.as_str(),
            scanned_at_ms.to_string().as_str(),
        ],
    );
    let items = native_items
        .iter()
        .map(|item| item.public.clone())
        .collect::<Vec<_>>();
    let public = SystemSettingsCatalog {
        schema_version: SYSTEM_SETTINGS_CATALOG_SCHEMA_VERSION,
        scan_id,
        catalog_revision,
        platform: SystemSettingsPlatform::Windows,
        scanned_at_ms,
        summary: summary(&items),
        items,
        elapsed_ms: started.elapsed().as_millis() as u64,
        recovery_available,
    };
    CatalogSession {
        public,
        native_items,
    }
}

fn native_item(
    definition: &SettingDefinition,
    state: Option<&PlatformSystemSettingState>,
) -> CatalogNativeItem {
    let diagnostic = state
        .and_then(|state| state.diagnostic)
        .or_else(|| {
            state
                .is_none()
                .then_some(PlatformSystemSettingDiagnosticCode::StateUnavailable)
        });
    let current_value = state
        .map(|state| state.value.clone())
        .unwrap_or(PlatformSystemSettingValue::Missing);
    let default_value = catalog_view::default_value(definition);
    let recommended_value = catalog_view::optimized_value(definition);
    let effective_value = if current_value == PlatformSystemSettingValue::Missing {
        default_value.clone()
    } else {
        state
            .map(|state| state.effective_value.clone())
            .unwrap_or_else(|| current_value.clone())
    };
    let status = item_status(diagnostic, &effective_value, &recommended_value);
    CatalogNativeItem {
        public: SystemSettingItem {
            setting_id: catalog_view::setting_id(definition).to_string(),
            category: catalog_view::category(definition),
            selection_kind: catalog_view::selection_kind(definition),
            risk_level: catalog_view::risk_level(definition),
            status,
            selected_by_default: status == SystemSettingStatus::Recommended
                && catalog_view::selected_by_default(definition),
            restore_available: false,
            requires_restart: catalog_view::requires_restart(definition),
            requires_elevation: state
                .map(|state| state.requires_elevation)
                .unwrap_or_else(|| catalog_view::requires_elevation(definition)),
            diagnostic,
        },
        current_value,
        effective_value,
        disabled_value: catalog_view::disabled_value(definition),
        recommended_value,
    }
}

/// A diagnostic always wins: an unreadable value is unavailable, never "off".
fn item_status(
    diagnostic: Option<PlatformSystemSettingDiagnosticCode>,
    effective_value: &PlatformSystemSettingValue,
    recommended_value: &PlatformSystemSettingValue,
) -> SystemSettingStatus {
    if diagnostic.is_some() {
        SystemSettingStatus::Unavailable
    } else if effective_value == recommended_value {
        SystemSettingStatus::Optimized
    } else {
        SystemSettingStatus::Recommended
    }
}

fn summary(items: &[SystemSettingItem]) -> SystemSettingsCatalogSummary {
    SystemSettingsCatalogSummary {
        item_count: items.len() as u64,
        recommended_count: items
            .iter()
            .filter(|item| item.status == SystemSettingStatus::Recommended)
            .count() as u64,
        optimized_count: items
            .iter()
            .filter(|item| item.status == SystemSettingStatus::Optimized)
            .count() as u64,
        selected_count: items.iter().filter(|item| item.selected_by_default).count() as u64,
        unavailable_count: items
            .iter()
            .filter(|item| item.status == SystemSettingStatus::Unavailable)
            .count() as u64,
    }
}

fn catalog_revision(items: &[CatalogNativeItem]) -> String {
    let serialized = serde_json::to_vec(
        &items
            .iter()
            .map(|item| {
                (
                    &item.public.setting_id,
                    &item.current_value,
                    item.public.diagnostic,
                )
            })
            .collect::<Vec<_>>(),
    )
    .unwrap_or_default();
    blake3::hash(&serialized).to_hex().to_string()
}

fn validate_selection(selection: &SystemSettingsChangeSelection) -> CoreResult<()> {
    if selection.scan_id.is_empty() || selection.scan_id.len() > 128 {
        return Err(CoreError::invalid_input(
            "system settings scan identifier is invalid",
        ));
    }
    if selection.items.is_empty() || selection.items.len() > MAX_CHANGE_ITEMS {
        return Err(CoreError::invalid_input(
            "system settings selection is invalid",
        ));
    }
    if selection
        .items
        .iter()
        .any(|item| item.setting_id.is_empty() || item.setting_id.len() > 128)
    {
        return Err(CoreError::invalid_input(
            "system setting identifier is invalid",
        ));
    }
    let unique_ids = selection
        .items
        .iter()
        .map(|item| item.setting_id.as_str())
        .collect::<BTreeSet<_>>();
    if unique_ids.len() != selection.items.len() {
        return Err(CoreError::invalid_input(
            "system settings selection contains duplicate identifiers",
        ));
    }
    Ok(())
}

fn validate_plan_id(plan_id: &str) -> CoreResult<()> {
    if plan_id.is_empty() || plan_id.len() > 128 {
        Err(CoreError::invalid_input(
            "system settings plan identifier is invalid",
        ))
    } else {
        Ok(())
    }
}

fn stable_id(namespace: &str, parts: &[&str]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(namespace.as_bytes());
    for part in parts {
        hasher.update(&[0]);
        hasher.update(part.as_bytes());
    }
    format!("{namespace}-{}", &hasher.finalize().to_hex()[..24])
}

fn target_state_name(target: SystemSettingTargetState) -> &'static str {
    match target {
        SystemSettingTargetState::Optimized => "optimized",
        SystemSettingTargetState::Default => "default",
    }
}

fn skipped(
    setting_id: String,
    reason: SystemSettingChangeSkipReason,
) -> SystemSettingChangeSkippedItem {
    SystemSettingChangeSkippedItem {
        setting_id,
        reason,
    }
}

fn skip_reason_for_diagnostic(
    diagnostic: Option<PlatformSystemSettingDiagnosticCode>,
) -> SystemSettingChangeSkipReason {
    match diagnostic {
        Some(PlatformSystemSettingDiagnosticCode::Unsupported) => {
            SystemSettingChangeSkipReason::Unsupported
        }
        _ => SystemSettingChangeSkipReason::StateUnavailable,
    }
}

fn failure_reason(code: PlatformErrorCode) -> SystemSettingChangeFailureReason {
    match code {
        PlatformErrorCode::AccessDenied => SystemSettingChangeFailureReason::PermissionDenied,
        PlatformErrorCode::UserCancelled => SystemSettingChangeFailureReason::UserCancelled,
        PlatformErrorCode::ItemChanged => SystemSettingChangeFailureReason::SettingChanged,
        PlatformErrorCode::Unsupported => SystemSettingChangeFailureReason::Unsupported,
        _ => SystemSettingChangeFailureReason::PlatformFailure,
    }
}

/// Converts a platform failure into a Core error whose diagnostic remains
/// local. Native text is logged, never copied into the error payload.
fn platform_failure(error: PlatformError) -> CoreError {
    log::warn!(
        "system_settings_platform_failed code={:?} mutation_state={:?} error={}",
        error.code(),
        error.mutation_state(),
        diagnostics::text(&error)
    );
    let code = match error.code() {
        PlatformErrorCode::AccessDenied => CoreErrorCode::PermissionDenied,
        PlatformErrorCode::UserCancelled => CoreErrorCode::OperationCancelled,
        PlatformErrorCode::InvalidData | PlatformErrorCode::InvalidPath => {
            CoreErrorCode::InvalidInput
        }
        PlatformErrorCode::ItemChanged
        | PlatformErrorCode::Io
        | PlatformErrorCode::OperationFailed
        | PlatformErrorCode::Unsupported => CoreErrorCode::Platform,
    };
    let mapped = CoreError::new(code, "system settings platform operation failed");
    if error.mutation_state() == PlatformMutationState::MayHaveChanged {
        mapped.with_possible_side_effects()
    } else {
        mapped
    }
}

fn change_result(
    setting_id: String,
    status: SystemSettingChangeOutcomeStatus,
    verified: bool,
    failure_reason: Option<SystemSettingChangeFailureReason>,
) -> SystemSettingChangeItemResult {
    SystemSettingChangeItemResult {
        setting_id,
        status,
        verified,
        failure_reason,
    }
}

fn count_status(
    items: &[SystemSettingChangeItemResult],
    status: SystemSettingChangeOutcomeStatus,
) -> u64 {
    items.iter().filter(|item| item.status == status).count() as u64
}

fn changed_items_require_restart(
    pending_items: &[PendingChangeItem],
    results: &[SystemSettingChangeItemResult],
) -> bool {
    pending_items.iter().any(|pending| {
        pending.public.requires_restart
            && results.iter().any(|result| {
                result.setting_id == pending.public.setting_id
                    && result.status == SystemSettingChangeOutcomeStatus::Changed
            })
    })
}

/// Writes the previous exact value back for every item that changed before the
/// plan failed elsewhere.
///
/// The compensating requests use the value just written as the expected value,
/// so a concurrent third-party edit is never overwritten: the platform rejects
/// the restore with `ItemChanged` and the durable ledger stays valid.
fn rollback_changed_items(
    platform: &dyn crate::system_settings::platform::SystemSettingsPlatform,
    pending_items: &[PendingChangeItem],
    results: &[SystemSettingChangeItemResult],
    operation_id: u64,
) {
    let requests = pending_items
        .iter()
        // Only optimizations are compensated. A restore already returns the
        // setting to the user's own baseline and must never be undone into the
        // optimized state because an unrelated item failed.
        .filter(|item| item.public.target == SystemSettingTargetState::Optimized)
        .filter(|item| {
            results.iter().any(|result| {
                result.setting_id == item.public.setting_id
                    && result.status == SystemSettingChangeOutcomeStatus::Changed
            })
        })
        .map(|item| PlatformSystemSettingChangeRequest {
            setting_id: item.public.setting_id.clone(),
            expected_value: item.desired_value.clone(),
            desired_value: item.recovery_value.clone(),
        })
        .collect::<Vec<_>>();
    if requests.is_empty() {
        return;
    }
    log::warn!(
        "system_settings_change_rollback_started operation_id={} item_count={}",
        operation_id,
        requests.len()
    );
    let outcomes = match platform.change_system_settings(&requests) {
        Ok(outcomes) => outcomes,
        Err(error) => {
            log::warn!(
                "system_settings_change_rollback_failed operation_id={} code={:?} error={}",
                operation_id,
                error.code(),
                diagnostics::text(&error)
            );
            return;
        }
    };
    let mut restored = 0_u64;
    for (request, outcome) in requests.iter().zip(outcomes) {
        match outcome {
            Ok(result) if result.verified => {
                restored += 1;
                log::info!(
                    "system_setting_change_rollback_item operation_id={} setting_id={} changed={}",
                    operation_id,
                    request.setting_id,
                    result.changed
                );
            }
            Ok(_) => log::warn!(
                "system_setting_change_rollback_item_failed operation_id={} setting_id={} reason=verification_failed",
                operation_id,
                request.setting_id
            ),
            Err(error) => log::warn!(
                "system_setting_change_rollback_item_failed operation_id={} setting_id={} code={:?} error={}",
                operation_id,
                request.setting_id,
                error.code(),
                diagnostics::text(&error)
            ),
        }
    }
    log::warn!(
        "system_settings_change_rollback_finished operation_id={} restored_count={} item_count={}",
        operation_id,
        restored,
        requests.len()
    );
}

fn catalog_session_lock() -> &'static Mutex<Option<CatalogSession>> {
    CATALOG_SESSION.get_or_init(|| Mutex::new(None))
}

fn change_plan_lock() -> &'static Mutex<Option<PendingChangePlan>> {
    CHANGE_PLAN.get_or_init(|| Mutex::new(None))
}

fn replace_catalog_session(session: CatalogSession) -> CoreResult<()> {
    *catalog_session_lock()
        .lock()
        .map_err(|_| CoreError::operation_failed("system settings catalog lock is poisoned"))? =
        Some(session);
    Ok(())
}

fn current_catalog_session() -> CoreResult<CatalogSession> {
    catalog_session_lock()
        .lock()
        .map_err(|_| CoreError::operation_failed("system settings catalog lock is poisoned"))?
        .clone()
        .ok_or_else(|| CoreError::invalid_input("scan system settings before preparing changes"))
}

fn replace_change_plan(plan: PendingChangePlan) -> CoreResult<()> {
    *change_plan_lock()
        .lock()
        .map_err(|_| CoreError::operation_failed("system settings plan lock is poisoned"))? =
        Some(plan);
    Ok(())
}

fn take_change_plan(plan_id: &str) -> CoreResult<PendingChangePlan> {
    let mut guard = change_plan_lock()
        .lock()
        .map_err(|_| CoreError::operation_failed("system settings plan lock is poisoned"))?;
    if guard
        .as_ref()
        .is_none_or(|plan| plan.public.plan_id != plan_id)
    {
        return Err(CoreError::invalid_input(
            "system settings change plan is unavailable",
        ));
    }
    guard
        .take()
        .ok_or_else(|| CoreError::invalid_input("system settings change plan is unavailable"))
}

fn reconcile_recovery(
    previous: Option<&RecoveryDocument>,
    recovery_id: &str,
    preflight_items: Vec<RecoveryItem>,
    pending_items: &[PendingChangeItem],
    results: &[SystemSettingChangeItemResult],
    possibly_changed: &BTreeSet<String>,
    operation_id: u64,
) -> bool {
    let items = reconciled_recovery_items(
        previous,
        preflight_items,
        pending_items,
        results,
        possibly_changed,
    );
    log::info!(
        "system_settings_recovery_reconciled operation_id={} previous_count={} retained_count={} uncertain_mutation_count={}",
        operation_id,
        previous.map_or(0, |document| document.items.len()),
        items.len(),
        possibly_changed.len()
    );
    let result = if items.is_empty() {
        remove_recovery().map(|_| false)
    } else {
        save_recovery(recovery_id, items, operation_id).map(|_| true)
    };
    match result {
        Ok(available) => available,
        Err(error) => {
            // The preflight document is already durable. A failed compaction
            // must not turn a successful change into an error or hide the
            // conservative recovery record.
            log::warn!(
                "system_settings_recovery_reconcile_failed operation_id={} error={}",
                operation_id,
                error.diagnostic()
            );
            recovery_exists()
        }
    }
}

fn log_catalog(operation_id: u64, catalog: &SystemSettingsCatalog) {
    let restorable_count = catalog
        .items
        .iter()
        .filter(|item| item.restore_available)
        .count();
    log::info!(
        "system_settings_catalog_scanned operation_id={} platform={:?} item_count={} recommended_count={} selected_count={} restorable_count={} unavailable_count={} elapsed_ms={}",
        operation_id,
        catalog.platform,
        catalog.summary.item_count,
        catalog.summary.recommended_count,
        catalog.summary.selected_count,
        restorable_count,
        catalog.summary.unavailable_count,
        catalog.elapsed_ms
    );
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native_fixture(
        setting_id: &str,
        status: SystemSettingStatus,
        restore_available: bool,
        diagnostic: Option<PlatformSystemSettingDiagnosticCode>,
        requires_restart: bool,
    ) -> CatalogNativeItem {
        let optimized = status == SystemSettingStatus::Optimized;
        let value = i64::from(optimized);
        CatalogNativeItem {
            public: SystemSettingItem {
                setting_id: setting_id.to_string(),
                category: SystemSettingCategory::Performance,
                selection_kind: SystemSettingSelectionKind::Custom,
                risk_level: SystemSettingRiskLevel::Standard,
                status,
                selected_by_default: false,
                restore_available,
                requires_restart,
                requires_elevation: false,
                diagnostic,
            },
            current_value: PlatformSystemSettingValue::Integer(value),
            effective_value: PlatformSystemSettingValue::Integer(value),
            disabled_value: PlatformSystemSettingValue::Integer(0),
            recommended_value: PlatformSystemSettingValue::Integer(1),
        }
    }

    fn catalog_session_fixture(native_items: Vec<CatalogNativeItem>) -> CatalogSession {
        let items = native_items
            .iter()
            .map(|item| item.public.clone())
            .collect::<Vec<_>>();
        CatalogSession {
            public: SystemSettingsCatalog {
                schema_version: SYSTEM_SETTINGS_CATALOG_SCHEMA_VERSION,
                scan_id: "scan-plan-fixture".to_string(),
                catalog_revision: catalog_revision(&native_items),
                platform: SystemSettingsPlatform::Windows,
                scanned_at_ms: 1,
                summary: summary(&items),
                items,
                elapsed_ms: 1,
                recovery_available: false,
            },
            native_items,
        }
    }

    fn selection(scan_id: &str, items: &[(&str, SystemSettingTargetState)]) -> SystemSettingsChangeSelection {
        SystemSettingsChangeSelection {
            scan_id: scan_id.to_string(),
            items: items
                .iter()
                .map(|(setting_id, target)| {
                    crate::system_settings::models::SystemSettingChangeSelectionItem {
                        setting_id: (*setting_id).to_string(),
                        target: *target,
                    }
                })
                .collect(),
        }
    }

    #[test]
    fn unreadable_state_is_unavailable_even_when_the_value_looks_default() {
        let status = item_status(
            Some(PlatformSystemSettingDiagnosticCode::StateUnavailable),
            &PlatformSystemSettingValue::Integer(0),
            &PlatformSystemSettingValue::Integer(1),
        );
        assert_eq!(status, SystemSettingStatus::Unavailable);

        let status = item_status(
            Some(PlatformSystemSettingDiagnosticCode::AccessDenied),
            &PlatformSystemSettingValue::Integer(1),
            &PlatformSystemSettingValue::Integer(1),
        );
        assert_eq!(status, SystemSettingStatus::Unavailable);
    }

    #[test]
    fn readable_state_maps_to_recommended_or_optimized() {
        assert_eq!(
            item_status(
                None,
                &PlatformSystemSettingValue::Integer(1),
                &PlatformSystemSettingValue::Integer(1)
            ),
            SystemSettingStatus::Optimized
        );
        assert_eq!(
            item_status(
                None,
                &PlatformSystemSettingValue::Integer(0),
                &PlatformSystemSettingValue::Integer(1)
            ),
            SystemSettingStatus::Recommended
        );
    }

    #[test]
    fn plan_skips_missing_optimized_unavailable_and_already_default_items() {
        let session = catalog_session_fixture(vec![
            native_fixture(
                "windows.a.optimized",
                SystemSettingStatus::Optimized,
                false,
                None,
                false,
            ),
            native_fixture(
                "windows.b.recommended",
                SystemSettingStatus::Recommended,
                false,
                None,
                false,
            ),
            native_fixture(
                "windows.c.unavailable",
                SystemSettingStatus::Unavailable,
                false,
                Some(PlatformSystemSettingDiagnosticCode::Unsupported),
                false,
            ),
            native_fixture(
                "windows.d.default",
                SystemSettingStatus::Recommended,
                false,
                None,
                false,
            ),
        ]);
        let plan = build_change_plan(
            selection(
                "scan-plan-fixture",
                &[
                    ("windows.a.optimized", SystemSettingTargetState::Optimized),
                    ("windows.b.recommended", SystemSettingTargetState::Optimized),
                    ("windows.c.unavailable", SystemSettingTargetState::Optimized),
                    ("windows.d.default", SystemSettingTargetState::Default),
                    ("windows.missing", SystemSettingTargetState::Optimized),
                ],
            ),
            session,
            None,
            1_000,
        );

        assert_eq!(plan.public.items.len(), 1);
        assert_eq!(plan.public.items[0].setting_id, "windows.b.recommended");
        assert_eq!(plan.public.items[0].target, SystemSettingTargetState::Optimized);
        assert!(plan.public.requires_confirmation);
        assert_eq!(plan.items[0].desired_value, PlatformSystemSettingValue::Integer(1));
        assert_eq!(plan.items[0].expected_value, PlatformSystemSettingValue::Integer(0));

        let reasons = plan
            .public
            .skipped_items
            .iter()
            .map(|item| (item.setting_id.as_str(), item.reason))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            reasons.get("windows.a.optimized"),
            Some(&SystemSettingChangeSkipReason::AlreadyOptimized)
        );
        assert_eq!(
            reasons.get("windows.c.unavailable"),
            Some(&SystemSettingChangeSkipReason::Unsupported)
        );
        assert_eq!(
            reasons.get("windows.d.default"),
            Some(&SystemSettingChangeSkipReason::AlreadyDefault)
        );
        assert_eq!(
            reasons.get("windows.missing"),
            Some(&SystemSettingChangeSkipReason::SettingMissing)
        );
        assert_eq!(plan.public.expires_at_ms, 1_000 + CHANGE_PLAN_TTL_MS);
    }

    #[test]
    fn plan_restores_the_durable_baseline_before_the_definition_default() {
        let session = catalog_session_fixture(vec![native_fixture(
            "windows.a.optimized",
            SystemSettingStatus::Optimized,
            true,
            None,
            false,
        )]);
        let document = RecoveryDocument {
            schema_version: recovery::RECOVERY_SCHEMA_VERSION,
            recovery_id: "recovery".to_string(),
            created_at_ms: 1,
            items: vec![RecoveryItem {
                setting_id: "windows.a.optimized".to_string(),
                original_value: PlatformSystemSettingValue::Integer(42),
                optimized_value: PlatformSystemSettingValue::Integer(1),
            }],
        };
        let plan = build_change_plan(
            selection(
                "scan-plan-fixture",
                &[("windows.a.optimized", SystemSettingTargetState::Default)],
            ),
            session,
            Some(&document),
            1_000,
        );
        assert_eq!(plan.public.items.len(), 1);
        assert_eq!(
            plan.items[0].desired_value,
            PlatformSystemSettingValue::Integer(42)
        );
        assert_eq!(
            plan.items[0].recovery_value,
            PlatformSystemSettingValue::Integer(42)
        );
    }

    #[test]
    fn selection_validation_rejects_empty_and_duplicate_input() {
        assert!(validate_selection(&selection("scan", &[])).is_err());
        assert!(validate_selection(&selection("", &[("a", SystemSettingTargetState::Optimized)])).is_err());
        assert!(validate_selection(&selection(
            "scan",
            &[
                ("a", SystemSettingTargetState::Optimized),
                ("a", SystemSettingTargetState::Default)
            ]
        ))
        .is_err());
        assert!(validate_selection(&selection("scan", &[("a", SystemSettingTargetState::Optimized)]))
            .is_ok());
    }

    #[test]
    fn catalog_revision_is_deterministic_for_the_same_native_state() {
        let build = || {
            catalog_session_fixture(vec![native_fixture(
                "windows.a",
                SystemSettingStatus::Recommended,
                false,
                None,
                false,
            )])
        };
        assert_eq!(build().public.catalog_revision, build().public.catalog_revision);
        assert_eq!(stable_id("system-settings-plan", &["a"]).len(), "system-settings-plan-".len() + 24);
    }
}
