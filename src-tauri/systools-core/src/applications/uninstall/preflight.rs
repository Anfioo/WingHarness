//! Preflight comparison and result aggregation for uninstall batches.
//!
//! Preflight re-derives each selected component's snapshot immediately before
//! execution. A component that disappeared or changed since review is reported
//! with a stable reason instead of being removed. Result aggregation turns
//! per-application results into the batch summary the UI renders.

use crate::applications::contracts::InstalledApplication;
use crate::applications::models::{
    ApplicationUninstallActionReason, ApplicationUninstallActionResult,
    ApplicationUninstallActionStatus, ApplicationUninstallBatchResult,
    ApplicationUninstallCandidate, ApplicationUninstallComponent,
    ApplicationUninstallPlan, ApplicationUninstallPlanItem, ApplicationUninstallResult,
};

/// One component's revalidation outcome. `None` means the evidence still
/// matches the reviewed plan.
pub(crate) type PreflightIssue = (String, Option<ApplicationUninstallActionReason>);

/// Recomputes the selected components and compares them with the plan.
pub(crate) fn compare(
    plan: &ApplicationUninstallPlan,
    application: &InstalledApplication,
    candidate: &ApplicationUninstallCandidate,
) -> Vec<PreflightIssue> {
    plan.items
        .iter()
        .map(|item| {
            let component = candidate
                .components
                .iter()
                .find(|component| component.component_id == item.component_id);
            let Some(component) = component else {
                return (item.component_id.clone(), Some(ApplicationUninstallActionReason::ComponentUnavailable));
            };
            match super::plan::component_snapshot(application, component) {
                Ok(snapshot) => (
                    item.component_id.clone(),
                    compare_snapshot(item, &snapshot),
                ),
                Err(_) => (
                    item.component_id.clone(),
                    Some(ApplicationUninstallActionReason::ComponentUnavailable),
                ),
            }
        })
        .collect()
}

fn compare_snapshot(
    item: &ApplicationUninstallPlanItem,
    snapshot: &ApplicationUninstallComponent,
) -> Option<ApplicationUninstallActionReason> {
    if item.kind != snapshot.kind
        || item.expected_bytes != snapshot.bytes
        || item.expected_file_count != snapshot.file_count
        || item.expected_snapshot_fingerprint != snapshot.snapshot_fingerprint
    {
        return Some(ApplicationUninstallActionReason::ComponentChanged);
    }
    None
}

/// Builds the dry-run preview: every selected component is reported as
/// previewed with its estimated bytes.
pub(crate) fn preview(
    plan: &ApplicationUninstallPlan,
    application_name: Option<String>,
) -> ApplicationUninstallResult {
    let actions = plan
        .items
        .iter()
        .map(|item| ApplicationUninstallActionResult {
            component_id: item.component_id.clone(),
            kind: item.kind,
            status: ApplicationUninstallActionStatus::Previewed,
            reason: None,
            expected_bytes: item.expected_bytes,
            released_bytes: item.expected_bytes,
        })
        .collect::<Vec<_>>();
    result_from_actions_inner(plan, application_name, actions, true, false)
}

/// Marks every item of one application as failed with the same reason.
pub(crate) fn fail_all(
    plan: &ApplicationUninstallPlan,
    application_name: Option<String>,
    reason: ApplicationUninstallActionReason,
) -> ApplicationUninstallResult {
    let actions = plan
        .items
        .iter()
        .map(|item| failed_action(item, reason))
        .collect::<Vec<_>>();
    result_from_actions_inner(plan, application_name, actions, false, false)
}

/// Marks every item of one application as cancelled. Cancellation is not a
/// failure: the user stopped the batch and nothing else was attempted.
pub(crate) fn cancel_all(
    plan: &ApplicationUninstallPlan,
    application_name: Option<String>,
) -> ApplicationUninstallResult {
    let actions = plan
        .items
        .iter()
        .map(|item| ApplicationUninstallActionResult {
            component_id: item.component_id.clone(),
            kind: item.kind,
            status: ApplicationUninstallActionStatus::Cancelled,
            reason: None,
            expected_bytes: item.expected_bytes,
            released_bytes: 0,
        })
        .collect::<Vec<_>>();
    result_from_actions_inner(plan, application_name, actions, false, false)
}

/// One failed action for a component that was never touched.
pub(crate) fn failed_action(
    item: &ApplicationUninstallPlanItem,
    reason: ApplicationUninstallActionReason,
) -> ApplicationUninstallActionResult {
    ApplicationUninstallActionResult {
        component_id: item.component_id.clone(),
        kind: item.kind,
        status: ApplicationUninstallActionStatus::Failed,
        reason: Some(reason),
        expected_bytes: item.expected_bytes,
        released_bytes: 0,
    }
}

/// Builds a result from already classified actions.
pub(crate) fn result_from_actions(
    plan: &ApplicationUninstallPlan,
    application_name: Option<String>,
    actions: Vec<ApplicationUninstallActionResult>,
    dry_run: bool,
    restart_required: bool,
) -> ApplicationUninstallResult {
    result_from_actions_inner(plan, application_name, actions, dry_run, restart_required)
}

