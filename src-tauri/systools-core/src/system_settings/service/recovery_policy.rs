//! Recovery policy for system-settings changes.
//!
//! The policy decides which durable baselines are still trustworthy, which
//! value a target state resolves to, and which ledger entries survive a batch.
//! Everything here is side-effect free so the decisions can be regression
//! tested without reading or changing real settings.

use std::collections::{BTreeMap, BTreeSet};

use super::recovery::{RecoveryDocument, RecoveryItem};
use super::{CatalogNativeItem, PendingChangeItem};

use crate::system_settings::{
    models::{
        SystemSettingChangeItemResult, SystemSettingChangeOutcomeStatus, SystemSettingStatus,
        SystemSettingTargetState,
    },
    platform::PlatformSystemSettingValue,
};

pub(super) fn recovery_items_by_id(
    document: Option<&RecoveryDocument>,
) -> BTreeMap<String, RecoveryItem> {
    document
        .into_iter()
        .flat_map(|document| document.items.iter().cloned())
        .map(|item| (item.setting_id.clone(), item))
        .collect()
}

/// A baseline is valid only when the native value still matches the optimized
/// value recorded before the change. A value changed by another tool fails the
/// match and must not appear in the bulk restore action.
pub(super) fn valid_recovery_baseline(recovery: &RecoveryItem, item: &CatalogNativeItem) -> bool {
    recovery.optimized_value == item.effective_value
        && (matches!(recovery.original_value, PlatformSystemSettingValue::Missing)
            || same_value_kind(&recovery.original_value, &item.disabled_value)
            || same_value_kind(&recovery.original_value, &item.recommended_value)
            || matches!(
                (&recovery.original_value, &item.current_value),
                (
                    PlatformSystemSettingValue::Snapshot(_),
                    PlatformSystemSettingValue::Snapshot(_)
                )
            ))
}

/// Resolves the requested target without weakening an explicit restore.
///
/// Manual switches may still use the catalog's default value, while a setting
/// advertised as restorable keeps its exact durable baseline until the change
/// plan is prepared.
pub(super) fn desired_value_for_target(
    item: &CatalogNativeItem,
    target: SystemSettingTargetState,
    recovery: Option<&RecoveryItem>,
) -> Option<PlatformSystemSettingValue> {
    match target {
        SystemSettingTargetState::Optimized => Some(item.recommended_value.clone()),
        SystemSettingTargetState::Default => recovery
            .filter(|recovery| valid_recovery_baseline(recovery, item))
            .map(|recovery| recovery.original_value.clone())
            .or_else(|| (!item.public.restore_available).then(|| item.disabled_value.clone())),
    }
}

/// Marks only available settings whose current native value still matches the
/// durable baseline. The recommendation may change between releases, so
/// recovery is intentionally independent of the current optimized status.
pub(super) fn mark_restore_availability(
    items: &mut [CatalogNativeItem],
    document: Option<&RecoveryDocument>,
) -> bool {
    let recovery_items = recovery_items_by_id(document);
    let mut available = false;
    for item in items {
        item.public.restore_available = item.public.status != SystemSettingStatus::Unavailable
            && recovery_items
                .get(&item.public.setting_id)
                .is_some_and(|recovery| valid_recovery_baseline(recovery, item));
        available |= item.public.restore_available;
    }
    available
}

fn same_value_kind(left: &PlatformSystemSettingValue, right: &PlatformSystemSettingValue) -> bool {
    matches!(
        (left, right),
        (
            PlatformSystemSettingValue::Boolean(_),
            PlatformSystemSettingValue::Boolean(_)
        ) | (
            PlatformSystemSettingValue::Integer(_),
            PlatformSystemSettingValue::Integer(_)
        ) | (
            PlatformSystemSettingValue::Text(_),
            PlatformSystemSettingValue::Text(_)
        )
    )
}

/// Builds the durable baseline ledger written before native changes begin.
/// The plan retains matching baselines across policy updates, but captures the
/// current native value after an external override. Unrelated settings remain
/// reversible across batches.
pub(super) fn recovery_intent(
    previous: Option<&RecoveryDocument>,
    pending_items: &[PendingChangeItem],
) -> Vec<RecoveryItem> {
    let mut items = recovery_items_by_id(previous);
    for pending in pending_items
        .iter()
        .filter(|item| item.public.target == SystemSettingTargetState::Optimized)
    {
        items.insert(
            pending.public.setting_id.clone(),
            RecoveryItem {
                setting_id: pending.public.setting_id.clone(),
                original_value: pending.recovery_value.clone(),
                optimized_value: pending.desired_value.clone(),
            },
        );
    }
    items.into_values().collect()
}

