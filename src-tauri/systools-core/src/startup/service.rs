//! Startup catalog session and two-phase change orchestration.
//!
//! A scan stores the native facts behind every public item so a later change
//! never has to trust a client-supplied identifier. Preparing a change turns a
//! selection into a reviewable plan, and executing it re-reads nothing from the
//! caller: only the cached plan and its captured native requests are used.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::platform::contracts::{PlatformError, PlatformErrorCode, PlatformResult};
use crate::shared::error::{CoreError, CoreErrorCode, CoreResult};
use crate::shared::operation::{
    take_cancellation, CoordinatedOperationKind, OperationCancellationToken, OperationGuard,
};

use super::aggregation;
use super::models::{
    StartupCatalog, StartupChangeFailureReason, StartupChangeItemResult, StartupChangeOutcomeStatus,
    StartupChangePlan, StartupChangePlanItem, StartupChangeResult, StartupChangeSelection,
    StartupChangeSkipReason, StartupChangeSkippedItem, StartupDesiredState,
    STARTUP_CATALOG_SCHEMA_VERSION, STARTUP_CHANGE_PLAN_SCHEMA_VERSION,
};
use super::platform::{
    current_platform, silent_scan_progress, PlatformStartupArtifact, PlatformStartupChangeRequest,
    PlatformStartupChangeResult, PlatformStartupDesiredState, PlatformStartupSourceResult,
    StartupCancellation, StartupScanProgress,
};
use super::policy;

/// A prepared plan is shown to the user and then executed; a stale plan must not
/// mutate native state after the review window closes.
const CHANGE_PLAN_TTL_MS: u64 = 5 * 60 * 1_000;
/// Upper bound for one reviewed change so a single request stays small.
const MAX_CHANGE_ITEMS: usize = 256;
const UNKNOWN_ITEM_NAME: &str = "Unknown startup item";

static SCAN_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct NativeStartupRecord {
    source_id: String,
    artifact: PlatformStartupArtifact,
}

#[derive(Clone)]
struct StartupCatalogSession {
    catalog: StartupCatalog,
    native_records: BTreeMap<String, NativeStartupRecord>,
}

#[derive(Clone)]
struct PendingChangeTarget {
    item_id: String,
    request: PlatformStartupChangeRequest,
}

#[derive(Clone)]
struct PendingChangePlan {
    public_plan: StartupChangePlan,
    targets: Vec<PendingChangeTarget>,
}

/// Process-wide startup service.
///
/// The session and the pending plan are separate locks: reading a catalog never
/// blocks a change, and a consumed plan can never be replayed.
pub(crate) struct StartupService {
    session: Mutex<Option<StartupCatalogSession>>,
    pending_plan: Mutex<Option<PendingChangePlan>>,
}

/// Returns the process-wide startup service.
pub(crate) fn service() -> &'static StartupService {
    static SERVICE: OnceLock<StartupService> = OnceLock::new();
    SERVICE.get_or_init(|| StartupService {
        session: Mutex::new(None),
        pending_plan: Mutex::new(None),
    })
}

impl StartupService {
    pub(crate) fn scan(&self) -> CoreResult<StartupCatalog> {
        self.scan_with_progress(&silent_scan_progress())
    }

    /// Runs one catalog scan and reports each native source as it finishes.
    pub(crate) fn scan_with_progress(
        &self,
        progress: &dyn StartupScanProgress,
    ) -> CoreResult<StartupCatalog> {
        let operation = OperationGuard::start(CoordinatedOperationKind::StartupScan)?;
        let cancellation = StartupCancellation::scan_with_flag(operation.cancellation_flag());
        let catalog = self.scan_locked(Some(&cancellation), progress)?;
        operation.ensure_not_cancelled()?;
        log::info!(
            "startup_catalog_ready operation_id={} scan_id={} item_count={} group_count={} source_count={} complete={} elapsed_ms={}",
            operation.id(),
            catalog.scan_id,
            catalog.summary.item_count,
            catalog.summary.group_count,
            catalog.coverage.len(),
            catalog.complete,
            catalog.elapsed_ms
        );
        operation.complete();
        Ok(catalog)
    }

    pub(crate) fn cancel_scan(&self) -> CoreResult<()> {
        OperationCancellationToken::startup_scan().cancel();
        Ok(())
    }

