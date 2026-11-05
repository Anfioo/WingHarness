//! Reviewable uninstall plans and their content hashes.
//!
//! A plan freezes the evidence the user reviewed: the catalog revision, the
//! selected components, and a metadata fingerprint for each component. The
//! plan hash is computed over a deterministic, length-prefixed encoding so the
//! execution command can prove the plan was not modified between review and
//! execution. No free-form command text is ever part of a plan.
//!
//! Component fingerprints are stable across runs while a component is
//! unchanged and change when its content or metadata changes. For components
//! backed by a directory the fingerprint covers the normalized path, the
//! bounded byte and file counts, and the directory modification time. The
//! native-installer component has no path, so its fingerprint covers the typed
//! registration descriptor instead.

use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::applications::contracts::{
    ApplicationInstallScope, ApplicationUninstallRegistration, InstalledApplication,
    WindowsRegistryView, APPLICATION_ID_PREFIX,
};
use crate::applications::models::{
    ApplicationUninstallBatchPlan, ApplicationUninstallBatchSelection,
    ApplicationUninstallCandidate, ApplicationUninstallComponent,
    ApplicationUninstallComponentKind, ApplicationUninstallComponentSummary,
    ApplicationUninstallPlan, ApplicationUninstallPlanItem,
    APPLICATION_UNINSTALL_BATCH_PLAN_SCHEMA_VERSION, APPLICATION_UNINSTALL_PLAN_SCHEMA_VERSION,
};
use crate::applications::running_identity;
use crate::platform::windows::package_locations;

/// Domain separation for plan hashes.
const PLAN_DOMAIN: &str = "systools-application-uninstall-plan-v1";
/// Domain separation for batch-plan hashes.
const BATCH_DOMAIN: &str = "systools-application-uninstall-batch-plan-v1";
/// Domain separation for component snapshot fingerprints.
const SNAPSHOT_DOMAIN: &str = "systools-application-component-snapshot-v1";
/// Domain separation for typed registration descriptors.
const REGISTRATION_DOMAIN: &str = "systools-application-uninstall-registration-v1";

/// Upper bound for one reviewed batch.
pub(crate) const MAX_BATCH_APPLICATIONS: usize = 128;
/// Upper bound for the components selected for one application.
pub(crate) const MAX_PLAN_ITEMS: usize = 200;

/// Why a component could not be snapshotted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ComponentSnapshotError {
    /// The component no longer exists at its reviewed path.
    Unavailable,
    /// The component exists but its metadata could not be read.
    Unreadable,
}

impl ComponentSnapshotError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "component_unavailable",
            Self::Unreadable => "component_unreadable",
        }
    }
}

/// Recomputes one component's current snapshot.
///
/// `bytes` and `file_count` are re-read from the filesystem, not copied from
/// the catalog, so a directory that grew between review and execution changes
/// the fingerprint.
pub(crate) fn component_snapshot(
    application: &InstalledApplication,
    component: &ApplicationUninstallComponentSummary,
) -> Result<ApplicationUninstallComponent, ComponentSnapshotError> {
    let (bytes, file_count, fingerprint) = match component.path.as_deref() {
        Some(path) => directory_snapshot(component, path)?,
        None => {
            let registration = application
                .uninstall_registration
                .as_ref()
                .ok_or(ComponentSnapshotError::Unavailable)?;
            (
                component.bytes,
                component.file_count,
                registration_fingerprint(registration),
            )
        }
    };
    Ok(ApplicationUninstallComponent {
        component_id: component.component_id.clone(),
        kind: component.kind,
        risk: component.risk,
        path: component.path.clone(),
        bytes,
        file_count,
        default_selected: component.default_selected,
        snapshot_fingerprint: fingerprint,
    })
}