/// Resolves the post-batch recovery ledger without filesystem side effects so
/// mixed optimize and restore batches have one deterministic source of truth.
pub(super) fn reconciled_recovery_items(
    previous: Option<&RecoveryDocument>,
    preflight_items: Vec<RecoveryItem>,
    pending_items: &[PendingChangeItem],
    results: &[SystemSettingChangeItemResult],
    possibly_changed: &BTreeSet<String>,
) -> Vec<RecoveryItem> {
    let previous_items = recovery_items_by_id(previous);
    let mut items = preflight_items
        .into_iter()
        .map(|item| (item.setting_id.clone(), item))
        .collect::<BTreeMap<_, _>>();
    for pending in pending_items {
        let result = results
            .iter()
            .find(|result| result.setting_id == pending.public.setting_id);
        let succeeded = result.is_some_and(|result| {
            result.verified && result.status != SystemSettingChangeOutcomeStatus::Failed
        });
        match pending.public.target {
            SystemSettingTargetState::Default if succeeded => {
                items.remove(&pending.public.setting_id);
            }
            SystemSettingTargetState::Optimized
                if (!succeeded && !possibly_changed.contains(&pending.public.setting_id))
                    || (result.is_some_and(|result| {
                        result.status == SystemSettingChangeOutcomeStatus::Unchanged
                    }) && !previous_items.contains_key(&pending.public.setting_id)) =>
            {
                if let Some(previous) = previous_items.get(&pending.public.setting_id) {
                    items.insert(pending.public.setting_id.clone(), previous.clone());
                } else {
                    items.remove(&pending.public.setting_id);
                }
            }
            _ => {}
        }
    }
    items.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::system_settings::models::{
        SystemSettingCategory, SystemSettingChangePlanItem, SystemSettingSelectionKind,
        SystemSettingRiskLevel, SystemSettingItem,
    };

    fn native(
        setting_id: &str,
        status: SystemSettingStatus,
        current: i64,
        effective: i64,
    ) -> CatalogNativeItem {
        CatalogNativeItem {
            public: SystemSettingItem {
                setting_id: setting_id.to_string(),
                category: SystemSettingCategory::Performance,
                selection_kind: SystemSettingSelectionKind::Custom,
                risk_level: SystemSettingRiskLevel::Standard,
                status,
                selected_by_default: false,
                restore_available: false,
                requires_restart: false,
                requires_elevation: false,
                diagnostic: None,
            },
            current_value: PlatformSystemSettingValue::Integer(current),
            effective_value: PlatformSystemSettingValue::Integer(effective),
            disabled_value: PlatformSystemSettingValue::Integer(0),
            recommended_value: PlatformSystemSettingValue::Integer(1),
        }
    }

    fn document(items: Vec<RecoveryItem>) -> RecoveryDocument {
        RecoveryDocument {
            schema_version: super::super::recovery::RECOVERY_SCHEMA_VERSION,
            recovery_id: "recovery".to_string(),
            created_at_ms: 1,
            items,
        }
    }

    fn recovery_item(setting_id: &str, original: i64, optimized: i64) -> RecoveryItem {
        RecoveryItem {
            setting_id: setting_id.to_string(),
            original_value: PlatformSystemSettingValue::Integer(original),
            optimized_value: PlatformSystemSettingValue::Integer(optimized),
        }
    }

    fn pending(setting_id: &str, target: SystemSettingTargetState) -> PendingChangeItem {
        PendingChangeItem {
            public: SystemSettingChangePlanItem {
                setting_id: setting_id.to_string(),
                category: SystemSettingCategory::Performance,
                target,
                requires_restart: false,
                requires_elevation: false,
            },
            expected_value: PlatformSystemSettingValue::Integer(0),
            desired_value: PlatformSystemSettingValue::Integer(1),
            recovery_value: PlatformSystemSettingValue::Integer(0),
        }
    }

    fn result(
        setting_id: &str,
        status: SystemSettingChangeOutcomeStatus,
        verified: bool,
    ) -> SystemSettingChangeItemResult {
        SystemSettingChangeItemResult {
            setting_id: setting_id.to_string(),
            status,
            verified,
            failure_reason: None,
        }
    }

    #[test]
    fn only_matching_baselines_are_restorable() {
        let mut items = vec![
            // The optimized value still matches the durable baseline.
            native("windows.a", SystemSettingStatus::Optimized, 1, 1),
            // Another tool changed the value after optimization.
            native("windows.b", SystemSettingStatus::Recommended, 0, 0),
            // Unreadable state never advertises a restore.
            native("windows.c", SystemSettingStatus::Unavailable, 1, 1),
        ];
        let document = document(vec![
            recovery_item("windows.a", 0, 1),
            recovery_item("windows.b", 0, 1),
            recovery_item("windows.c", 0, 1),
        ]);

        assert!(mark_restore_availability(&mut items, Some(&document)));
        assert!(items[0].public.restore_available);
        assert!(!items[1].public.restore_available);
        assert!(!items[2].public.restore_available);
    }

    #[test]
    fn missing_states_disable_restore_availability() {
        let mut items = vec![native(
            "windows.a",
            SystemSettingStatus::Optimized,
            1,
            1,
        )];
        assert!(!mark_restore_availability(&mut items, None));
        assert!(!items[0].public.restore_available);
    }

    #[test]
    fn default_target_prefers_the_durable_baseline() {
        let item = native("windows.a", SystemSettingStatus::Optimized, 1, 1);
        let baseline = recovery_item("windows.a", 0, 1);
        assert_eq!(
            desired_value_for_target(&item, SystemSettingTargetState::Default, Some(&baseline)),
            Some(PlatformSystemSettingValue::Integer(0))
        );
        assert_eq!(
            desired_value_for_target(&item, SystemSettingTargetState::Default, None),
            Some(PlatformSystemSettingValue::Integer(0))
        );
        assert_eq!(
            desired_value_for_target(&item, SystemSettingTargetState::Optimized, Some(&baseline)),
            Some(PlatformSystemSettingValue::Integer(1))
        );
    }

    #[test]
    fn a_disagreeing_baseline_does_not_authorize_a_restore() {
        let mut item = native("windows.a", SystemSettingStatus::Optimized, 1, 1);
        item.public.restore_available = true;
        let stale = recovery_item("windows.a", 0, 99);
        assert_eq!(
            desired_value_for_target(&item, SystemSettingTargetState::Default, Some(&stale)),
            None
        );
        assert!(!valid_recovery_baseline(&stale, &item));
    }

    #[test]
    fn successful_restore_removes_the_ledger_entry() {
        let previous = document(vec![
            recovery_item("windows.a", 0, 1),
            recovery_item("windows.b", 5, 1),
        ]);
        let pending_items = vec![pending("windows.a", SystemSettingTargetState::Default)];
        let results = vec![result(
            "windows.a",
            SystemSettingChangeOutcomeStatus::Changed,
            true,
        )];
        let item = reconciled_recovery_items(
            Some(&previous),
            previous.items.clone(),
            &pending_items,
            &results,
            &BTreeSet::new(),
        );
        assert_eq!(item.len(), 1);
        assert_eq!(item[0].setting_id, "windows.b");
    }

    #[test]
    fn failed_optimize_restores_the_previous_ledger_entry() {
        let previous = document(vec![recovery_item("windows.a", 0, 1)]);
        let pending_items = vec![pending("windows.a", SystemSettingTargetState::Optimized)];
        let results = vec![result(
            "windows.a",
            SystemSettingChangeOutcomeStatus::Failed,
            false,
        )];
        let item = reconciled_recovery_items(
            Some(&previous),
            previous.items.clone(),
            &pending_items,
            &results,
            &BTreeSet::new(),
        );
        assert_eq!(item, previous.items);
    }

    #[test]
    fn uncertain_mutation_keeps_the_preflight_baseline() {
        let pending_items = vec![pending("windows.a", SystemSettingTargetState::Optimized)];
        let results = vec![result(
            "windows.a",
            SystemSettingChangeOutcomeStatus::Failed,
            false,
        )];
        let possibly_changed = BTreeSet::from(["windows.a".to_string()]);
        let preflight = vec![recovery_item("windows.a", 0, 1)];
        let item = reconciled_recovery_items(
            None,
            preflight.clone(),
            &pending_items,
            &results,
            &possibly_changed,
        );
        assert_eq!(item, preflight);
    }

    #[test]
    fn recovery_intent_keeps_unrelated_settings_reversible() {
        let previous = document(vec![recovery_item("windows.unrelated", 7, 1)]);
        let pending_items = vec![pending("windows.a", SystemSettingTargetState::Optimized)];
        let item = recovery_intent(Some(&previous), &pending_items);
        assert_eq!(item.len(), 2);
        assert!(item.iter().any(|entry| entry.setting_id == "windows.unrelated"));
        assert!(item.iter().any(|entry| entry.setting_id == "windows.a"));
    }

    #[test]
    fn optimize_only_ledger_gains_the_new_baseline() {
        let pending_items = vec![pending("windows.a", SystemSettingTargetState::Optimized)];
        let item = recovery_intent(None, &pending_items);
        assert_eq!(item.len(), 1);
        assert_eq!(
            item[0].original_value,
            PlatformSystemSettingValue::Integer(0)
        );
        assert_eq!(
            item[0].optimized_value,
            PlatformSystemSettingValue::Integer(1)
        );
    }
}