    pub(crate) fn prepare_change(
        &self,
        selection: StartupChangeSelection,
    ) -> CoreResult<StartupChangePlan> {
        validate_selection(&selection)?;
        let operation = OperationGuard::start(CoordinatedOperationKind::StartupChange)?;
        let started = Instant::now();
        let session = self.current_session()?;
        if session.catalog.scan_id != selection.scan_id {
            return Err(CoreError::invalid_input(
                "startup catalog session has expired",
            ));
        }

        let artifacts = session
            .catalog
            .artifacts
            .iter()
            .map(|artifact| (artifact.item_id.as_str(), artifact))
            .collect::<BTreeMap<_, _>>();
        let mut items = Vec::new();
        let mut skipped_items = Vec::new();
        for item_id in deduplicated_item_ids(&selection.item_ids) {
            let Some(display_artifact) = artifacts.get(item_id.as_str()) else {
                skipped_items.push(skipped_item(
                    item_id,
                    UNKNOWN_ITEM_NAME,
                    StartupChangeSkipReason::ItemMissing,
                ));
                continue;
            };
            let Some(record) = session.native_records.get(&item_id) else {
                // The catalog still lists the item but its native facts were
                // never retained; the session can no longer authorize a change.
                skipped_items.push(skipped_item(
                    item_id,
                    &display_artifact.display_name,
                    StartupChangeSkipReason::CatalogExpired,
                ));
                continue;
            };
            if let Some(reason) = policy::skip_reason(&record.artifact, selection.desired_state) {
                skipped_items.push(skipped_item(
                    item_id,
                    &display_artifact.display_name,
                    reason,
                ));
                continue;
            }
            items.push(StartupChangePlanItem {
                item_id: item_id.clone(),
                display_name: display_artifact.display_name.clone(),
                source_kind: display_artifact.source_kind,
                scope: display_artifact.scope,
                previous_state: display_artifact.configured_state,
                desired_state: selection.desired_state,
                warnings: policy::change_warnings(&record.artifact),
                requires_elevation: policy::requires_elevation(
                    &record.artifact,
                    selection.desired_state,
                ),
            });
        }

        let created_at_ms = unix_time_ms();
        let expires_at_ms = created_at_ms.saturating_add(CHANGE_PLAN_TTL_MS);
        let plan_id = change_plan_id(
            &session.catalog.catalog_revision,
            selection.desired_state,
            &items,
            expires_at_ms,
        );
        let public_plan = StartupChangePlan {
            schema_version: STARTUP_CHANGE_PLAN_SCHEMA_VERSION,
            plan_id,
            scan_id: session.catalog.scan_id.clone(),
            catalog_revision: session.catalog.catalog_revision.clone(),
            created_at_ms,
            expires_at_ms,
            desired_state: selection.desired_state,
            requires_confirmation: !items.is_empty(),
            items,
            skipped_items,
        };
        let targets = public_plan
            .items
            .iter()
            .filter_map(|item| {
                session
                    .native_records
                    .get(&item.item_id)
                    .map(|record| PendingChangeTarget {
                        item_id: item.item_id.clone(),
                        request: PlatformStartupChangeRequest {
                            provider_item_id: record.artifact.provider_item_id.clone(),
                            source_id: record.source_id.clone(),
                            expected_artifact: record.artifact.clone(),
                            desired_state: selection.desired_state.into(),
                        },
                    })
            })
            .collect();

        // A cancellation that arrived while the plan was built must not leave a
        // plan behind for a later execution.
        operation.ensure_not_cancelled()?;
        self.replace_plan(PendingChangePlan {
            public_plan: public_plan.clone(),
            targets,
        })?;
        log::info!(
            "startup_change_prepared operation_id={} plan_id={} desired_state={:?} target_count={} skipped_count={} expires_in_ms={} elapsed_ms={}",
            operation.id(),
            public_plan.plan_id,
            public_plan.desired_state,
            public_plan.items.len(),
            public_plan.skipped_items.len(),
            CHANGE_PLAN_TTL_MS,
            started.elapsed().as_millis()
        );
        operation.complete();
        Ok(public_plan)
    }

