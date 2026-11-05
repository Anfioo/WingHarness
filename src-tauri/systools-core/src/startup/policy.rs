//! Pure startup change policy.
//!
//! Every decision in this module is a function of one native artifact snapshot,
//! so the rules stay unit-testable and never touch the operating system. The
//! service layer owns sequencing, sessions, and error mapping.

use std::path::Path;

use crate::startup::models::{
    StartupChangeSkipReason, StartupChangeWarning, StartupConfiguredState, StartupDesiredState,
};
use crate::startup::platform::{
    PlatformStartupArtifact, PlatformStartupConfiguredState, PlatformStartupControlCapability,
    PlatformStartupDiagnosticCode, PlatformStartupRuntimeState, PlatformStartupScope,
    PlatformStartupSourceKind,
};

/// Returns whether the provider can delete this exact startup configuration
/// without deleting the target application.
///
/// Providers still re-read the item and enforce their source boundary before
/// every mutation, so this flag only decides whether a removal may be offered.
pub(crate) fn supports_removal(artifact: &PlatformStartupArtifact) -> bool {
    match artifact.source_kind {
        PlatformStartupSourceKind::RegistryRun => matches!(
            artifact.control_capability,
            PlatformStartupControlCapability::Toggleable
                | PlatformStartupControlCapability::ElevationRequired
                | PlatformStartupControlCapability::RemoveOnly
        ),
        PlatformStartupSourceKind::StartupFolder => {
            has_extension(artifact, "lnk")
                && matches!(
                    artifact.control_capability,
                    PlatformStartupControlCapability::Toggleable
                        | PlatformStartupControlCapability::ElevationRequired
                )
        }
        PlatformStartupSourceKind::ScheduledTask => matches!(
            artifact.control_capability,
            PlatformStartupControlCapability::Toggleable
                | PlatformStartupControlCapability::ElevationRequired
        ),
        PlatformStartupSourceKind::AdvancedAutoRun => {
            artifact.control_capability == PlatformStartupControlCapability::RemoveOnly
        }
        PlatformStartupSourceKind::Service | PlatformStartupSourceKind::PackagedStartupTask => false,
    }
}

/// Returns whether a removable startup configuration points to a missing target.
///
/// This narrower signal powers the leftover filter; it never widens the set of
/// items an explicit removal may address.
pub(crate) fn is_removable_orphan(artifact: &PlatformStartupArtifact) -> bool {
    supports_removal(artifact)
        && artifact
            .diagnostics
            .contains(&PlatformStartupDiagnosticCode::MissingTarget)
}

/// Decides whether a prepared change can address this item at all.
///
/// The service turns a `Some` reason into a skipped plan entry, so this function
/// must stay total: every capability, state, and diagnostic combination gets a
/// deterministic answer.
pub(crate) fn skip_reason(
    artifact: &PlatformStartupArtifact,
    desired_state: StartupDesiredState,
) -> Option<StartupChangeSkipReason> {
    if desired_state == StartupDesiredState::Removed {
        return (!supports_removal(artifact))
            .then_some(StartupChangeSkipReason::UnsupportedCapability);
    }
    if !matches!(
        artifact.control_capability,
        PlatformStartupControlCapability::Toggleable
            | PlatformStartupControlCapability::ElevationRequired
    ) {
        return Some(StartupChangeSkipReason::UnsupportedCapability);
    }
    if desired_state == StartupDesiredState::Enabled
        && artifact.diagnostics.iter().any(|diagnostic| {
            matches!(
                diagnostic,
                PlatformStartupDiagnosticCode::MissingTarget
                    | PlatformStartupDiagnosticCode::InvalidData
            )
        })
    {
        return Some(StartupChangeSkipReason::TargetUnavailable);
    }
    match artifact.configured_state {
        PlatformStartupConfiguredState::Unknown | PlatformStartupConfiguredState::NotApplicable => {
            Some(StartupChangeSkipReason::StateUnknown)
        }
        // The catalog projection shares the configured-state conversion, so
        // both layers compare states the same way.
        state if is_in_desired_state(state.into(), desired_state) => {
            Some(StartupChangeSkipReason::AlreadyInDesiredState)
        }
        _ => None,
    }
}

/// Warnings the review step shows next to a planned change.
///
/// A toggle always addresses the whole startup item, so any additional trigger
/// changes behavior the user did not explicitly pick.
pub(crate) fn change_warnings(artifact: &PlatformStartupArtifact) -> Vec<StartupChangeWarning> {
    let mut warnings = Vec::new();
    if artifact.triggers.len() > 1 {
        warnings.push(StartupChangeWarning::AffectsOtherTriggers);
    }
    if matches!(
        artifact.runtime_state,
        PlatformStartupRuntimeState::Running | PlatformStartupRuntimeState::Loaded
    ) {
        warnings.push(StartupChangeWarning::ItemCurrentlyRunning);
    }
    warnings
}

