//! Uninstall service orchestrating scan, plan preparation, and batch execution.
//!
//! Every command resolves application IDs through the cached catalog, verifies
//! the catalog revision the user reviewed, and revalidates component evidence
//! immediately before removing anything. Batch execution is isolated per
//! application: one application's failure never aborts the remaining ones, and
//! cancellation stops the batch between application boundaries.

use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::applications::catalog::{self, Catalog};
use crate::applications::contracts::{
    ApplicationProcessCloseMode, ApplicationUninstallExecutionOutcome,
    ApplicationUninstallPlatformError, ApplicationUninstallRegistrationState, Cancellation,
    InstalledApplication,
};
use crate::applications::leftovers::deletion;
use crate::applications::models::{
    ApplicationCloseBatchResult, ApplicationCloseMode, ApplicationCloseTargetResult,
    ApplicationCloseTargetStatus, ApplicationSystemKind, ApplicationUninstallActionReason,
    ApplicationUninstallActionResult, ApplicationUninstallActionStatus,
    ApplicationUninstallBatchPlan, ApplicationUninstallBatchPreparation,
    ApplicationUninstallBatchResult, ApplicationUninstallBatchSelection,
    ApplicationUninstallCapability, ApplicationUninstallCloseRequest,
    ApplicationUninstallCloseResponse, ApplicationUninstallComponentKind,
    ApplicationUninstallExecutionItemResult, ApplicationUninstallExecutionItemStatus,
    ApplicationUninstallExecutionProgress, ApplicationUninstallExecutionStage,
    ApplicationUninstallIdentity, ApplicationUninstallPlan, ApplicationUninstallPlanItem,
    ApplicationUninstallResult, ApplicationUninstallScanResult,
};
use crate::applications::progress::{ApplicationProgressSink, ApplicationScanProgressReporter};
use crate::applications::service_state;
use crate::applications::uninstall::{
    execution_history, identity, plan as uninstall_plan, preflight,
};
use crate::error::{SystoolsError, SystoolsResult};
use crate::platform::contracts::{PlatformError, PlatformErrorCode};
use crate::platform::windows::{native_uninstall, process_control, registration_removal};

/// Captures the catalog, stores it for later commands, and returns its scan.
pub(crate) fn scan(
    cancellation: &Cancellation,
    progress_sink: ApplicationProgressSink<'_>,
) -> SystoolsResult<ApplicationUninstallScanResult> {
    let progress = ApplicationScanProgressReporter::new(progress_sink);
    let catalog = capture(cancellation, &progress)?;
    let scan = catalog.scan.clone();
    service_state::store(catalog);
    Ok(scan)
}

/// Returns Windows version-resource metadata for one trusted application.
pub(crate) fn describe_identity(
    application_id: &str,
    catalog_revision: &str,
) -> SystoolsResult<ApplicationUninstallIdentity> {
    let catalog = catalog_for(application_id, catalog_revision)?;
    let application = catalog
        .application(application_id)
        .ok_or_else(|| SystoolsError::invalid_input("systools_uninstall_describe_identity"))?;
    Ok(identity::identity_for(application))
}