    /// Executes a prepared change and forwards an ephemeral native authorization
    /// prompt.
    ///
    /// The localized prompt is UI context only: it is never persisted or logged,
    /// and platforms that do not display a managed authorization dialog ignore
    /// it.
    pub(crate) fn execute_change(
        &self,
        plan_id: &str,
        authorization_prompt: &str,
    ) -> CoreResult<StartupChangeResult> {
        validate_plan_id(plan_id)?;
        let operation = OperationGuard::start(CoordinatedOperationKind::StartupChange)?;
        let started = Instant::now();
        let pending = self.take_plan(plan_id)?;
        if unix_time_ms() > pending.public_plan.expires_at_ms {
            return Err(CoreError::invalid_input("startup change plan has expired"));
        }

        let requests = pending
            .targets
            .iter()
            .map(|target| target.request.clone())
            .collect::<Vec<_>>();
        let mut results = Vec::with_capacity(pending.targets.len());
        if operation.cancelled().load(Ordering::Relaxed) {
            for target in &pending.targets {
                results.push(cancelled_item_result(target));
            }
        } else if !requests.is_empty() {
            match current_platform().change_startup_items(&requests, Some(authorization_prompt)) {
                Ok(platform_results) if platform_results.len() == pending.targets.len() => {
                    for (target, platform_result) in pending.targets.iter().zip(platform_results) {
                        results.push(change_item_result(target, platform_result));
                    }
                }
                Ok(_) => {
                    log::warn!(
                        "startup_change_batch_failed operation_id={} reason={:?}",
                        operation.id(),
                        PlatformErrorCode::InvalidData
                    );
                    let error = PlatformError::new(
                        PlatformErrorCode::InvalidData,
                        "startup platform returned an invalid batch result count",
                    );
                    for target in &pending.targets {
                        results.push(change_item_result(target, Err(error.clone())));
                    }
                }
                Err(error) => {
                    log::warn!(
                        "startup_change_batch_failed operation_id={} target_count={} reason={:?} mutation_state={:?} diagnostic={}",
                        operation.id(),
                        requests.len(),
                        error.code(),
                        error.mutation_state(),
                        error.diagnostic()
                    );
                    for target in &pending.targets {
                        results.push(change_item_result(target, Err(error.clone())));
                    }
                }
            }
        }

        let changed_count = results
            .iter()
            .filter(|item| item.status == StartupChangeOutcomeStatus::Changed)
            .count() as u64;
        let failed_count = results
            .iter()
            .filter(|item| item.status == StartupChangeOutcomeStatus::Failed)
            .count() as u64;

        // The native mutation is final at this point. A readback failure must not
        // erase its verified result or invite the UI to retry a consumed plan.
        let catalog = match self.scan_locked(None, &silent_scan_progress()) {
            Ok(catalog) => Some(catalog),
            Err(error) => {
                log::warn!(
                    "startup_change_catalog_refresh_failed operation_id={} code={:?} diagnostic={}",
                    operation.id(),
                    error.code(),
                    error.diagnostic()
                );
                None
            }
        };
        log::info!(
            "startup_change_completed operation_id={} plan_id={} desired_state={:?} changed_count={} failed_count={} verified_count={} catalog_refreshed={} elapsed_ms={}",
            operation.id(),
            pending.public_plan.plan_id,
            pending.public_plan.desired_state,
            changed_count,
            failed_count,
            results.iter().filter(|item| item.verified).count(),
            catalog.is_some(),
            started.elapsed().as_millis()
        );
        let result = StartupChangeResult {
            plan_id: plan_id.to_owned(),
            changed_count,
            failed_count,
            items: results,
            catalog,
        };
        operation.complete();
        Ok(result)
    }

    pub(crate) fn cancel_change(&self) -> CoreResult<()> {
        OperationCancellationToken::startup_change().cancel();
        if let Ok(mut plan) = self.pending_plan.lock() {
            *plan = None;
        }
        Ok(())
    }