/// Returns whether applying the change needs an elevated helper.
///
/// A machine-wide removal touches protected locations even when the capability
/// itself is a plain toggle, which mirrors the platform routing rule.
pub(crate) fn requires_elevation(
    artifact: &PlatformStartupArtifact,
    desired_state: StartupDesiredState,
) -> bool {
    artifact.control_capability == PlatformStartupControlCapability::ElevationRequired
        || (desired_state == StartupDesiredState::Removed
            && matches!(
                artifact.scope,
                PlatformStartupScope::AllUsers
                    | PlatformStartupScope::Machine
                    | PlatformStartupScope::System
            ))
}

/// Compares a catalog-visible state with the state a change would request.
pub(crate) fn is_in_desired_state(
    current: StartupConfiguredState,
    desired: StartupDesiredState,
) -> bool {
    matches!(
        (current, desired),
        (
            StartupConfiguredState::Enabled,
            StartupDesiredState::Enabled
        ) | (
            StartupConfiguredState::Disabled,
            StartupDesiredState::Disabled
        )
    )
}

fn has_extension(artifact: &PlatformStartupArtifact, expected: &str) -> bool {
    artifact
        .configuration_path
        .as_deref()
        .and_then(Path::extension)
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::startup::platform::{
        PlatformStartupIdentityConfidence, PlatformStartupOwner, PlatformStartupTarget,
        PlatformStartupTargetKind, PlatformStartupTrigger, PlatformStartupTrustState,
    };

    use super::*;

    fn artifact(
        kind: PlatformStartupSourceKind,
        capability: PlatformStartupControlCapability,
        configured: PlatformStartupConfiguredState,
    ) -> PlatformStartupArtifact {
        PlatformStartupArtifact {
            provider_item_id: "provider-item".to_owned(),
            source_kind: kind,
            scope: PlatformStartupScope::CurrentUser,
            triggers: vec![PlatformStartupTrigger::UserLogon],
            display_name: "Fixture".to_owned(),
            configuration_path: None,
            target: PlatformStartupTarget {
                kind: PlatformStartupTargetKind::Executable,
                identity_key: "fixture".to_owned(),
                path: Some(PathBuf::from(r"C:\Fixture\fixture.exe")),
                executable_name: Some("fixture.exe".to_owned()),
                arguments: Vec::new(),
            },
            owner: PlatformStartupOwner {
                identity_key: None,
                name: None,
                publisher: None,
                summary: None,
                summary_source: crate::startup::platform::PlatformStartupSummarySource::Unavailable,
                version: None,
                icon_path: None,
                confidence: PlatformStartupIdentityConfidence::Unresolved,
            },
            configured_state: configured,
            runtime_state: PlatformStartupRuntimeState::Stopped,
            control_capability: capability,
            trust: PlatformStartupTrustState::Unknown,
            modified_at_ms: None,
            diagnostics: Vec::new(),
        }
    }

    fn toggleable(configured: PlatformStartupConfiguredState) -> PlatformStartupArtifact {
        artifact(
            PlatformStartupSourceKind::RegistryRun,
            PlatformStartupControlCapability::Toggleable,
            configured,
        )
    }

    #[test]
    fn enabled_item_can_be_disabled_and_reports_running_warning() {
        let mut item = toggleable(PlatformStartupConfiguredState::Enabled);
        item.runtime_state = PlatformStartupRuntimeState::Running;

        assert_eq!(skip_reason(&item, StartupDesiredState::Disabled), None);
        assert_eq!(
            change_warnings(&item),
            vec![StartupChangeWarning::ItemCurrentlyRunning]
        );
    }

    #[test]
    fn item_already_in_the_requested_state_is_skipped() {
        let item = toggleable(PlatformStartupConfiguredState::Disabled);

        assert_eq!(
            skip_reason(&item, StartupDesiredState::Disabled),
            Some(StartupChangeSkipReason::AlreadyInDesiredState)
        );
    }

    #[test]
    fn unknown_and_not_applicable_states_are_skipped() {
        for configured in [
            PlatformStartupConfiguredState::Unknown,
            PlatformStartupConfiguredState::NotApplicable,
        ] {
            assert_eq!(
                skip_reason(&toggleable(configured), StartupDesiredState::Disabled),
                Some(StartupChangeSkipReason::StateUnknown)
            );
        }
    }

    #[test]
    fn protected_capabilities_never_produce_a_plan_item() {
        for capability in [
            PlatformStartupControlCapability::ViewOnly,
            PlatformStartupControlCapability::SystemManaged,
            PlatformStartupControlCapability::PolicyManaged,
        ] {
            let item = artifact(
                PlatformStartupSourceKind::RegistryRun,
                capability,
                PlatformStartupConfiguredState::Enabled,
            );
            assert_eq!(
                skip_reason(&item, StartupDesiredState::Disabled),
                Some(StartupChangeSkipReason::UnsupportedCapability)
            );
        }
    }

    #[test]
    fn remove_only_items_accept_removal_but_not_enabling() {
        let item = artifact(
            PlatformStartupSourceKind::RegistryRun,
            PlatformStartupControlCapability::RemoveOnly,
            PlatformStartupConfiguredState::Enabled,
        );

        assert_eq!(
            skip_reason(&item, StartupDesiredState::Enabled),
            Some(StartupChangeSkipReason::UnsupportedCapability)
        );
        assert_eq!(skip_reason(&item, StartupDesiredState::Removed), None);
        assert!(supports_removal(&item));
    }

    #[test]
    fn enabling_an_item_with_a_missing_target_is_skipped() {
        let mut item = toggleable(PlatformStartupConfiguredState::Enabled);
        item.diagnostics
            .push(PlatformStartupDiagnosticCode::MissingTarget);

        assert_eq!(
            skip_reason(&item, StartupDesiredState::Enabled),
            Some(StartupChangeSkipReason::TargetUnavailable)
        );
        assert_eq!(skip_reason(&item, StartupDesiredState::Disabled), None);
    }

    #[test]
    fn removal_capability_follows_the_source_boundary() {
        let mut folder = artifact(
            PlatformStartupSourceKind::StartupFolder,
            PlatformStartupControlCapability::Toggleable,
            PlatformStartupConfiguredState::Enabled,
        );
        folder.configuration_path = Some(PathBuf::from(r"C:\Fixture\fixture.LNK"));
        assert!(supports_removal(&folder));

        folder.configuration_path = Some(PathBuf::from(r"C:\Fixture\fixture.url"));
        assert!(!supports_removal(&folder));

        let service = artifact(
            PlatformStartupSourceKind::Service,
            PlatformStartupControlCapability::Toggleable,
            PlatformStartupConfiguredState::Enabled,
        );
        assert!(!supports_removal(&service));
        assert_eq!(
            skip_reason(&service, StartupDesiredState::Removed),
            Some(StartupChangeSkipReason::UnsupportedCapability)
        );
    }

    #[test]
    fn removable_orphans_require_both_removal_and_a_missing_target() {
        let mut item = artifact(
            PlatformStartupSourceKind::RegistryRun,
            PlatformStartupControlCapability::RemoveOnly,
            PlatformStartupConfiguredState::Enabled,
        );
        assert!(!is_removable_orphan(&item));

        item.diagnostics
            .push(PlatformStartupDiagnosticCode::MissingTarget);
        assert!(is_removable_orphan(&item));
    }

    #[test]
    fn multiple_triggers_warn_before_the_running_warning() {
        let mut item = artifact(
            PlatformStartupSourceKind::ScheduledTask,
            PlatformStartupControlCapability::Toggleable,
            PlatformStartupConfiguredState::Enabled,
        );
        item.triggers = vec![
            PlatformStartupTrigger::UserLogon,
            PlatformStartupTrigger::Scheduled,
        ];
        item.runtime_state = PlatformStartupRuntimeState::Loaded;

        assert_eq!(
            change_warnings(&item),
            vec![
                StartupChangeWarning::AffectsOtherTriggers,
                StartupChangeWarning::ItemCurrentlyRunning
            ]
        );
    }

    #[test]
    fn elevation_follows_capability_and_machine_wide_removal() {
        let mut item = toggleable(PlatformStartupConfiguredState::Enabled);
        assert!(!requires_elevation(&item, StartupDesiredState::Disabled));

        item.control_capability = PlatformStartupControlCapability::ElevationRequired;
        assert!(requires_elevation(&item, StartupDesiredState::Disabled));

        let mut machine = toggleable(PlatformStartupConfiguredState::Enabled);
        machine.scope = PlatformStartupScope::Machine;
        assert!(!requires_elevation(&machine, StartupDesiredState::Disabled));
        assert!(requires_elevation(&machine, StartupDesiredState::Removed));
    }

    #[test]
    fn desired_state_comparison_matches_only_the_same_state() {
        assert!(is_in_desired_state(
            StartupConfiguredState::Enabled,
            StartupDesiredState::Enabled
        ));
        assert!(is_in_desired_state(
            StartupConfiguredState::Disabled,
            StartupDesiredState::Disabled
        ));
        assert!(!is_in_desired_state(
            StartupConfiguredState::Disabled,
            StartupDesiredState::Enabled
        ));
        assert!(!is_in_desired_state(
            StartupConfiguredState::Unknown,
            StartupDesiredState::Disabled
        ));
        assert!(!is_in_desired_state(
            StartupConfiguredState::Enabled,
            StartupDesiredState::Removed
        ));
    }
}
