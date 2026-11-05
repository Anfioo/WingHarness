//! Deterministic projection of native startup sources into the shared catalog.
//!
//! The platform layer reports native facts; this module owns every product
//! decision: stable identifiers, owner grouping, aggregate states, coverage,
//! summary counts, and the catalog revision used to detect drift.

use std::collections::{BTreeMap, BTreeSet};

use crate::startup::models::{
    StartupAggregateConfiguredState, StartupAggregateControlState, StartupArtifact,
    StartupCatalogSummary, StartupConfiguredState, StartupControlCapability, StartupCoverageReason,
    StartupCoverageStatus, StartupDiagnosticCode, StartupIdentityConfidence, StartupOwnerGroup,
    StartupRuntimeState, StartupScope, StartupSourceCoverage, StartupSourceKind,
    StartupSummarySource, StartupTarget, StartupTargetKind, StartupTrigger, StartupTrustState,
};
use crate::startup::platform::{
    PlatformStartupArtifact, PlatformStartupConfiguredState, PlatformStartupControlCapability,
    PlatformStartupCoverageReason, PlatformStartupCoverageStatus, PlatformStartupDiagnosticCode,
    PlatformStartupIdentityConfidence, PlatformStartupRuntimeState, PlatformStartupScope,
    PlatformStartupSourceKind, PlatformStartupSourceResult, PlatformStartupSummarySource,
    PlatformStartupTargetKind, PlatformStartupTrigger, PlatformStartupTrustState,
};
use crate::startup::policy::{is_removable_orphan, supports_removal};

/// Catalog facts plus the revision derived from them.
pub(crate) struct AggregatedCatalog {
    pub artifacts: Vec<StartupArtifact>,
    pub groups: Vec<StartupOwnerGroup>,
    pub coverage: Vec<StartupSourceCoverage>,
    pub summary: StartupCatalogSummary,
    pub complete: bool,
    pub revision: String,
}

/// Projects every source result into one deterministic catalog.
///
/// Two sources may report the same provider identity; the first observation
/// wins so a repeated source result cannot duplicate an artifact or flip the
/// revision between otherwise identical scans.
pub(crate) fn aggregate(sources: Vec<PlatformStartupSourceResult>) -> AggregatedCatalog {
    let mut artifacts = Vec::new();
    let mut group_keys = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut coverage = Vec::with_capacity(sources.len());

    for source in sources {
        let PlatformStartupSourceResult {
            source_id,
            required,
            status,
            reason,
            items,
            elapsed_ms,
        } = source;
        let item_count = items.len() as u64;
        for item in items {
            let item_id = public_item_id(&source_id, &item.provider_item_id);
            if !seen.insert(item_id.clone()) {
                continue;
            }
            group_keys.insert(item_id.clone(), group_identity(&item, &item_id));
            artifacts.push(artifact_from_platform(&source_id, item_id, item));
        }
        coverage.push(StartupSourceCoverage {
            source_id,
            required,
            status: status.into(),
            reason: reason.map(Into::into),
            item_count,
            elapsed_ms,
        });
    }

    artifacts.sort_by(|left, right| left.item_id.cmp(&right.item_id));
    coverage.sort_by(|left, right| left.source_id.cmp(&right.source_id));
    let groups = group_artifacts(&artifacts, &group_keys);
    let complete = coverage
        .iter()
        .filter(|source| source.required)
        .all(|source| source.status == StartupCoverageStatus::Complete);
    let summary = summarize(&artifacts, &groups);
    let revision = catalog_revision(&artifacts);

    AggregatedCatalog {
        artifacts,
        groups,
        coverage,
        summary,
        complete,
        revision,
    }
}

/// Stable public identifier for one native item.
pub(crate) fn public_item_id(source_id: &str, provider_item_id: &str) -> String {
    digest_id("item", &[source_id.as_bytes(), provider_item_id.as_bytes()])
}

/// Revision over every catalog-visible fact of the sorted artifacts.
///
/// The wire shape is the canonical encoding: field order is fixed by the
/// struct, and the input is sorted here so callers cannot influence the hash
/// with an unstable scan order.
pub(crate) fn catalog_revision(artifacts: &[StartupArtifact]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"systools-startup-catalog-v1".as_slice());
    let mut ordered = artifacts.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.item_id.cmp(&right.item_id));
    for artifact in ordered {
        hasher.update(&(artifact.item_id.len() as u64).to_le_bytes());
        match serde_json::to_vec(artifact) {
            Ok(encoded) => {
                hasher.update(&encoded);
            }
            Err(_) => {
                hasher.update(b"unserializable");
            }
        }
    }
    hasher.finalize().to_hex().to_string()
}