fn result_from_actions_inner(
    plan: &ApplicationUninstallPlan,
    application_name: Option<String>,
    actions: Vec<ApplicationUninstallActionResult>,
    dry_run: bool,
    restart_required: bool,
) -> ApplicationUninstallResult {
    let previewed_item_count = actions
        .iter()
        .filter(|action| action.status == ApplicationUninstallActionStatus::Previewed)
        .count() as u64;
    let affected_item_count = actions
        .iter()
        .filter(|action| action.status == ApplicationUninstallActionStatus::Completed)
        .count() as u64;
    let failed_item_count = actions
        .iter()
        .filter(|action| action.status == ApplicationUninstallActionStatus::Failed)
        .count() as u64;
    let released_bytes = actions
        .iter()
        .fold(0_u64, |total, action| total.saturating_add(action.released_bytes));
    let previewed_bytes = actions
        .iter()
        .filter(|action| action.status == ApplicationUninstallActionStatus::Previewed)
        .fold(0_u64, |total, action| total.saturating_add(action.expected_bytes));
    ApplicationUninstallResult {
        plan_id: plan.plan_id.clone(),
        application_id: plan.application_id.clone(),
        application_name,
        expected_bytes: plan.expected_bytes,
        previewed_bytes,
        released_bytes,
        previewed_item_count,
        affected_item_count,
        failed_item_count,
        released_bytes_is_estimate: true,
        restart_required,
        dry_run,
        actions,
        history_saved: false,
    }
}

/// Aggregates per-application results into the batch result the UI renders.
pub(crate) fn aggregate(
    batch_id: &str,
    expected_bytes: u64,
    results: Vec<ApplicationUninstallResult>,
    dry_run: bool,
) -> ApplicationUninstallBatchResult {
    let sum = |values: &mut dyn Iterator<Item = u64>| {
        values.fold(0_u64, |total, value| total.saturating_add(value))
    };
    let previewed_application_count = results
        .iter()
        .filter(|result| {
            !result.actions.is_empty()
                && result
                    .actions
                    .iter()
                    .all(|action| action.status == ApplicationUninstallActionStatus::Previewed)
        })
        .count() as u64;
    let affected_application_count = results
        .iter()
        .filter(|result| result.affected_item_count > 0)
        .count() as u64;
    let failed_application_count = results
        .iter()
        .filter(|result| result.failed_item_count > 0)
        .count() as u64;
    ApplicationUninstallBatchResult {
        batch_id: batch_id.to_string(),
        expected_bytes,
        previewed_bytes: sum(&mut results.iter().map(|result| result.previewed_bytes)),
        released_bytes: sum(&mut results.iter().map(|result| result.released_bytes)),
        selected_application_count: results.len() as u64,
        previewed_application_count,
        affected_application_count,
        failed_application_count,
        previewed_item_count: sum(&mut results.iter().map(|result| result.previewed_item_count)),
        affected_item_count: sum(&mut results.iter().map(|result| result.affected_item_count)),
        failed_item_count: sum(&mut results.iter().map(|result| result.failed_item_count)),
        released_bytes_is_estimate: true,
        restart_required: results.iter().any(|result| result.restart_required),
        dry_run,
        results,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::models::{
        ApplicationUninstallComponentKind, APPLICATION_UNINSTALL_PLAN_SCHEMA_VERSION,
    };

    fn plan(items: Vec<ApplicationUninstallPlanItem>) -> ApplicationUninstallPlan {
        let expected_bytes = items
            .iter()
            .fold(0_u64, |total, item| total.saturating_add(item.expected_bytes));
        let mut plan = ApplicationUninstallPlan {
            schema_version: APPLICATION_UNINSTALL_PLAN_SCHEMA_VERSION,
            plan_id: format!("plan-{}", "a".repeat(32)),
            plan_hash: "b".repeat(64),
            created_at_ms: 1,
            application_id: format!("application-{}", "c".repeat(24)),
            catalog_revision: "revision".into(),
            items,
            expected_bytes,
        };
        plan.plan_hash = super::super::plan::plan_hash(&plan);
        plan
    }

    fn item(id: &str, bytes: u64) -> ApplicationUninstallPlanItem {
        ApplicationUninstallPlanItem {
            component_id: id.into(),
            kind: ApplicationUninstallComponentKind::NativeInstaller,
            expected_bytes: bytes,
            expected_file_count: 1,
            expected_snapshot_fingerprint: "d".repeat(64),
        }
    }

    #[test]
    fn preview_marks_every_item_without_mutation() {
        let plan = plan(vec![item("component-a", 10), item("component-b", 20)]);
        let result = preview(&plan, Some("Example".into()));
        assert!(result.dry_run);
        assert_eq!(result.previewed_item_count, 2);
        assert_eq!(result.affected_item_count, 0);
        assert_eq!(result.previewed_bytes, 30);
        assert_eq!(result.released_bytes, 30);
        assert!(!result.history_saved);
    }

    #[test]
    fn failure_and_cancellation_report_no_released_bytes() {
        let plan = plan(vec![item("component-a", 10)]);
        let failed = fail_all(
            &plan,
            None,
            ApplicationUninstallActionReason::ApplicationRunning,
        );
        assert_eq!(failed.failed_item_count, 1);
        assert_eq!(failed.released_bytes, 0);
        assert_eq!(
            failed.actions[0].reason,
            Some(ApplicationUninstallActionReason::ApplicationRunning)
        );
        let cancelled = cancel_all(&plan, None);
        assert_eq!(cancelled.failed_item_count, 0);
        assert_eq!(cancelled.actions[0].status, ApplicationUninstallActionStatus::Cancelled);
    }

    #[test]
    fn aggregate_counts_isolate_failed_applications() {
        let first = plan(vec![item("component-a", 10)]);
        let second = plan(vec![item("component-b", 20)]);
        let results = vec![
            preview(&first, None),
            fail_all(
                &second,
                None,
                ApplicationUninstallActionReason::ApplicationUnavailable,
            ),
        ];
        let batch = aggregate("batch-x", 30, results, false);
        assert_eq!(batch.selected_application_count, 2);
        assert_eq!(batch.previewed_application_count, 1);
        assert_eq!(batch.failed_application_count, 1);
        assert_eq!(batch.affected_application_count, 0);
        assert_eq!(batch.expected_bytes, 30);
    }
}