    /// Runs one platform scan, projects it, and replaces the cached session.
    ///
    /// Callers own operation coordination: the initial scan holds the
    /// `StartupScan` guard, while the post-change readback reuses the same body
    /// without a second guard of that kind.
    fn scan_locked(
        &self,
        cancellation: Option<&StartupCancellation>,
        progress: &dyn StartupScanProgress,
    ) -> CoreResult<StartupCatalog> {
        // A scan cancellation that no running scan consumed must not stop a
        // readback that reconciles state the operating system already changed.
        let owned;
        let cancellation = match cancellation {
            Some(cancellation) => cancellation,
            None => {
                let _ = take_cancellation(CoordinatedOperationKind::StartupScan);
                owned = StartupCancellation::scan();
                &owned
            }
        };
        let started = Instant::now();
        let platform_results = current_platform()
            .scan_startup_sources(cancellation, progress)
            .map_err(platform_scan_error)?;
        let session = catalog_session_from_results(
            platform_results,
            started.elapsed().as_millis() as u64,
        );
        let catalog = session.catalog.clone();
        self.store_session(session)?;
        Ok(catalog)
    }

    fn current_session(&self) -> CoreResult<StartupCatalogSession> {
        self.session
            .lock()
            .map_err(|_| CoreError::operation_failed("startup catalog session lock is poisoned"))?
            .clone()
            .ok_or_else(|| CoreError::invalid_input("startup catalog session is unavailable"))
    }

    fn store_session(&self, session: StartupCatalogSession) -> CoreResult<()> {
        let mut guard = self.session.lock().map_err(|_| {
            CoreError::operation_failed("startup catalog session lock is poisoned")
        })?;
        *guard = Some(session);
        Ok(())
    }

    fn replace_plan(&self, plan: PendingChangePlan) -> CoreResult<()> {
        let mut guard = self
            .pending_plan
            .lock()
            .map_err(|_| CoreError::operation_failed("startup change plan lock is poisoned"))?;
        *guard = Some(plan);
        Ok(())
    }

    fn take_plan(&self, plan_id: &str) -> CoreResult<PendingChangePlan> {
        let mut guard = self
            .pending_plan
            .lock()
            .map_err(|_| CoreError::operation_failed("startup change plan lock is poisoned"))?;
        let matches = guard
            .as_ref()
            .is_some_and(|plan| plan.public_plan.plan_id == plan_id);
        if !matches {
            return Err(CoreError::invalid_input(
                "startup change plan is unavailable or has been replaced",
            ));
        }
        guard
            .take()
            .ok_or_else(|| CoreError::invalid_input("startup change plan is unavailable"))
    }
}

fn catalog_session_from_results(
    platform_results: Vec<PlatformStartupSourceResult>,
    elapsed_ms: u64,
) -> StartupCatalogSession {
    let native_records = native_records(&platform_results);
    let aggregated = aggregation::aggregate(platform_results);
    let scanned_at_ms = unix_time_ms();
    let revision = aggregated.revision;
    let scan_id = format!(
        "startup-{}-{}-{}",
        scanned_at_ms,
        SCAN_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        revision.get(..16).unwrap_or(revision.as_str())
    );
    let catalog = StartupCatalog {
        schema_version: STARTUP_CATALOG_SCHEMA_VERSION,
        scan_id,
        catalog_revision: revision,
        scanned_at_ms,
        complete: aggregated.complete,
        artifacts: aggregated.artifacts,
        groups: aggregated.groups,
        coverage: aggregated.coverage,
        summary: aggregated.summary,
        elapsed_ms,
    };
    StartupCatalogSession {
        catalog,
        native_records,
    }
}

/// Captures the native facts authorized for each public item.
///
/// The catalog keeps the first observation of a duplicated provider identity, so
/// the retained record uses the same rule and always matches the artifact the
/// user selected.
fn native_records(
    platform_results: &[PlatformStartupSourceResult],
) -> BTreeMap<String, NativeStartupRecord> {
    let mut records = BTreeMap::new();
    for source in platform_results {
        for artifact in &source.items {
            let item_id =
                aggregation::public_item_id(&source.source_id, &artifact.provider_item_id);
            records
                .entry(item_id)
                .or_insert_with(|| NativeStartupRecord {
                    source_id: source.source_id.clone(),
                    artifact: artifact.clone(),
                });
        }
    }
    records
}