/// Closes the requested applications and recaptures the catalog.
pub(crate) fn close_applications(
    request: ApplicationUninstallCloseRequest,
    catalog_revision: &str,
) -> SystoolsResult<ApplicationUninstallCloseResponse> {
    if request.application_ids.is_empty()
        || request.application_ids.len() > uninstall_plan::MAX_BATCH_APPLICATIONS
    {
        return Err(SystoolsError::invalid_input(
            "systools_uninstall_close_applications",
        ));
    }
    let mut seen = Vec::with_capacity(request.application_ids.len());
    for id in &request.application_ids {
        if !uninstall_plan::is_application_id(id)
            || seen.iter().any(|existing| *existing == id.as_str())
        {
            return Err(SystoolsError::invalid_input(
                "systools_uninstall_close_applications",
            ));
        }
        seen.push(id.as_str());
    }
    let catalog = current_catalog(catalog_revision, false, "systools_uninstall_close_applications")?;
    let mut targets = Vec::with_capacity(request.application_ids.len());
    for id in &request.application_ids {
        let target = catalog
            .process_target(id)
            .filter(|target| {
                !target.executable_names.is_empty() || !target.executable_paths.is_empty()
            })
            .ok_or_else(|| {
                log::warn!(
                    "systools_uninstall_close_target_unavailable application_id={id}"
                );
                SystoolsError::invalid_input("systools_uninstall_close_applications")
            })?;
        targets.push(target);
    }

    let started = Instant::now();
    let mode = match request.mode {
        ApplicationCloseMode::Graceful => ApplicationProcessCloseMode::Graceful,
        ApplicationCloseMode::Force => ApplicationProcessCloseMode::Force,
    };
    let close_results = process_control::close_application_processes_many(&targets, mode);

    let mut target_results = Vec::with_capacity(close_results.len());
    let (mut matched, mut requested, mut remaining, mut failed_targets) = (0_u64, 0_u64, 0_u64, 0_u64);
    for (id, result) in request.application_ids.iter().zip(close_results) {
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                log::warn!(
                    "systools_uninstall_close_failed application_id={id} error={error}"
                );
                failed_targets = failed_targets.saturating_add(1);
                target_results.push(ApplicationCloseTargetResult {
                    target_id: id.clone(),
                    status: ApplicationCloseTargetStatus::Failed,
                    matched_process_count: 0,
                    requested_process_count: 0,
                    remaining_processes: Vec::new(),
                });
                continue;
            }
        };
        matched = matched.saturating_add(result.matched_process_count);
        requested = requested.saturating_add(result.requested_process_count);
        remaining = remaining.saturating_add(result.remaining_processes.len() as u64);
        let status = if result.remaining_processes.is_empty() {
            ApplicationCloseTargetStatus::Completed
        } else {
            failed_targets = failed_targets.saturating_add(1);
            ApplicationCloseTargetStatus::Failed
        };
        target_results.push(ApplicationCloseTargetResult {
            target_id: id.clone(),
            status,
            matched_process_count: result.matched_process_count,
            requested_process_count: result.requested_process_count,
            remaining_processes: result.remaining_processes,
        });
    }

    let close_result = ApplicationCloseBatchResult {
        mode: request.mode,
        matched_process_count: matched,
        requested_process_count: requested,
        remaining_process_count: remaining,
        failed_target_count: failed_targets,
        targets: target_results,
        elapsed_ms: elapsed_millis(started),
    };

    let silent_progress = |_: crate::applications::models::ApplicationScanProgress| {};
    let refresh_progress = ApplicationScanProgressReporter::new(&silent_progress);
    let scan = match catalog::capture(&Cancellation::new(), &refresh_progress) {
        Ok(refreshed) => {
            let scan = refreshed.scan.clone();
            service_state::store(refreshed);
            scan
        }
        Err(error) => {
            log::warn!(
                "systools_uninstall_catalog_refresh_failed error={error} closed_count={}",
                request.application_ids.len()
            );
            // The processes are closed even if the recapture failed. Report the
            // reviewed catalog without stale running evidence instead of a
            // catalog that still claims those processes exist.
            let mut scan = catalog.scan.clone();
            for id in &request.application_ids {
                if let Some(candidate) = scan
                    .candidates
                    .iter_mut()
                    .find(|candidate| &candidate.application_id == id)
                {
                    candidate.running_processes.clear();
                    if candidate.capability == ApplicationUninstallCapability::ApplicationRunning {
                        candidate.capability = ApplicationUninstallCapability::Ready;
                    }
                }
            }
            scan
        }
    };

    Ok(ApplicationUninstallCloseResponse {
        close_result,
        catalog: scan,
    })
}