fn directory_snapshot(
    component: &ApplicationUninstallComponentSummary,
    path: &str,
) -> Result<(u64, u64, String), ComponentSnapshotError> {
    let path = Path::new(path);
    let metadata = std::fs::metadata(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => ComponentSnapshotError::Unavailable,
        _ => ComponentSnapshotError::Unreadable,
    })?;
    if !metadata.is_dir() {
        return Err(ComponentSnapshotError::Unavailable);
    }
    let (bytes, file_count) = package_locations::bounded_directory_size(path);
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let mut hasher = blake3::Hasher::new();
    hasher.update(SNAPSHOT_DOMAIN.as_bytes());
    text(&mut hasher, &component.component_id);
    text(&mut hasher, &running_identity::path_identity_key(path));
    number(&mut hasher, bytes);
    number(&mut hasher, file_count);
    number(&mut hasher, u64::try_from(modified).unwrap_or(u64::MAX));
    Ok((
        bytes,
        file_count,
        hasher.finalize().to_hex().to_string(),
    ))
}

fn registration_fingerprint(registration: &ApplicationUninstallRegistration) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(SNAPSHOT_DOMAIN.as_bytes());
    text(&mut hasher, "native-installer");
    text(&mut hasher, &registration_digest(registration));
    hasher.finalize().to_hex().to_string()
}

/// Canonical digest of a typed registration descriptor.
///
/// The descriptor carries no command text, only the registry identity and the
/// digest of the validated command, so this digest remains stable across runs
/// while the registration is unchanged.
pub(crate) fn registration_digest(registration: &ApplicationUninstallRegistration) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(REGISTRATION_DOMAIN.as_bytes());
    match registration {
        ApplicationUninstallRegistration::WindowsMsi {
            product_code,
            scope,
            estimated_bytes,
        } => {
            text(&mut hasher, "msi");
            text(&mut hasher, product_code);
            text(&mut hasher, scope_code(*scope));
            number(&mut hasher, *estimated_bytes);
        }
        ApplicationUninstallRegistration::WindowsAppx {
            package_family_name,
            package_full_name,
            estimated_bytes,
        } => {
            text(&mut hasher, "appx");
            text(&mut hasher, package_family_name);
            text(&mut hasher, package_full_name);
            number(&mut hasher, *estimated_bytes);
        }
        ApplicationUninstallRegistration::WindowsRegistered {
            key_name,
            scope,
            registry_view,
            command_kind,
            command_digest,
            estimated_bytes,
        } => {
            text(&mut hasher, "registered");
            text(&mut hasher, key_name);
            text(&mut hasher, scope_code(*scope));
            text(&mut hasher, view_code(*registry_view));
            text(&mut hasher, command_kind_code(*command_kind));
            text(&mut hasher, command_digest);
            number(&mut hasher, *estimated_bytes);
        }
        ApplicationUninstallRegistration::Winget {
            package_id,
            source_name,
            estimated_bytes,
        } => {
            text(&mut hasher, "winget");
            text(&mut hasher, package_id);
            text(&mut hasher, source_name);
            number(&mut hasher, *estimated_bytes);
        }
    }
    hasher.finalize().to_hex().to_string()
}

fn scope_code(scope: ApplicationInstallScope) -> &'static str {
    match scope {
        ApplicationInstallScope::CurrentUser => "current-user",
        ApplicationInstallScope::Machine => "machine",
    }
}

fn view_code(view: WindowsRegistryView) -> &'static str {
    match view {
        WindowsRegistryView::Registry32 => "registry32",
        WindowsRegistryView::Registry64 => "registry64",
    }
}

fn command_kind_code(kind: crate::applications::contracts::WindowsRegisteredUninstallKind) -> &'static str {
    crate::platform::windows::package_sources::kind_code(kind)
}