fn artifact_from_platform(
    source_id: &str,
    item_id: String,
    item: PlatformStartupArtifact,
) -> StartupArtifact {
    let removal_supported = supports_removal(&item);
    let removable_orphan = is_removable_orphan(&item);
    let identity_confidence = if item.owner.identity_key.is_none()
        && !item.target.identity_key.trim().is_empty()
    {
        StartupIdentityConfidence::Probable
    } else {
        item.owner.confidence.into()
    };

    StartupArtifact {
        item_id,
        source_id: source_id.to_owned(),
        source_kind: item.source_kind.into(),
        scope: item.scope.into(),
        triggers: item.triggers.into_iter().map(Into::into).collect(),
        display_name: item.display_name,
        configuration_path: item
            .configuration_path
            .map(|path| path.to_string_lossy().into_owned()),
        target: StartupTarget {
            kind: item.target.kind.into(),
            path: item
                .target
                .path
                .map(|path| path.to_string_lossy().into_owned()),
            executable_name: item.target.executable_name,
            arguments: item.target.arguments,
        },
        owner_name: item.owner.name,
        publisher: item.owner.publisher,
        summary: item.owner.summary,
        summary_source: item.owner.summary_source.into(),
        version: item.owner.version,
        icon_path: item
            .owner
            .icon_path
            .map(|path| path.to_string_lossy().into_owned()),
        identity_confidence,
        configured_state: item.configured_state.into(),
        runtime_state: item.runtime_state.into(),
        control_capability: item.control_capability.into(),
        trust: item.trust.into(),
        modified_at_ms: item.modified_at_ms,
        diagnostics: item.diagnostics.into_iter().map(Into::into).collect(),
        removal_supported,
        removable_orphan,
    }
}

/// Groups items that describe the same installed product.
///
/// A strong owner identity always wins. Without one, the normalized target
/// identity plus the display name is the strongest available evidence, so two
/// unrelated helpers that share a display name stay apart.
fn group_identity(item: &PlatformStartupArtifact, item_id: &str) -> String {
    if let Some(owner_identity) = item.owner.identity_key.as_deref() {
        let normalized = normalize_identity(owner_identity);
        if !normalized.is_empty() {
            return digest_id("owner", &[normalized.as_bytes()]);
        }
    }
    let target_identity = normalize_identity(&item.target.identity_key);
    if !target_identity.is_empty() {
        let name = normalize_identity(&item.display_name);
        return digest_id("target", &[target_identity.as_bytes(), name.as_bytes()]);
    }
    digest_id("unresolved", &[item_id.as_bytes()])
}