/// Builds reviewed plans for every selection and a dry-run preview.
pub(crate) fn prepare_batch(
    selections: Vec<ApplicationUninstallBatchSelection>,
    catalog_revision: &str,
) -> SystoolsResult<ApplicationUninstallBatchPreparation> {
    if let Err(reason) = uninstall_plan::validate_batch_selections(&selections) {
        log::warn!("systools_uninstall_prepare_rejected reason={reason}");
        return Err(SystoolsError::invalid_input(
            "systools_uninstall_prepare_batch",
        ));
    }
    let catalog = current_catalog(catalog_revision, true, "systools_uninstall_prepare_batch")?;
    let created_at_ms = now_millis();
    let mut plans = Vec::with_capacity(selections.len());
    for selection in &selections {
        let candidate = catalog
            .candidate(&selection.application_id)
            .ok_or_else(|| {
                log::warn!(
                    "systools_uninstall_prepare_application_unavailable application_id={}",
                    selection.application_id
                );
                SystoolsError::invalid_input("systools_uninstall_prepare_batch")
            })?;
        let application = catalog
            .application(&selection.application_id)
            .ok_or_else(|| SystoolsError::invalid_input("systools_uninstall_prepare_batch"))?;
        match candidate.capability {
            ApplicationUninstallCapability::Ready
            | ApplicationUninstallCapability::RequiresElevation => {}
            ApplicationUninstallCapability::ApplicationRunning => {
                log::warn!(
                    "systools_uninstall_prepare_rejected reason=application_running application_id={}",
                    selection.application_id
                );
                return Err(SystoolsError::busy("systools_uninstall_prepare_batch"));
            }
            ApplicationUninstallCapability::ProtectedApplication
            | ApplicationUninstallCapability::ViewOnly => {
                log::warn!(
                    "systools_uninstall_prepare_rejected reason=unsupported application_id={}",
                    selection.application_id
                );
                return Err(SystoolsError::operation_failed(
                    "systools_uninstall_prepare_batch",
                ));
            }
        }
        if matches!(
            candidate.system_kind,
            ApplicationSystemKind::WindowsSystemPackage | ApplicationSystemKind::WindowsBuiltinApp
        ) {
            log::warn!(
                "systools_uninstall_prepare_rejected reason=protected_system_component application_id={}",
                selection.application_id
            );
            return Err(SystoolsError::operation_failed(
                "systools_uninstall_prepare_batch",
            ));
        }
        let plan = uninstall_plan::create_plan(
            application,
            candidate,
            &selection.component_ids,
            catalog_revision,
            created_at_ms,
        )
        .map_err(|reason| {
            log::warn!(
                "systools_uninstall_prepare_rejected reason={reason} application_id={}",
                selection.application_id
            );
            SystoolsError::invalid_input("systools_uninstall_prepare_batch")
        })?;
        plans.push(plan);
    }
    let batch = uninstall_plan::create_batch_plan(plans, catalog_revision, created_at_ms)
        .map_err(|reason| {
            log::warn!("systools_uninstall_prepare_rejected reason={reason}");
            SystoolsError::invalid_input("systools_uninstall_prepare_batch")
        })?;
    let previews = batch
        .plans
        .iter()
        .map(|plan| {
            preflight::preview(
                plan,
                catalog
                    .candidate(&plan.application_id)
                    .map(|candidate| candidate.name.clone()),
            )
        })
        .collect::<Vec<_>>();
    let preview = preflight::aggregate(&batch.batch_id, batch.expected_bytes, previews, true);
    Ok(ApplicationUninstallBatchPreparation {
        plan: batch,
        preview,
    })
}