/// Builds a reviewed plan from one candidate and the selected component IDs.
///
/// Required components (the native uninstaller) are always included: they are
/// not optional evidence but the authority that performs the removal. Unknown
/// IDs, duplicate IDs, and empty IDs are rejected.
pub(crate) fn create_plan(
    application: &InstalledApplication,
    candidate: &ApplicationUninstallCandidate,
    component_ids: &[String],
    catalog_revision: &str,
    created_at_ms: u64,
) -> Result<ApplicationUninstallPlan, &'static str> {
    if catalog_revision.trim().is_empty() {
        return Err("missing_catalog_revision");
    }
    if component_ids.len() > MAX_PLAN_ITEMS {
        return Err("too_many_components");
    }
    let mut selected = Vec::with_capacity(component_ids.len());
    for id in component_ids {
        let id = id.trim();
        if id.is_empty() {
            return Err("empty_component_id");
        }
        if selected.iter().any(|existing: &String| existing == id) {
            return Err("duplicate_component_id");
        }
        if !candidate
            .components
            .iter()
            .any(|component| component.component_id == id)
        {
            return Err("unknown_component");
        }
        selected.push(id.to_string());
    }
    if candidate.components.is_empty() {
        return Err("no_components");
    }
    if selected.is_empty() {
        return Err("empty_selection");
    }

    let mut items = Vec::new();
    for component in &candidate.components {
        let required = component.risk == crate::applications::models::ApplicationUninstallRisk::Required;
        if !required && !selected.iter().any(|id| id == &component.component_id) {
            continue;
        }
        let snapshot = component_snapshot(application, component)
            .map_err(ComponentSnapshotError::code)?;
        items.push(ApplicationUninstallPlanItem {
            component_id: snapshot.component_id,
            kind: snapshot.kind,
            expected_bytes: snapshot.bytes,
            expected_file_count: snapshot.file_count,
            expected_snapshot_fingerprint: snapshot.snapshot_fingerprint,
        });
    }
    if items.is_empty() {
        return Err("empty_selection");
    }
    items.sort_by(|left, right| left.component_id.cmp(&right.component_id));

    let expected_bytes = items
        .iter()
        .fold(0_u64, |total, item| total.saturating_add(item.expected_bytes));
    let mut plan = ApplicationUninstallPlan {
        schema_version: APPLICATION_UNINSTALL_PLAN_SCHEMA_VERSION,
        plan_id: format!("plan-{}", uuid::Uuid::new_v4().simple()),
        plan_hash: String::new(),
        created_at_ms,
        application_id: candidate.application_id.clone(),
        catalog_revision: catalog_revision.to_string(),
        items,
        expected_bytes,
    };
    plan.plan_hash = plan_hash(&plan);
    Ok(plan)
}

/// Builds a plan from already-reviewed items. Used by unit tests to exercise
/// hash determinism and integrity checks without touching the filesystem.
#[allow(dead_code)]
pub(crate) fn create_reviewed_plan(
    application_id: &str,
    catalog_revision: &str,
    mut items: Vec<ApplicationUninstallPlanItem>,
    created_at_ms: u64,
) -> ApplicationUninstallPlan {
    items.sort_by(|left, right| left.component_id.cmp(&right.component_id));
    let expected_bytes = items
        .iter()
        .fold(0_u64, |total, item| total.saturating_add(item.expected_bytes));
    let mut plan = ApplicationUninstallPlan {
        schema_version: APPLICATION_UNINSTALL_PLAN_SCHEMA_VERSION,
        plan_id: format!("plan-{}", uuid::Uuid::new_v4().simple()),
        plan_hash: String::new(),
        created_at_ms,
        application_id: application_id.to_string(),
        catalog_revision: catalog_revision.to_string(),
        items,
        expected_bytes,
    };
    plan.plan_hash = plan_hash(&plan);
    plan
}