fn normalize_identity(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn group_artifacts(
    artifacts: &[StartupArtifact],
    group_keys: &BTreeMap<String, String>,
) -> Vec<StartupOwnerGroup> {
    let mut grouped: BTreeMap<&str, Vec<&StartupArtifact>> = BTreeMap::new();
    for artifact in artifacts {
        if let Some(key) = group_keys.get(&artifact.item_id) {
            grouped.entry(key.as_str()).or_default().push(artifact);
        }
    }

    grouped
        .into_iter()
        .filter_map(|(identity_key, items)| {
            let representative = items
                .iter()
                .copied()
                .min_by_key(|item| item.identity_confidence)?;
            let mut source_kinds = items.iter().map(|item| item.source_kind).collect::<Vec<_>>();
            source_kinds.sort_unstable();
            source_kinds.dedup();
            let mut triggers = items
                .iter()
                .flat_map(|item| item.triggers.iter().copied())
                .collect::<Vec<_>>();
            triggers.sort_unstable();
            triggers.dedup();
            let mut scopes = items.iter().map(|item| item.scope).collect::<Vec<_>>();
            scopes.sort_unstable();
            scopes.dedup();
            Some(StartupOwnerGroup {
                group_id: digest_id("group", &[identity_key.as_bytes()]),
                name: representative
                    .owner_name
                    .clone()
                    .unwrap_or_else(|| representative.display_name.clone()),
                publisher: representative.publisher.clone(),
                summary: representative.summary.clone(),
                summary_source: representative.summary_source,
                version: representative.version.clone(),
                icon_path: representative.icon_path.clone(),
                identity_confidence: representative.identity_confidence,
                item_ids: items.iter().map(|item| item.item_id.clone()).collect(),
                source_kinds,
                triggers,
                scopes,
                configured_state: aggregate_configured_state(&items),
                control_state: aggregate_control_state(&items),
                system_item: items
                    .iter()
                    .all(|item| item.trust == StartupTrustState::System),
            })
        })
        .collect()
}

fn aggregate_configured_state(items: &[&StartupArtifact]) -> StartupAggregateConfiguredState {
    let enabled = items
        .iter()
        .filter(|item| item.configured_state == StartupConfiguredState::Enabled)
        .count();
    let disabled = items
        .iter()
        .filter(|item| item.configured_state == StartupConfiguredState::Disabled)
        .count();
    if enabled == items.len() {
        StartupAggregateConfiguredState::AllEnabled
    } else if disabled == items.len() {
        StartupAggregateConfiguredState::AllDisabled
    } else if enabled > 0 && disabled > 0 {
        StartupAggregateConfiguredState::PartiallyEnabled
    } else {
        StartupAggregateConfiguredState::Unknown
    }
}

fn aggregate_control_state(items: &[&StartupArtifact]) -> StartupAggregateControlState {
    let toggleable = items
        .iter()
        .filter(|item| item.control_capability == StartupControlCapability::Toggleable)
        .count();
    let elevation = items
        .iter()
        .filter(|item| item.control_capability == StartupControlCapability::ElevationRequired)
        .count();
    if toggleable == items.len() {
        StartupAggregateControlState::AllToggleable
    } else if elevation == items.len() {
        StartupAggregateControlState::RequiresElevation
    } else if toggleable + elevation > 0 {
        StartupAggregateControlState::PartiallyManageable
    } else {
        StartupAggregateControlState::ViewOnly
    }
}

fn summarize(
    artifacts: &[StartupArtifact],
    groups: &[StartupOwnerGroup],
) -> StartupCatalogSummary {
    StartupCatalogSummary {
        item_count: artifacts.len() as u64,
        group_count: groups.len() as u64,
        enabled_count: artifacts
            .iter()
            .filter(|item| item.configured_state == StartupConfiguredState::Enabled)
            .count() as u64,
        disabled_count: artifacts
            .iter()
            .filter(|item| item.configured_state == StartupConfiguredState::Disabled)
            .count() as u64,
        unknown_state_count: artifacts
            .iter()
            .filter(|item| {
                matches!(
                    item.configured_state,
                    StartupConfiguredState::Unknown | StartupConfiguredState::NotApplicable
                )
            })
            .count() as u64,
        elevation_required_count: artifacts
            .iter()
            .filter(|item| item.control_capability == StartupControlCapability::ElevationRequired)
            .count() as u64,
        system_item_count: artifacts
            .iter()
            .filter(|item| item.trust == StartupTrustState::System)
            .count() as u64,
    }
}

fn digest_id(namespace: &str, values: &[&[u8]]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"systools-startup-id-v1".as_slice());
    hasher.update(&(namespace.len() as u64).to_le_bytes());
    hasher.update(namespace.as_bytes());
    for value in values {
        hasher.update(&(value.len() as u64).to_le_bytes());
        hasher.update(value);
    }
    hasher.finalize().to_hex().to_string()
}

impl From<PlatformStartupSourceKind> for StartupSourceKind {
    fn from(value: PlatformStartupSourceKind) -> Self {
        match value {
            PlatformStartupSourceKind::RegistryRun => Self::RegistryRun,
            PlatformStartupSourceKind::StartupFolder => Self::StartupFolder,
            PlatformStartupSourceKind::ScheduledTask => Self::ScheduledTask,
            PlatformStartupSourceKind::Service => Self::Service,
            PlatformStartupSourceKind::PackagedStartupTask => Self::PackagedStartupTask,
            PlatformStartupSourceKind::AdvancedAutoRun => Self::AdvancedAutoRun,
        }
    }
}

impl From<PlatformStartupScope> for StartupScope {
    fn from(value: PlatformStartupScope) -> Self {
        match value {
            PlatformStartupScope::CurrentUser => Self::CurrentUser,
            PlatformStartupScope::User => Self::User,
            PlatformStartupScope::AllUsers => Self::AllUsers,
            PlatformStartupScope::Machine => Self::Machine,
            PlatformStartupScope::System => Self::System,
        }
    }
}