/// Executes a reviewed batch. Individual application failures are reported in
/// the result; only a malformed plan makes the command itself fail.
pub(crate) fn execute_batch(
    app: &tauri::AppHandle,
    batch: ApplicationUninstallBatchPlan,
    dry_run: bool,
    authorization_prompt: &str,
) -> SystoolsResult<ApplicationUninstallBatchResult> {
    if let Err(reason) = uninstall_plan::validate_batch_plan(&batch) {
        log::warn!("systools_uninstall_execute_rejected reason={reason}");
        return Err(SystoolsError::invalid_input(
            "systools_uninstall_execute_batch",
        ));
    }
    let _ = authorization_prompt;
    let started = Instant::now();
    let started_at = execution_history::timestamp_rfc3339();
    let cancellation = service_state::begin_execution();
    let mut reporter =
        ProgressReporter::new(app, batch.plans.len(), started);
    reporter.emit(ApplicationUninstallExecutionStage::Validating, None);

    let catalog = service_state::current();
    let revision_matches = catalog
        .as_ref()
        .is_some_and(|catalog| catalog.revision == batch.catalog_revision);
    if !revision_matches {
        log::warn!(
            "systools_uninstall_catalog_changed expected_revision={} actual_revision={:?}",
            batch.catalog_revision,
            catalog.as_ref().map(|catalog| catalog.revision.as_str())
        );
        let mut results = batch
            .plans
            .iter()
            .map(|plan| {
                preflight::fail_all(
                    plan,
                    catalog
                        .as_ref()
                        .and_then(|catalog| catalog.candidate(&plan.application_id))
                        .map(|candidate| candidate.name.clone()),
                    ApplicationUninstallActionReason::CatalogChanged,
                )
            })
            .collect::<Vec<_>>();
        for result in &mut results {
            result.dry_run = dry_run;
        }
        reporter.emit(ApplicationUninstallExecutionStage::Finalizing, None);
        return Ok(preflight::aggregate(
            &batch.batch_id,
            batch.expected_bytes,
            results,
            dry_run,
        ));
    }
    let catalog = catalog.expect("revision match requires a cached catalog");

    let mut results = Vec::with_capacity(batch.plans.len());
    for plan in &batch.plans {
        let name = catalog
            .candidate(&plan.application_id)
            .map(|candidate| candidate.name.clone());
        if cancellation.is_cancelled() {
            let result = preflight::cancel_all(plan, name);
            reporter.record(&result);
            reporter.emit(ApplicationUninstallExecutionStage::Uninstalling, None);
            results.push(result);
            continue;
        }

        let Some(application) = catalog.application(&plan.application_id) else {
            let result = preflight::fail_all(
                plan,
                name,
                ApplicationUninstallActionReason::ApplicationUnavailable,
            );
            reporter.record(&result);
            reporter.emit(ApplicationUninstallExecutionStage::Uninstalling, None);
            results.push(result);
            continue;
        };
        let Some(candidate) = catalog.candidate(&plan.application_id) else {
            let result = preflight::fail_all(
                plan,
                name,
                ApplicationUninstallActionReason::ApplicationUnavailable,
            );
            reporter.record(&result);
            reporter.emit(ApplicationUninstallExecutionStage::Uninstalling, None);
            results.push(result);
            continue;
        };

        if let Some(reason) = capability_reason(candidate.capability) {
            let result = preflight::fail_all(plan, name, reason);
            reporter.record(&result);
            reporter.emit(ApplicationUninstallExecutionStage::Uninstalling, None);
            results.push(result);
            continue;
        }

        if let Some((_, Some(reason))) = preflight::compare(plan, application, candidate)
            .into_iter()
            .find(|(_, reason)| reason.is_some())
        {
            let result = preflight::fail_all(plan, name, reason);
            reporter.record(&result);
            reporter.emit(ApplicationUninstallExecutionStage::Uninstalling, None);
            results.push(result);
            continue;
        }

        if let Some(target) = catalog.process_target(&plan.application_id) {
            match process_control::process_is_running(&target) {
                Ok(false) => {}
                Ok(true) => {
                    let result = preflight::fail_all(
                        plan,
                        name,
                        ApplicationUninstallActionReason::ApplicationRunning,
                    );
                    reporter.record(&result);
                    reporter.emit(ApplicationUninstallExecutionStage::Uninstalling, None);
                    results.push(result);
                    continue;
                }
                Err(error) => {
                    log::warn!(
                        "systools_uninstall_process_state_unavailable application_id={} error={error}",
                        plan.application_id
                    );
                    let result = preflight::fail_all(
                        plan,
                        name,
                        ApplicationUninstallActionReason::ProcessStateUnavailable,
                    );
                    reporter.record(&result);
                    reporter.emit(ApplicationUninstallExecutionStage::Uninstalling, None);
                    results.push(result);
                    continue;
                }
            }
        }

        if dry_run {
            let result = preflight::preview(plan, name);
            reporter.record(&result);
            results.push(result);
            continue;
        }

        reporter.emit(
            ApplicationUninstallExecutionStage::Uninstalling,
            Some(plan.application_id.clone()),
        );
        let result = execute_one(plan, application, candidate, name);
        reporter.record(&result);
        reporter.emit(ApplicationUninstallExecutionStage::Uninstalling, None);
        results.push(result);
    }

    // A dry-run must never be reported as an executed batch, including for
    // applications that failed preflight before the preview branch.
    for result in &mut results {
        result.dry_run = dry_run;
    }

    let mut history_saved = false;
    if !dry_run {
        let record = history_record(&batch, &results, &started_at, started);
        match execution_history::append(&record) {
            Ok(()) => history_saved = true,
            Err(error) => log::warn!("systools_uninstall_history_not_saved error={error}"),
        }
    }
    if history_saved {
        for result in &mut results {
            result.history_saved = true;
        }
    }

    reporter.emit(ApplicationUninstallExecutionStage::Finalizing, None);
    Ok(preflight::aggregate(
        &batch.batch_id,
        batch.expected_bytes,
        results,
        dry_run,
    ))
}