fn change_item_result(
    target: &PendingChangeTarget,
    result: PlatformResult<PlatformStartupChangeResult>,
) -> StartupChangeItemResult {
    match result {
        Ok(outcome) if outcome.verified => StartupChangeItemResult {
            item_id: target.item_id.clone(),
            status: if outcome.previous_state == outcome.configured_state {
                StartupChangeOutcomeStatus::Unchanged
            } else {
                StartupChangeOutcomeStatus::Changed
            },
            configured_state: outcome.configured_state.into(),
            verified: true,
            failure_reason: None,
        },
        Ok(outcome) => {
            log::warn!(
                "startup_change_item_unverified item_id={} source_id={} previous_state={:?} configured_state={:?}",
                target.item_id,
                target.request.source_id,
                outcome.previous_state,
                outcome.configured_state
            );
            StartupChangeItemResult {
                item_id: target.item_id.clone(),
                status: StartupChangeOutcomeStatus::Failed,
                configured_state: outcome.configured_state.into(),
                verified: false,
                failure_reason: Some(StartupChangeFailureReason::VerificationFailed),
            }
        }
        Err(error) => {
            log::warn!(
                "startup_change_item_failed item_id={} source_id={} desired_state={:?} expected_state={:?} reason={:?} mutation_state={:?} diagnostic={}",
                target.item_id,
                target.request.source_id,
                target.request.desired_state,
                target.request.expected_artifact.configured_state,
                error.code(),
                error.mutation_state(),
                error.diagnostic()
            );
            StartupChangeItemResult {
                item_id: target.item_id.clone(),
                status: StartupChangeOutcomeStatus::Failed,
                configured_state: target.request.expected_artifact.configured_state.into(),
                verified: false,
                failure_reason: Some(platform_failure_reason(error.code())),
            }
        }
    }
}

fn cancelled_item_result(target: &PendingChangeTarget) -> StartupChangeItemResult {
    StartupChangeItemResult {
        item_id: target.item_id.clone(),
        status: StartupChangeOutcomeStatus::Failed,
        configured_state: target.request.expected_artifact.configured_state.into(),
        verified: false,
        failure_reason: Some(StartupChangeFailureReason::UserCancelled),
    }
}

fn platform_failure_reason(code: PlatformErrorCode) -> StartupChangeFailureReason {
    match code {
        PlatformErrorCode::AccessDenied => StartupChangeFailureReason::PermissionDenied,
        PlatformErrorCode::UserCancelled => StartupChangeFailureReason::UserCancelled,
        PlatformErrorCode::ItemChanged => StartupChangeFailureReason::ItemChanged,
        PlatformErrorCode::Unsupported => StartupChangeFailureReason::Unsupported,
        _ => StartupChangeFailureReason::PlatformFailure,
    }
}

fn platform_scan_error(error: PlatformError) -> CoreError {
    let diagnostic = format!(
        "startup platform scan failed: {:?}: {}",
        error.code(),
        error.diagnostic()
    );
    match error.code() {
        PlatformErrorCode::AccessDenied => {
            CoreError::new(CoreErrorCode::PermissionDenied, diagnostic)
        }
        PlatformErrorCode::UserCancelled => CoreError::operation_cancelled(),
        _ => CoreError::new(CoreErrorCode::Platform, diagnostic),
    }
}

fn change_plan_id(
    catalog_revision: &str,
    desired_state: StartupDesiredState,
    items: &[StartupChangePlanItem],
    expires_at_ms: u64,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"systools-startup-change-plan-v1".as_slice());
    hasher.update(catalog_revision.as_bytes());
    hasher.update(format!("{desired_state:?}").as_bytes());
    hasher.update(&expires_at_ms.to_le_bytes());
    for item in items {
        hasher.update(&(item.item_id.len() as u64).to_le_bytes());
        hasher.update(item.item_id.as_bytes());
    }
    format!("startup-plan-{}", &hasher.finalize().to_hex()[..24])
}

fn validate_selection(selection: &StartupChangeSelection) -> CoreResult<()> {
    if selection.scan_id.is_empty() || selection.scan_id.len() > 128 {
        return Err(CoreError::invalid_input(
            "startup scan identifier is invalid",
        ));
    }
    if selection.item_ids.is_empty() || selection.item_ids.len() > MAX_CHANGE_ITEMS {
        return Err(CoreError::invalid_input(
            "startup change selection size is invalid",
        ));
    }
    if selection
        .item_ids
        .iter()
        .any(|item_id| item_id.len() != 64 || !item_id.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(CoreError::invalid_input(
            "startup item identifier is invalid",
        ));
    }
    Ok(())
}

fn validate_plan_id(plan_id: &str) -> CoreResult<()> {
    let digest = plan_id.strip_prefix("startup-plan-").unwrap_or_default();
    if digest.len() != 24 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CoreError::invalid_input(
            "startup change plan identifier is invalid",
        ));
    }
    Ok(())
}