impl From<PlatformStartupTrigger> for StartupTrigger {
    fn from(value: PlatformStartupTrigger) -> Self {
        match value {
            PlatformStartupTrigger::Boot => Self::Boot,
            PlatformStartupTrigger::UserLogon => Self::UserLogon,
            PlatformStartupTrigger::Scheduled => Self::Scheduled,
            PlatformStartupTrigger::Event => Self::Event,
            PlatformStartupTrigger::KeepAlive => Self::KeepAlive,
            PlatformStartupTrigger::ShellLoad => Self::ShellLoad,
            PlatformStartupTrigger::ApplicationLaunch => Self::ApplicationLaunch,
            PlatformStartupTrigger::Unknown => Self::Unknown,
        }
    }
}

impl From<PlatformStartupConfiguredState> for StartupConfiguredState {
    fn from(value: PlatformStartupConfiguredState) -> Self {
        match value {
            PlatformStartupConfiguredState::Enabled => Self::Enabled,
            PlatformStartupConfiguredState::Disabled => Self::Disabled,
            PlatformStartupConfiguredState::Unknown => Self::Unknown,
            PlatformStartupConfiguredState::NotApplicable => Self::NotApplicable,
        }
    }
}

impl From<PlatformStartupRuntimeState> for StartupRuntimeState {
    fn from(value: PlatformStartupRuntimeState) -> Self {
        match value {
            PlatformStartupRuntimeState::Running => Self::Running,
            PlatformStartupRuntimeState::Stopped => Self::Stopped,
            PlatformStartupRuntimeState::Loaded => Self::Loaded,
            PlatformStartupRuntimeState::Unloaded => Self::Unloaded,
            PlatformStartupRuntimeState::Unknown => Self::Unknown,
        }
    }
}

impl From<PlatformStartupControlCapability> for StartupControlCapability {
    fn from(value: PlatformStartupControlCapability) -> Self {
        match value {
            PlatformStartupControlCapability::Toggleable => Self::Toggleable,
            PlatformStartupControlCapability::ElevationRequired => Self::ElevationRequired,
            PlatformStartupControlCapability::RemoveOnly => Self::RemoveOnly,
            PlatformStartupControlCapability::SystemManaged => Self::SystemManaged,
            PlatformStartupControlCapability::PolicyManaged => Self::PolicyManaged,
            PlatformStartupControlCapability::ViewOnly => Self::ViewOnly,
        }
    }
}

impl From<PlatformStartupTrustState> for StartupTrustState {
    fn from(value: PlatformStartupTrustState) -> Self {
        match value {
            PlatformStartupTrustState::System => Self::System,
            PlatformStartupTrustState::Verified => Self::Verified,
            PlatformStartupTrustState::Invalid => Self::Invalid,
            PlatformStartupTrustState::Unsigned => Self::Unsigned,
            PlatformStartupTrustState::Unknown => Self::Unknown,
        }
    }
}

impl From<PlatformStartupIdentityConfidence> for StartupIdentityConfidence {
    fn from(value: PlatformStartupIdentityConfidence) -> Self {
        match value {
            PlatformStartupIdentityConfidence::Exact => Self::Exact,
            PlatformStartupIdentityConfidence::Strong => Self::Strong,
            PlatformStartupIdentityConfidence::Probable => Self::Probable,
            PlatformStartupIdentityConfidence::Unresolved => Self::Unresolved,
        }
    }
}

impl From<PlatformStartupSummarySource> for StartupSummarySource {
    fn from(value: PlatformStartupSummarySource) -> Self {
        match value {
            PlatformStartupSummarySource::ServiceDescription => Self::ServiceDescription,
            PlatformStartupSummarySource::TaskDescription => Self::TaskDescription,
            PlatformStartupSummarySource::PackageManifest => Self::PackageManifest,
            PlatformStartupSummarySource::VersionInfo => Self::VersionInfo,
            PlatformStartupSummarySource::SourceLabel => Self::SourceLabel,
            PlatformStartupSummarySource::Unavailable => Self::Unavailable,
        }
    }
}