/// Removes the registry record of an application whose install is already gone.
pub(crate) fn remove_record(application_id: &str) -> SystoolsResult<()> {
    if !uninstall_plan::is_application_id(application_id) {
        return Err(SystoolsError::invalid_input(
            "systools_uninstall_remove_record",
        ));
    }
    let catalog = service_state::current().ok_or_else(|| {
        SystoolsError::invalid_input("systools_uninstall_remove_record")
    })?;
    let application = catalog.application(application_id).ok_or_else(|| {
        SystoolsError::invalid_input("systools_uninstall_remove_record")
    })?;
    let candidate = catalog.candidate(application_id).ok_or_else(|| {
        SystoolsError::invalid_input("systools_uninstall_remove_record")
    })?;
    if candidate.record_state
        != crate::applications::models::ApplicationUninstallRecordState::OrphanedRegistration
    {
        log::warn!(
            "systools_uninstall_remove_record_rejected reason=registration_in_use application_id={application_id}"
        );
        return Err(SystoolsError::invalid_input(
            "systools_uninstall_remove_record",
        ));
    }
    if application.uninstall_registration.is_none() {
        return Err(SystoolsError::invalid_input(
            "systools_uninstall_remove_record",
        ));
    }
    registration_removal::remove_record(application, false)
        .map_err(|error| platform_error("systools_uninstall_remove_record", error))?;
    // The cached catalog now describes a record that no longer exists.
    service_state::clear();
    Ok(())
}

/// Executes one application's plan after preflight succeeded.
fn execute_one(
    plan: &ApplicationUninstallPlan,
    application: &InstalledApplication,
    candidate: &crate::applications::models::ApplicationUninstallCandidate,
    name: Option<String>,
) -> ApplicationUninstallResult {
    let Some(registration) = application.uninstall_registration.as_ref() else {
        return preflight::fail_all(
            plan,
            name,
            ApplicationUninstallActionReason::UnsupportedExecutor,
        );
    };
    let outcome = match native_uninstall::execute_registration(registration) {
        Ok(outcome) => outcome,
        Err(ApplicationUninstallPlatformError::UserCancelled) => {
            log::info!(
                "systools_uninstall_cancelled application_id={} stage=native",
                plan.application_id
            );
            return preflight::cancel_all(plan, name);
        }
        Err(error) => {
            log::warn!(
                "systools_uninstall_native_failed application_id={} code={} native_code={:?}",
                plan.application_id,
                error.stable_code(),
                error.native_code()
            );
            return preflight::fail_all(plan, name, platform_reason(error));
        }
    };

    // The vendor process ended; the exact registration must now be absent.
    match native_uninstall::registration_state(registration) {
        Ok(ApplicationUninstallRegistrationState::Absent) => {}
        Ok(state) => {
            log::warn!(
                "systools_uninstall_removal_unconfirmed application_id={} state={state:?}",
                plan.application_id
            );
            return preflight::fail_all(
                plan,
                name,
                ApplicationUninstallActionReason::RemovalUnconfirmed,
            );
        }
        Err(error) => {
            log::warn!(
                "systools_uninstall_removal_unconfirmed application_id={} code={}",
                plan.application_id,
                error.stable_code()
            );
            return preflight::fail_all(
                plan,
                name,
                ApplicationUninstallActionReason::RemovalUnconfirmed,
            );
        }
    }

    let restart_required = outcome == ApplicationUninstallExecutionOutcome::RestartRequired;
    let actions = plan
        .items
        .iter()
        .map(|item| match item.kind {
            ApplicationUninstallComponentKind::NativeInstaller => {
                ApplicationUninstallActionResult {
                    component_id: item.component_id.clone(),
                    kind: item.kind,
                    status: ApplicationUninstallActionStatus::Completed,
                    reason: None,
                    expected_bytes: item.expected_bytes,
                    released_bytes: item.expected_bytes,
                }
            }
            ApplicationUninstallComponentKind::ApplicationSupport
            | ApplicationUninstallComponentKind::Cache => {
                delete_component(plan, candidate, item)
            }
            _ => preflight::failed_action(
                item,
                ApplicationUninstallActionReason::UnsupportedExecutor,
            ),
        })
        .collect::<Vec<_>>();
    preflight::result_from_actions(plan, name, actions, false, restart_required)
}