fn deduplicated_item_ids(item_ids: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    item_ids
        .iter()
        .filter(|item_id| seen.insert((*item_id).clone()))
        .cloned()
        .collect()
}

fn skipped_item(
    item_id: String,
    display_name: &str,
    reason: StartupChangeSkipReason,
) -> StartupChangeSkippedItem {
    StartupChangeSkippedItem {
        item_id,
        display_name: display_name.to_owned(),
        reason,
    }
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

impl From<StartupDesiredState> for PlatformStartupDesiredState {
    fn from(value: StartupDesiredState) -> Self {
        match value {
            StartupDesiredState::Enabled => Self::Enabled,
            StartupDesiredState::Disabled => Self::Disabled,
            StartupDesiredState::Removed => Self::Removed,
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::startup::models::{StartupConfiguredState, StartupScope, StartupSourceKind};

    use super::*;

    fn selection(item_ids: Vec<String>) -> StartupChangeSelection {
        StartupChangeSelection {
            scan_id: "startup-1-1-0123456789abcdef".to_owned(),
            item_ids,
            desired_state: StartupDesiredState::Disabled,
        }
    }

    #[test]
    fn selection_rejects_untrusted_item_identifiers() {
        assert!(validate_selection(&selection(vec!["../../registry".to_owned()])).is_err());
        assert!(validate_selection(&selection(Vec::new())).is_err());
        assert!(validate_selection(&selection(vec!["a".repeat(63)])).is_err());
        assert!(validate_selection(&selection(vec!["a".repeat(64)])).is_ok());
    }

    #[test]
    fn plan_identifiers_must_match_the_generated_shape() {
        assert!(validate_plan_id("startup-plan-0123456789abcdef01234567").is_ok());
        assert!(validate_plan_id("startup-plan-short").is_err());
        assert!(validate_plan_id("0123456789abcdef01234567").is_err());
    }

    #[test]
    fn duplicate_selections_are_collapsed_in_order() {
        let ids = vec![
            "b".repeat(64),
            "a".repeat(64),
            "b".repeat(64),
        ];
        assert_eq!(
            deduplicated_item_ids(&ids),
            vec!["b".repeat(64), "a".repeat(64)]
        );
    }

    #[test]
    fn plan_identifier_is_deterministic_per_plan_content() {
        let item = StartupChangePlanItem {
            item_id: "a".repeat(64),
            display_name: "Fixture".to_owned(),
            source_kind: StartupSourceKind::RegistryRun,
            scope: StartupScope::CurrentUser,
            previous_state: StartupConfiguredState::Enabled,
            desired_state: StartupDesiredState::Disabled,
            warnings: Vec::new(),
            requires_elevation: false,
        };
        let first = change_plan_id(
            "revision",
            StartupDesiredState::Disabled,
            std::slice::from_ref(&item),
            1_000,
        );
        let second = change_plan_id(
            "revision",
            StartupDesiredState::Disabled,
            std::slice::from_ref(&item),
            1_000,
        );
        assert_eq!(first, second);
        assert!(first.starts_with("startup-plan-"));
        assert!(validate_plan_id(&first).is_ok());

        let mut other = item;
        other.item_id = "b".repeat(64);
        assert_ne!(
            first,
            change_plan_id(
                "revision",
                StartupDesiredState::Disabled,
                &[other],
                1_000
            )
        );
    }

    #[test]
    fn platform_failures_map_to_stable_reasons() {
        assert_eq!(
            platform_failure_reason(PlatformErrorCode::AccessDenied),
            StartupChangeFailureReason::PermissionDenied
        );
        assert_eq!(
            platform_failure_reason(PlatformErrorCode::UserCancelled),
            StartupChangeFailureReason::UserCancelled
        );
        assert_eq!(
            platform_failure_reason(PlatformErrorCode::ItemChanged),
            StartupChangeFailureReason::ItemChanged
        );
        assert_eq!(
            platform_failure_reason(PlatformErrorCode::Unsupported),
            StartupChangeFailureReason::Unsupported
        );
        assert_eq!(
            platform_failure_reason(PlatformErrorCode::Io),
            StartupChangeFailureReason::PlatformFailure
        );
    }
}