impl From<PlatformStartupTargetKind> for StartupTargetKind {
    fn from(value: PlatformStartupTargetKind) -> Self {
        match value {
            PlatformStartupTargetKind::Executable => Self::Executable,
            PlatformStartupTargetKind::Application => Self::Application,
            PlatformStartupTargetKind::Script => Self::Script,
            PlatformStartupTargetKind::Service => Self::Service,
            PlatformStartupTargetKind::Task => Self::Task,
            PlatformStartupTargetKind::Other => Self::Other,
            PlatformStartupTargetKind::Unknown => Self::Unknown,
        }
    }
}

impl From<PlatformStartupDiagnosticCode> for StartupDiagnosticCode {
    fn from(value: PlatformStartupDiagnosticCode) -> Self {
        match value {
            PlatformStartupDiagnosticCode::AccessDenied => Self::AccessDenied,
            PlatformStartupDiagnosticCode::InvalidData => Self::InvalidData,
            PlatformStartupDiagnosticCode::MissingIdentity => Self::MissingIdentity,
            PlatformStartupDiagnosticCode::MissingTarget => Self::MissingTarget,
            PlatformStartupDiagnosticCode::StateUnavailable => Self::StateUnavailable,
            PlatformStartupDiagnosticCode::UnsupportedFormat => Self::UnsupportedFormat,
        }
    }
}

impl From<PlatformStartupCoverageStatus> for StartupCoverageStatus {
    fn from(value: PlatformStartupCoverageStatus) -> Self {
        match value {
            PlatformStartupCoverageStatus::Complete => Self::Complete,
            PlatformStartupCoverageStatus::Partial => Self::Partial,
            PlatformStartupCoverageStatus::Unavailable => Self::Unavailable,
            PlatformStartupCoverageStatus::Failed => Self::Failed,
            PlatformStartupCoverageStatus::Cancelled => Self::Cancelled,
        }
    }
}