/// Deletes one selected non-required component and verifies it is gone.
fn delete_component(
    plan: &ApplicationUninstallPlan,
    candidate: &crate::applications::models::ApplicationUninstallCandidate,
    item: &ApplicationUninstallPlanItem,
) -> ApplicationUninstallActionResult {
    let path = candidate
        .components
        .iter()
        .find(|component| component.component_id == item.component_id)
        .and_then(|component| component.path.as_deref())
        .map(PathBuf::from);
    let Some(path) = path else {
        log::warn!(
            "systools_uninstall_component_unavailable application_id={} component_id={}",
            plan.application_id,
            item.component_id
        );
        return preflight::failed_action(
            item,
            ApplicationUninstallActionReason::PermanentDeleteFailed,
        );
    };
    // The vendor uninstaller often removes associated data itself. A path that
    // disappeared during its run is already gone, not a failed deletion.
    if !path.exists() {
        log::info!(
            "systools_uninstall_component_already_removed application_id={} component_id={}",
            plan.application_id,
            item.component_id
        );
        return ApplicationUninstallActionResult {
            component_id: item.component_id.clone(),
            kind: item.kind,
            status: ApplicationUninstallActionStatus::Completed,
            reason: None,
            expected_bytes: item.expected_bytes,
            released_bytes: 0,
        };
    }
    let deleted = deletion::delete_paths(std::slice::from_ref(&path), false);
    match deleted.into_iter().next() {
        Some(Ok(bytes)) if !path.exists() => ApplicationUninstallActionResult {
            component_id: item.component_id.clone(),
            kind: item.kind,
            status: ApplicationUninstallActionStatus::Completed,
            reason: None,
            expected_bytes: item.expected_bytes,
            released_bytes: bytes,
        },
        Some(Ok(_)) => {
            log::warn!(
                "systools_uninstall_component_survived application_id={} path={}",
                plan.application_id,
                path.display()
            );
            preflight::failed_action(
                item,
                ApplicationUninstallActionReason::PermanentDeleteFailed,
            )
        }
        Some(Err((failed_path, error))) => {
            log::warn!(
                "systools_uninstall_component_delete_failed application_id={} path={} error={error}",
                plan.application_id,
                failed_path.display()
            );
            preflight::failed_action(
                item,
                ApplicationUninstallActionReason::PermanentDeleteFailed,
            )
        }
        None => preflight::failed_action(
            item,
            ApplicationUninstallActionReason::PermanentDeleteFailed,
        ),
    }
}