/// Verifies a plan's shape and hash.
pub(crate) fn validate_plan(plan: &ApplicationUninstallPlan) -> Result<(), &'static str> {
    if plan.schema_version != APPLICATION_UNINSTALL_PLAN_SCHEMA_VERSION {
        return Err("unsupported_plan_schema");
    }
    if !is_digest(&plan.plan_hash) {
        return Err("invalid_plan_hash");
    }
    if !plan.plan_id.starts_with("plan-") || plan.plan_id.len() != 5 + 32 {
        return Err("invalid_plan_id");
    }
    if !is_application_id(&plan.application_id) {
        return Err("invalid_application_id");
    }
    if plan.catalog_revision.trim().is_empty() {
        return Err("missing_catalog_revision");
    }
    if plan.items.is_empty() || plan.items.len() > MAX_PLAN_ITEMS {
        return Err("invalid_item_count");
    }
    let mut ids = Vec::with_capacity(plan.items.len());
    let mut native_installers = 0_usize;
    for item in &plan.items {
        if item.component_id.trim().is_empty() || item.component_id.len() > 128 {
            return Err("invalid_component_id");
        }
        if ids.iter().any(|id: &String| id == &item.component_id) {
            return Err("duplicate_component_id");
        }
        if !is_digest(&item.expected_snapshot_fingerprint) {
            return Err("invalid_component_fingerprint");
        }
        if item.kind == ApplicationUninstallComponentKind::NativeInstaller {
            native_installers += 1;
        }
        ids.push(item.component_id.clone());
    }
    if native_installers != 1 {
        return Err("plan_requires_one_native_installer");
    }
    let expected_bytes = plan
        .items
        .iter()
        .fold(0_u64, |total, item| total.saturating_add(item.expected_bytes));
    if plan.expected_bytes != expected_bytes {
        return Err("invalid_expected_bytes");
    }
    if plan_hash(plan) != plan.plan_hash {
        return Err("plan_hash_mismatch");
    }
    Ok(())
}

/// Deterministic plan hash. Items are hashed in component-ID order, so the
/// reviewed selection order never changes the hash.
pub(crate) fn plan_hash(plan: &ApplicationUninstallPlan) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(PLAN_DOMAIN.as_bytes());
    text(&mut hasher, &plan.plan_id);
    number(&mut hasher, u64::from(plan.schema_version));
    number(&mut hasher, plan.created_at_ms);
    text(&mut hasher, &plan.application_id);
    text(&mut hasher, &plan.catalog_revision);
    let mut items = plan.items.iter().collect::<Vec<_>>();
    items.sort_by(|left, right| left.component_id.cmp(&right.component_id));
    for item in items {
        text(&mut hasher, &item.component_id);
        text(&mut hasher, kind_code(item.kind));
        number(&mut hasher, item.expected_bytes);
        number(&mut hasher, item.expected_file_count);
        text(&mut hasher, &item.expected_snapshot_fingerprint);
    }
    number(&mut hasher, plan.expected_bytes);
    hasher.finalize().to_hex().to_string()
}

/// Creates a reviewed batch plan from per-application plans that all belong to
/// the same catalog revision.
pub(crate) fn create_batch_plan(
    plans: Vec<ApplicationUninstallPlan>,
    catalog_revision: &str,
    created_at_ms: u64,
) -> Result<ApplicationUninstallBatchPlan, &'static str> {
    let mut seen = Vec::with_capacity(plans.len());
    for plan in &plans {
        if plan.catalog_revision != catalog_revision {
            return Err("catalog_revision_mismatch");
        }
        if seen.iter().any(|id: &String| id == &plan.application_id) {
            return Err("duplicate_application");
        }
        seen.push(plan.application_id.clone());
    }
    if plans.is_empty() || plans.len() > MAX_BATCH_APPLICATIONS {
        return Err("invalid_batch_size");
    }
    let expected_bytes = plans
        .iter()
        .fold(0_u64, |total, plan| total.saturating_add(plan.expected_bytes));
    let mut batch = ApplicationUninstallBatchPlan {
        schema_version: APPLICATION_UNINSTALL_BATCH_PLAN_SCHEMA_VERSION,
        batch_id: format!("batch-{}", uuid::Uuid::new_v4().simple()),
        batch_hash: String::new(),
        created_at_ms,
        catalog_revision: catalog_revision.to_string(),
        plans,
        expected_bytes,
    };
    batch.batch_hash = batch_hash(&batch);
    Ok(batch)
}