impl From<PlatformStartupCoverageReason> for StartupCoverageReason {
    fn from(value: PlatformStartupCoverageReason) -> Self {
        match value {
            PlatformStartupCoverageReason::AccessDenied => Self::AccessDenied,
            PlatformStartupCoverageReason::ApiUnavailable => Self::ApiUnavailable,
            PlatformStartupCoverageReason::Cancelled => Self::Cancelled,
            PlatformStartupCoverageReason::InvalidData => Self::InvalidData,
            PlatformStartupCoverageReason::NotImplemented => Self::NotImplemented,
            PlatformStartupCoverageReason::StateUnavailable => Self::StateUnavailable,
            PlatformStartupCoverageReason::UnsupportedOperatingSystem => {
                Self::UnsupportedOperatingSystem
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::startup::platform::{
        PlatformStartupOwner, PlatformStartupTarget,
    };

    use super::*;

    fn artifact(provider_id: &str, name: &str, target: &str) -> PlatformStartupArtifact {
        PlatformStartupArtifact {
            provider_item_id: provider_id.to_owned(),
            source_kind: PlatformStartupSourceKind::RegistryRun,
            scope: PlatformStartupScope::CurrentUser,
            triggers: vec![PlatformStartupTrigger::UserLogon],
            display_name: name.to_owned(),
            configuration_path: None,
            target: PlatformStartupTarget {
                kind: PlatformStartupTargetKind::Executable,
                identity_key: target.to_owned(),
                path: Some(PathBuf::from(target)),
                executable_name: Some(name.to_owned()),
                arguments: Vec::new(),
            },
            owner: PlatformStartupOwner {
                identity_key: None,
                name: None,
                publisher: None,
                summary: None,
                summary_source: PlatformStartupSummarySource::Unavailable,
                version: None,
                icon_path: None,
                confidence: PlatformStartupIdentityConfidence::Unresolved,
            },
            configured_state: PlatformStartupConfiguredState::Enabled,
            runtime_state: PlatformStartupRuntimeState::Unknown,
            control_capability: PlatformStartupControlCapability::Toggleable,
            trust: PlatformStartupTrustState::Unknown,
            modified_at_ms: None,
            diagnostics: Vec::new(),
        }
    }

    fn source(
        source_id: &str,
        items: Vec<PlatformStartupArtifact>,
    ) -> PlatformStartupSourceResult {
        PlatformStartupSourceResult {
            source_id: source_id.to_owned(),
            required: true,
            status: PlatformStartupCoverageStatus::Complete,
            reason: None,
            items,
            elapsed_ms: 1,
        }
    }

    #[test]
    fn catalog_reports_counts_groups_and_coverage() {
        let mut disabled = artifact("two", "Example", r"C:\Example\example.exe");
        disabled.configured_state = PlatformStartupConfiguredState::Disabled;
        disabled.control_capability = PlatformStartupControlCapability::ElevationRequired;
        let mut first = artifact("one", "Example", r"C:\Example\example.exe");
        first.trust = PlatformStartupTrustState::System;

        let aggregated = aggregate(vec![
            source("windows.registry.run", vec![first, disabled]),
            PlatformStartupSourceResult::unavailable(
                "windows.advanced_autoruns",
                false,
                PlatformStartupCoverageReason::NotImplemented,
            ),
        ]);

        assert_eq!(aggregated.artifacts.len(), 2);
        assert_eq!(aggregated.groups.len(), 1);
        assert_eq!(aggregated.coverage.len(), 2);
        assert!(aggregated.complete);
        assert_eq!(aggregated.summary.item_count, 2);
        assert_eq!(aggregated.summary.group_count, 1);
        assert_eq!(aggregated.summary.enabled_count, 1);
        assert_eq!(aggregated.summary.disabled_count, 1);
        assert_eq!(aggregated.summary.elevation_required_count, 1);
        assert_eq!(aggregated.summary.system_item_count, 1);
        assert_eq!(
            aggregated.groups[0].configured_state,
            StartupAggregateConfiguredState::PartiallyEnabled
        );
        assert_eq!(
            aggregated.groups[0].identity_confidence,
            StartupIdentityConfidence::Probable
        );
        assert!(!aggregated.groups[0].system_item);
    }

    #[test]
    fn required_failure_makes_the_catalog_incomplete() {
        let aggregated = aggregate(vec![
            source("windows.registry.run", vec![artifact("one", "One", "one")]),
            PlatformStartupSourceResult::unavailable(
                "windows.services",
                true,
                PlatformStartupCoverageReason::AccessDenied,
            ),
        ]);

        assert!(!aggregated.complete);
        let services = aggregated
            .coverage
            .iter()
            .find(|coverage| coverage.source_id == "windows.services")
            .expect("the failed source stays in coverage");
        assert_eq!(services.status, StartupCoverageStatus::Unavailable);
        assert_eq!(services.reason, Some(StartupCoverageReason::AccessDenied));
        assert_eq!(services.item_count, 0);
    }

    #[test]
    fn revision_is_stable_and_changes_with_a_fact() {
        let items = vec![
            artifact("one", "One", r"C:\One\one.exe"),
            artifact("two", "Two", r"C:\Two\two.exe"),
        ];
        let baseline = aggregate(vec![source("windows.registry.run", items.clone())]).revision;

        let reordered = aggregate(vec![source(
            "windows.registry.run",
            vec![items[1].clone(), items[0].clone()],
        )])
        .revision;
        assert_eq!(baseline, reordered);

        let mut changed = items;
        changed[0].configured_state = PlatformStartupConfiguredState::Disabled;
        let changed_revision =
            aggregate(vec![source("windows.registry.run", changed)]).revision;
        assert_ne!(baseline, changed_revision);
    }

    #[test]
    fn artifacts_and_groups_have_deterministic_order() {
        let aggregated = aggregate(vec![source(
            "windows.registry.run",
            vec![
                artifact("zeta", "Zeta", r"C:\Zeta\zeta.exe"),
                artifact("alpha", "Alpha", r"C:\Alpha\alpha.exe"),
                artifact("mid", "Mid", r"C:\Mid\mid.exe"),
            ],
        )]);

        let ids = aggregated
            .artifacts
            .iter()
            .map(|item| item.item_id.clone())
            .collect::<Vec<_>>();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted);

        let reordered = aggregate(vec![source(
            "windows.registry.run",
            vec![
                artifact("mid", "Mid", r"C:\Mid\mid.exe"),
                artifact("zeta", "Zeta", r"C:\Zeta\zeta.exe"),
                artifact("alpha", "Alpha", r"C:\Alpha\alpha.exe"),
            ],
        )]);
        assert_eq!(
            aggregated
                .groups
                .iter()
                .map(|group| group.group_id.clone())
                .collect::<Vec<_>>(),
            reordered
                .groups
                .iter()
                .map(|group| group.group_id.clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn duplicate_provider_identities_keep_the_first_observation() {
        let first = artifact("one", "One", r"C:\One\one.exe");
        let mut duplicate = artifact("one", "One duplicate", r"C:\One\one.exe");
        duplicate.configured_state = PlatformStartupConfiguredState::Disabled;

        let aggregated = aggregate(vec![source(
            "windows.registry.run",
            vec![first, duplicate],
        )]);

        assert_eq!(aggregated.artifacts.len(), 1);
        assert_eq!(aggregated.artifacts[0].display_name, "One");
        assert_eq!(aggregated.coverage[0].item_count, 2);
        assert_eq!(aggregated.summary.item_count, 1);
    }

    #[test]
    fn equal_display_names_do_not_merge_different_targets() {
        let aggregated = aggregate(vec![source(
            "windows.registry.run",
            vec![
                artifact("one", "Helper", r"C:\One\helper.exe"),
                artifact("two", "Helper", r"C:\Two\helper.exe"),
            ],
        )]);

        assert_eq!(aggregated.groups.len(), 2);
    }

    #[test]
    fn owner_identity_merges_native_items_of_one_product() {
        let mut first = artifact("one", "Example", r"C:\Example\a.exe");
        let mut second = artifact("two", "Example", r"C:\Example\b.exe");
        for item in [&mut first, &mut second] {
            item.owner.identity_key = Some("com.example.app".to_owned());
            item.owner.name = Some("Example".to_owned());
            item.owner.confidence = PlatformStartupIdentityConfidence::Exact;
        }

        let aggregated = aggregate(vec![source("windows.registry.run", vec![first, second])]);

        assert_eq!(aggregated.groups.len(), 1);
        assert_eq!(aggregated.groups[0].item_ids.len(), 2);
        assert_eq!(
            aggregated.groups[0].identity_confidence,
            StartupIdentityConfidence::Exact
        );
        assert_eq!(aggregated.groups[0].name, "Example");
    }

    #[test]
    fn group_prefers_the_strongest_owner_metadata() {
        let mut exact = artifact("one", "Fallback", r"C:\Example\a.exe");
        exact.owner.identity_key = Some("com.example.app".to_owned());
        exact.owner.name = Some("Example".to_owned());
        exact.owner.publisher = Some("Example Publisher".to_owned());
        exact.owner.confidence = PlatformStartupIdentityConfidence::Exact;

        let mut unresolved = artifact("two", "Technical Helper", r"C:\Example\b.exe");
        unresolved.owner.identity_key = Some("com.example.app".to_owned());
        unresolved.owner.confidence = PlatformStartupIdentityConfidence::Unresolved;

        let aggregated =
            aggregate(vec![source("windows.registry.run", vec![unresolved, exact])]);

        assert_eq!(aggregated.groups.len(), 1);
        assert_eq!(aggregated.groups[0].name, "Example");
        assert_eq!(
            aggregated.groups[0].publisher.as_deref(),
            Some("Example Publisher")
        );
        assert_eq!(
            aggregated.groups[0].identity_confidence,
            StartupIdentityConfidence::Exact
        );
    }

    #[test]
    fn removal_flags_follow_the_source_capability() {
        let mut removable = artifact("orphan", "Orphan", r"C:\Missing\missing.exe");
        removable
            .diagnostics
            .push(PlatformStartupDiagnosticCode::MissingTarget);
        let safe = artifact("safe", "Safe", r"C:\Safe\safe.exe");

        let aggregated = aggregate(vec![source("windows.registry.run", vec![removable, safe])]);

        let orphan = aggregated
            .artifacts
            .iter()
            .find(|item| item.display_name == "Orphan")
            .expect("the orphan is present");
        assert!(orphan.removal_supported);
        assert!(orphan.removable_orphan);
        let safe = aggregated
            .artifacts
            .iter()
            .find(|item| item.display_name == "Safe")
            .expect("the safe item is present");
        assert!(safe.removal_supported);
        assert!(!safe.removable_orphan);
    }

    #[test]
    fn optional_unavailable_source_does_not_make_catalog_incomplete() {
        let aggregated = aggregate(vec![
            source("windows.registry.run", vec![artifact("one", "One", "one")]),
            PlatformStartupSourceResult::unavailable(
                "windows.packaged_startup_tasks",
                false,
                PlatformStartupCoverageReason::NotImplemented,
            ),
        ]);

        assert!(aggregated.complete);
    }
}