fn history_record(
    batch: &ApplicationUninstallBatchPlan,
    results: &[ApplicationUninstallResult],
    started_at: &str,
    started: Instant,
) -> serde_json::Value {
    let affected = results.iter().filter(|result| result.affected_item_count > 0).count() as u64;
    let failed = results.iter().filter(|result| result.failed_item_count > 0).count() as u64;
    let cancelled = results
        .iter()
        .filter(|result| {
            result.actions.iter().any(|action| {
                action.status == ApplicationUninstallActionStatus::Cancelled
            })
        })
        .count() as u64;
    let outcome = if failed > 0 && affected > 0 {
        "completedWithWarnings"
    } else if failed > 0 {
        "failed"
    } else if cancelled > 0 {
        "cancelled"
    } else {
        "completed"
    };
    let applications = results
        .iter()
        .map(|result| {
            let status = if result.failed_item_count > 0 {
                "failed"
            } else if result
                .actions
                .iter()
                .any(|action| action.status == ApplicationUninstallActionStatus::Cancelled)
            {
                "cancelled"
            } else {
                "completed"
            };
            let reasons = result
                .actions
                .iter()
                .filter_map(|action| action.reason)
                .map(reason_code)
                .collect::<Vec<_>>();
            serde_json::json!({
                "applicationId": result.application_id,
                "applicationName": result.application_name,
                "status": status,
                "releasedBytes": result.released_bytes,
                "reasons": reasons,
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "id": batch.batch_id,
        "category": "applicationUninstall",
        "outcome": outcome,
        "startedAt": started_at,
        "finishedAt": execution_history::timestamp_rfc3339(),
        "elapsedMs": elapsed_millis(started),
        "catalogRevision": batch.catalog_revision,
        "dryRun": false,
        "restartRequired": results.iter().any(|result| result.restart_required),
        "selectedApplicationCount": results.len() as u64,
        "affectedApplicationCount": affected,
        "failedApplicationCount": failed,
        "releasedBytes": results
            .iter()
            .fold(0_u64, |total, result| total.saturating_add(result.released_bytes)),
        "applications": applications,
    })
}

fn reason_code(reason: ApplicationUninstallActionReason) -> &'static str {
    match reason {
        ApplicationUninstallActionReason::ApplicationUnavailable => "applicationUnavailable",
        ApplicationUninstallActionReason::ApplicationRunning => "applicationRunning",
        ApplicationUninstallActionReason::ProcessStateUnavailable => "processStateUnavailable",
        ApplicationUninstallActionReason::CatalogChanged => "catalogChanged",
        ApplicationUninstallActionReason::ComponentUnavailable => "componentUnavailable",
        ApplicationUninstallActionReason::ComponentChanged => "componentChanged",
        ApplicationUninstallActionReason::UnsupportedExecutor => "unsupportedExecutor",
        ApplicationUninstallActionReason::ExecutionAborted => "executionAborted",
        ApplicationUninstallActionReason::ExternalUninstallerContinuing => {
            "externalUninstallerContinuing"
        }
        ApplicationUninstallActionReason::PermanentDeleteFailed => "permanentDeleteFailed",
        ApplicationUninstallActionReason::RecoveryRequired => "recoveryRequired",
        ApplicationUninstallActionReason::NativeInstallerFailed => "nativeInstallerFailed",
        ApplicationUninstallActionReason::RemovalUnconfirmed => "removalUnconfirmed",
        ApplicationUninstallActionReason::NativeInstallerFailedAfterRemoval => {
            "nativeInstallerFailedAfterRemoval"
        }
        ApplicationUninstallActionReason::VerificationFailed => "verificationFailed",
    }
}

const fn capability_reason(
    capability: ApplicationUninstallCapability,
) -> Option<ApplicationUninstallActionReason> {
    match capability {
        ApplicationUninstallCapability::Ready
        | ApplicationUninstallCapability::RequiresElevation => None,
        ApplicationUninstallCapability::ApplicationRunning => {
            Some(ApplicationUninstallActionReason::ApplicationRunning)
        }
        ApplicationUninstallCapability::ProtectedApplication
        | ApplicationUninstallCapability::ViewOnly => {
            Some(ApplicationUninstallActionReason::UnsupportedExecutor)
        }
    }
}

fn platform_reason(
    error: ApplicationUninstallPlatformError,
) -> ApplicationUninstallActionReason {
    match error {
        ApplicationUninstallPlatformError::UserCancelled => {
            ApplicationUninstallActionReason::NativeInstallerFailed
        }
        ApplicationUninstallPlatformError::RegistrationChanged => {
            ApplicationUninstallActionReason::ComponentChanged
        }
        ApplicationUninstallPlatformError::RemovalUnconfirmed => {
            ApplicationUninstallActionReason::RemovalUnconfirmed
        }
        ApplicationUninstallPlatformError::NativeFailureAfterRemoval(_) => {
            ApplicationUninstallActionReason::NativeInstallerFailedAfterRemoval
        }
        ApplicationUninstallPlatformError::LaunchUnconfirmed(_) => {
            ApplicationUninstallActionReason::RecoveryRequired
        }
        ApplicationUninstallPlatformError::NativeFailure(_)
        | ApplicationUninstallPlatformError::RequiresElevation => {
            ApplicationUninstallActionReason::NativeInstallerFailed
        }
        ApplicationUninstallPlatformError::Unsupported => {
            ApplicationUninstallActionReason::UnsupportedExecutor
        }
    }
}

fn platform_error(operation: &'static str, error: PlatformError) -> SystoolsError {
    log::warn!(
        "systools_platform_error operation={operation} code={:?} diagnostic={}",
        error.code(),
        error.diagnostic()
    );
    match error.code() {
        PlatformErrorCode::AccessDenied => SystoolsError::permission_denied(operation),
        PlatformErrorCode::UserCancelled => SystoolsError::cancelled(),
        PlatformErrorCode::InvalidData | PlatformErrorCode::InvalidPath => {
            SystoolsError::invalid_input(operation)
        }
        PlatformErrorCode::Unsupported => SystoolsError::operation_failed(operation),
        PlatformErrorCode::ItemChanged
        | PlatformErrorCode::Io
        | PlatformErrorCode::OperationFailed => SystoolsError::operation_failed(operation),
    }
}

fn capture(
    cancellation: &Cancellation,
    progress: &ApplicationScanProgressReporter<'_>,
) -> SystoolsResult<Catalog> {
    catalog::capture(cancellation, progress).map_err(|error| {
        if cancellation.is_cancelled() || error == "windows_application_catalog_cancelled" {
            SystoolsError::cancelled()
        } else {
            log::warn!("systools_uninstall_scan_failed error={error}");
            SystoolsError::operation_failed("systools_uninstall_scan")
        }
    })
}

fn current_catalog(
    catalog_revision: &str,
    require_actionable: bool,
    operation: &'static str,
) -> SystoolsResult<std::sync::Arc<Catalog>> {
    let catalog =
        service_state::current().ok_or_else(|| SystoolsError::invalid_input(operation))?;
    if catalog.revision != catalog_revision {
        log::warn!(
            "systools_uninstall_catalog_revision_mismatch expected={catalog_revision} actual={}",
            catalog.revision
        );
        return Err(SystoolsError::invalid_input(operation));
    }
    if require_actionable && !catalog.scan.catalog_actionable {
        log::warn!("systools_uninstall_catalog_not_actionable");
        return Err(SystoolsError::busy(operation));
    }
    Ok(catalog)
}

/// Resolves an application ID through the cached catalog for inspection.
fn catalog_for(
    application_id: &str,
    catalog_revision: &str,
) -> SystoolsResult<std::sync::Arc<Catalog>> {
    if !uninstall_plan::is_application_id(application_id) {
        return Err(SystoolsError::invalid_input(
            "systools_uninstall_describe_identity",
        ));
    }
    let catalog = current_catalog(
        catalog_revision,
        false,
        "systools_uninstall_describe_identity",
    )?;
    if catalog.candidate(application_id).is_none() {
        return Err(SystoolsError::invalid_input(
            "systools_uninstall_describe_identity",
        ));
    }
    Ok(catalog)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

fn elapsed_millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Emits low-frequency progress exactly at application boundaries.
struct ProgressReporter<'a> {
    app: &'a tauri::AppHandle,
    started: Instant,
    total: usize,
    completed: Vec<ApplicationUninstallExecutionItemResult>,
}

impl<'a> ProgressReporter<'a> {
    fn new(app: &'a tauri::AppHandle, total: usize, started: Instant) -> Self {
        Self {
            app,
            started,
            total,
            completed: Vec::with_capacity(total),
        }
    }

    fn record(&mut self, result: &ApplicationUninstallResult) {
        let status = if result.failed_item_count > 0 {
            ApplicationUninstallExecutionItemStatus::Failed
        } else if result
            .actions
            .iter()
            .any(|action| action.status == ApplicationUninstallActionStatus::Cancelled)
        {
            ApplicationUninstallExecutionItemStatus::Cancelled
        } else {
            ApplicationUninstallExecutionItemStatus::Completed
        };
        self.completed.push(ApplicationUninstallExecutionItemResult {
            application_id: result.application_id.clone(),
            status,
            released_bytes: result.released_bytes,
        });
    }

    fn emit(
        &self,
        stage: ApplicationUninstallExecutionStage,
        current_application_id: Option<String>,
    ) {
        let released_bytes = self
            .completed
            .iter()
            .fold(0_u64, |total, item| total.saturating_add(item.released_bytes));
        let failed_application_count = self
            .completed
            .iter()
            .filter(|item| item.status == ApplicationUninstallExecutionItemStatus::Failed)
            .count() as u64;
        let affected_application_count = self
            .completed
            .iter()
            .filter(|item| {
                item.status == ApplicationUninstallExecutionItemStatus::Completed
                    && item.released_bytes > 0
            })
            .count() as u64;
        crate::events::emit(
            self.app,
            crate::events::UNINSTALL_EXECUTION_PROGRESS,
            ApplicationUninstallExecutionProgress {
                stage,
                current_application_id,
                completed_applications: self.completed.clone(),
                completed_application_count: self.completed.len() as u64,
                total_application_count: self.total as u64,
                affected_application_count,
                failed_application_count,
                released_bytes,
                elapsed_ms: elapsed_millis(self.started),
            },
        );
    }
}