/// Verifies a batch plan's shape, every contained plan, and its hash.
pub(crate) fn validate_batch_plan(
    batch: &ApplicationUninstallBatchPlan,
) -> Result<(), &'static str> {
    if batch.schema_version != APPLICATION_UNINSTALL_BATCH_PLAN_SCHEMA_VERSION {
        return Err("unsupported_batch_schema");
    }
    if !is_digest(&batch.batch_hash) {
        return Err("invalid_batch_hash");
    }
    if !batch.batch_id.starts_with("batch-") || batch.batch_id.len() != 6 + 32 {
        return Err("invalid_batch_id");
    }
    if batch.catalog_revision.trim().is_empty() {
        return Err("missing_catalog_revision");
    }
    if batch.plans.is_empty() || batch.plans.len() > MAX_BATCH_APPLICATIONS {
        return Err("invalid_batch_size");
    }
    let mut seen = Vec::with_capacity(batch.plans.len());
    for plan in &batch.plans {
        validate_plan(plan)?;
        if plan.catalog_revision != batch.catalog_revision {
            return Err("catalog_revision_mismatch");
        }
        if seen.iter().any(|id: &String| id == &plan.application_id) {
            return Err("duplicate_application");
        }
        seen.push(plan.application_id.clone());
    }
    let expected_bytes = batch
        .plans
        .iter()
        .fold(0_u64, |total, plan| total.saturating_add(plan.expected_bytes));
    if batch.expected_bytes != expected_bytes {
        return Err("invalid_expected_bytes");
    }
    if batch_hash(batch) != batch.batch_hash {
        return Err("batch_hash_mismatch");
    }
    Ok(())
}

/// Deterministic batch hash. Plans are hashed in application-ID order, so the
/// selection order never changes the hash.
pub(crate) fn batch_hash(batch: &ApplicationUninstallBatchPlan) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(BATCH_DOMAIN.as_bytes());
    text(&mut hasher, &batch.batch_id);
    number(&mut hasher, u64::from(batch.schema_version));
    number(&mut hasher, batch.created_at_ms);
    text(&mut hasher, &batch.catalog_revision);
    let mut plans = batch.plans.iter().collect::<Vec<_>>();
    plans.sort_by(|left, right| left.application_id.cmp(&right.application_id));
    for plan in plans {
        text(&mut hasher, &plan.application_id);
        text(&mut hasher, &plan.plan_hash);
    }
    number(&mut hasher, batch.expected_bytes);
    hasher.finalize().to_hex().to_string()
}

/// Validates the wire-level batch selection list before any catalog lookup.
pub(crate) fn validate_batch_selections(
    selections: &[ApplicationUninstallBatchSelection],
) -> Result<(), &'static str> {
    if selections.is_empty() || selections.len() > MAX_BATCH_APPLICATIONS {
        return Err("invalid_batch_size");
    }
    let mut ids = Vec::with_capacity(selections.len());
    for selection in selections {
        if !is_application_id(&selection.application_id) {
            return Err("invalid_application_id");
        }
        if ids.iter().any(|id: &String| id == &selection.application_id) {
            return Err("duplicate_application");
        }
        ids.push(selection.application_id.clone());
        if selection.component_ids.is_empty() || selection.component_ids.len() > MAX_PLAN_ITEMS {
            return Err("invalid_component_count");
        }
        let mut components = Vec::with_capacity(selection.component_ids.len());
        for id in &selection.component_ids {
            let id = id.trim();
            if id.is_empty() || id.len() > 128 {
                return Err("invalid_component_id");
            }
            if components.iter().any(|existing: &&str| *existing == id) {
                return Err("duplicate_component_id");
            }
            components.push(id);
        }
    }
    Ok(())
}

/// Stable wire-shape check for an opaque application identifier.
pub(crate) fn is_application_id(value: &str) -> bool {
    value.strip_prefix(APPLICATION_ID_PREFIX).is_some_and(|suffix| {
        suffix.len() == 24 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Length-prefixed canonical text encoding.
fn text(hasher: &mut blake3::Hasher, value: &str) {
    hasher.update(&(value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}

fn number(hasher: &mut blake3::Hasher, value: u64) {
    hasher.update(&value.to_le_bytes());
}

/// Stable component-kind code used inside the plan hash.
pub(crate) fn kind_code(kind: ApplicationUninstallComponentKind) -> &'static str {
    match kind {
        ApplicationUninstallComponentKind::ApplicationBinary => "application-binary",
        ApplicationUninstallComponentKind::NativeInstaller => "native-installer",
        ApplicationUninstallComponentKind::Cache => "cache",
        ApplicationUninstallComponentKind::ApplicationSupport => "application-support",
        ApplicationUninstallComponentKind::Preferences => "preferences",
        ApplicationUninstallComponentKind::Logs => "logs",
        ApplicationUninstallComponentKind::SavedState => "saved-state",
        ApplicationUninstallComponentKind::SandboxContainer => "sandbox-container",
        ApplicationUninstallComponentKind::WebData => "web-data",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::contracts::{ApplicationSourceIdentity, ApplicationInventorySource};
    use crate::applications::models::{
        ApplicationSystemKind, ApplicationUninstallCapability, ApplicationUninstallPlatform,
        ApplicationUninstallRecordState, ApplicationUninstallRisk,
    };
    use crate::platform::contracts::{ApplicationDateReadStatus, ApplicationDates};

    fn application(registration: ApplicationUninstallRegistration) -> InstalledApplication {
        InstalledApplication {
            catalog_identifier: "catalog-example".into(),
            primary_identifier: "Example.Key".into(),
            identifiers: vec!["Example.Key".into()],
            source_identities: vec![ApplicationSourceIdentity {
                source: ApplicationInventorySource::WindowsRegistry,
                identifier: "Example.Key".into(),
            }],
            system_signed: false,
            name: "Example".into(),
            version: Some("1.0".into()),
            publisher: None,
            estimated_bytes: 4_096,
            installed_at_ms: Some(1_700_000_000_000),
            icon_path: None,
            bundle_path: None,
            executable_paths: Vec::new(),
            uninstall_registration: Some(registration),
            uninstall_diagnostic: None,
        }
    }

    fn candidate(application_id: &str, bundle: Option<&Path>) -> ApplicationUninstallCandidate {
        let mut components = vec![ApplicationUninstallComponentSummary {
            component_id: "component-native".into(),
            kind: ApplicationUninstallComponentKind::NativeInstaller,
            risk: ApplicationUninstallRisk::Required,
            path: None,
            bytes: 4_096,
            file_count: 1,
            default_selected: true,
        }];
        if let Some(path) = bundle {
            components.push(ApplicationUninstallComponentSummary {
                component_id: "component-support".into(),
                kind: ApplicationUninstallComponentKind::ApplicationSupport,
                risk: ApplicationUninstallRisk::Rebuildable,
                path: Some(path.to_string_lossy().into_owned()),
                bytes: 8,
                file_count: 1,
                default_selected: false,
            });
        }
        ApplicationUninstallCandidate {
            application_id: application_id.into(),
            primary_identifier: "Example.Key".into(),
            source_identities: Vec::new(),
            system_kind: ApplicationSystemKind::Unclassified,
            name: "Example".into(),
            version: None,
            publisher: None,
            estimated_bytes: 4_096,
            dates: ApplicationDates {
                last_used: None,
                installed: None,
                read_status: ApplicationDateReadStatus::Complete,
            },
            platform: ApplicationUninstallPlatform::WindowsRegistry,
            installer_kind: None,
            execution_mode: None,
            capability: ApplicationUninstallCapability::Ready,
            record_state: ApplicationUninstallRecordState::Installed,
            uninstall_diagnostic: None,
            application_path: None,
            possible_related_paths: Vec::new(),
            icon_path: None,
            running_processes: Vec::new(),
            total_bytes: 4_096,
            default_selected_bytes: 4_096,
            associated_data_complete: false,
            components,
        }
    }

    fn example_application_id() -> String {
        format!("application-{}", "a".repeat(24))
    }

    fn registration() -> ApplicationUninstallRegistration {
        ApplicationUninstallRegistration::WindowsRegistered {
            key_name: "Example.Key".into(),
            scope: ApplicationInstallScope::CurrentUser,
            registry_view: WindowsRegistryView::Registry64,
            command_kind: crate::applications::contracts::WindowsRegisteredUninstallKind::Executable,
            command_digest: "b".repeat(64),
            estimated_bytes: 4_096,
        }
    }

    fn item(id: &str, bytes: u64, fingerprint: &str) -> ApplicationUninstallPlanItem {
        ApplicationUninstallPlanItem {
            component_id: id.into(),
            kind: ApplicationUninstallComponentKind::ApplicationSupport,
            expected_bytes: bytes,
            expected_file_count: 1,
            expected_snapshot_fingerprint: fingerprint.into(),
        }
    }

    fn native_item(id: &str, bytes: u64, fingerprint: &str) -> ApplicationUninstallPlanItem {
        ApplicationUninstallPlanItem {
            component_id: id.into(),
            kind: ApplicationUninstallComponentKind::NativeInstaller,
            expected_bytes: bytes,
            expected_file_count: 1,
            expected_snapshot_fingerprint: fingerprint.into(),
        }
    }

    #[test]
    fn plan_hash_is_deterministic_and_order_independent() {
        let digest = "c".repeat(64);
        let first = create_reviewed_plan(
            &example_application_id(),
            "revision-1",
            vec![
                item("component-b", 10, &digest),
                item("component-a", 20, &digest),
            ],
            1_700_000_000_000,
        );
        let mut second = create_reviewed_plan(
            &example_application_id(),
            "revision-1",
            vec![
                item("component-a", 20, &digest),
                item("component-b", 10, &digest),
            ],
            1_700_000_000_000,
        );
        // Identical inputs hash identically; the generated plan ID differs.
        second.plan_id = first.plan_id.clone();
        second.plan_hash = plan_hash(&second);
        assert_eq!(first.plan_hash, second.plan_hash);
    }

    #[test]
    fn plan_integrity_detects_tampering() {
        let digest = "c".repeat(64);
        let mut plan = create_reviewed_plan(
            &example_application_id(),
            "revision-1",
            vec![
                native_item("component-native", 10, &digest),
                item("component-a", 20, &digest),
            ],
            1_700_000_000_000,
        );
        let index = plan
            .items
            .iter()
            .position(|item| item.component_id == "component-a")
            .unwrap();
        plan.items[index].expected_bytes = 21;
        assert_eq!(validate_plan(&plan), Err("invalid_expected_bytes"));
        plan.expected_bytes = 31;
        assert_eq!(validate_plan(&plan), Err("plan_hash_mismatch"));
    }

    #[test]
    fn plan_requires_exactly_one_native_installer() {
        let digest = "c".repeat(64);
        let plan = create_reviewed_plan(
            &example_application_id(),
            "revision-1",
            vec![item("component-a", 20, &digest)],
            1_700_000_000_000,
        );
        assert_eq!(validate_plan(&plan), Err("plan_requires_one_native_installer"));
    }

    #[test]
    fn create_plan_always_includes_required_components() {
        let bundle = tempfile::tempdir().unwrap();
        std::fs::write(bundle.path().join("data.bin"), b"12345678").unwrap();
        let application_id = example_application_id();
        let candidate = candidate(&application_id, Some(bundle.path()));
        let plan = create_plan(
            &application(registration()),
            &candidate,
            &["component-support".to_string()],
            "revision-1",
            1_700_000_000_000,
        )
        .unwrap();
        assert_eq!(plan.items.len(), 2);
        assert!(plan
            .items
            .iter()
            .any(|item| item.kind == ApplicationUninstallComponentKind::NativeInstaller));
        assert!(plan
            .items
            .iter()
            .any(|item| item.kind == ApplicationUninstallComponentKind::ApplicationSupport));
        assert_eq!(validate_plan(&plan), Ok(()));
    }

    #[test]
    fn component_fingerprints_change_with_directory_content() {
        let bundle = tempfile::tempdir().unwrap();
        let application_id = example_application_id();
        let candidate = candidate(&application_id, Some(bundle.path()));
        let application = application(registration());
        let support = candidate
            .components
            .iter()
            .find(|component| component.path.is_some())
            .unwrap();
        let before = component_snapshot(&application, support).unwrap();
        std::fs::write(bundle.path().join("new.bin"), b"new-bytes").unwrap();
        let after = component_snapshot(&application, support).unwrap();
        assert_ne!(
            before.snapshot_fingerprint,
            after.snapshot_fingerprint
        );
        assert_ne!(before.bytes, after.bytes);
    }

    #[test]
    fn batch_rejects_duplicates_mixed_revisions_and_tampering() {
        let digest = "c".repeat(64);
        let native = |id: &str, revision: &str| {
            create_reviewed_plan(
                id,
                revision,
                vec![ApplicationUninstallPlanItem {
                    component_id: "component-native".into(),
                    kind: ApplicationUninstallComponentKind::NativeInstaller,
                    expected_bytes: 10,
                    expected_file_count: 1,
                    expected_snapshot_fingerprint: digest.clone(),
                }],
                1_700_000_000_000,
            )
        };
        let first = example_application_id();
        let second = format!("application-{}", "b".repeat(24));
        assert_eq!(
            create_batch_plan(vec![native(&first, "r1"), native(&first, "r1")], "r1", 7)
                .err(),
            Some("duplicate_application")
        );
        assert_eq!(
            create_batch_plan(vec![native(&first, "r1"), native(&second, "r2")], "r1", 7)
                .err(),
            Some("catalog_revision_mismatch")
        );
        let mut batch = create_batch_plan(vec![native(&first, "r1"), native(&second, "r1")], "r1", 7).unwrap();
        assert_eq!(validate_batch_plan(&batch), Ok(()));
        batch.expected_bytes += 1;
        assert_eq!(validate_batch_plan(&batch), Err("invalid_expected_bytes"));
    }

    #[test]
    fn selection_validation_rejects_duplicates_and_empty_components() {
        let first = example_application_id();
        let second = format!("application-{}", "b".repeat(24));
        let ok = ApplicationUninstallBatchSelection {
            application_id: first.clone(),
            component_ids: vec!["component-native".into()],
        };
        assert_eq!(validate_batch_selections(&[ok.clone()]), Ok(()));
        assert_eq!(
            validate_batch_selections(&[ok.clone(), ok.clone()]),
            Err("duplicate_application")
        );
        assert_eq!(
            validate_batch_selections(&[ApplicationUninstallBatchSelection {
                application_id: second,
                component_ids: vec![" ".into()],
            }]),
            Err("invalid_component_id")
        );
        assert_eq!(
            validate_batch_selections(&[ApplicationUninstallBatchSelection {
                application_id: first,
                component_ids: Vec::new(),
            }]),
            Err("invalid_component_count")
        );
    }

    #[test]
    fn registration_digest_is_stable_and_field_sensitive() {
        let first = registration();
        assert_eq!(registration_digest(&first), registration_digest(&first));
        let mut other = registration();
        if let ApplicationUninstallRegistration::WindowsRegistered {
            command_digest, ..
        } = &mut other
        {
            *command_digest = "d".repeat(64);
        }
        assert_ne!(registration_digest(&first), registration_digest(&other));
    }

    #[test]
    fn pathless_component_fingerprint_requires_a_registration() {
        let application_id = example_application_id();
        let candidate = candidate(&application_id, None);
        let mut application = application(registration());
        application.uninstall_registration = None;
        let native = &candidate.components[0];
        assert_eq!(
            component_snapshot(&application, native).unwrap_err(),
            ComponentSnapshotError::Unavailable
        );
    }
}
