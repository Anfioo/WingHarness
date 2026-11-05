//! The captured application catalog used by uninstall inspection and process
//! control.
//!
//! A catalog is one immutable snapshot: the merged inventory, the process
//! snapshot taken beside it, and the derived wire candidates. Everything the UI
//! selects by opaque application ID is resolved back through this snapshot, so
//! a request can never name an arbitrary path or process.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::applications::contracts::{
    self, ApplicationInstallScope, ApplicationProcessTarget, ApplicationUninstallRegistration,
    Cancellation, InstalledApplication, RunningProcessIdentity, SystemInventory,
};
use crate::applications::models::{
    ApplicationScanStage, ApplicationUninstallCandidate, ApplicationUninstallCapability,
    ApplicationUninstallComponentKind, ApplicationUninstallComponentSummary,
    ApplicationUninstallPlatform, ApplicationUninstallRecordState, ApplicationUninstallRisk,
    ApplicationUninstallScanResult, ApplicationUninstallSourceIdentity,
    APPLICATION_UNINSTALL_SCAN_SCHEMA_VERSION,
};
use crate::applications::progress::ApplicationScanProgressReporter;
use crate::applications::uninstall::system_classification;
use crate::applications::{process_control, running_identity, usage};
use crate::platform::contracts::{
    ApplicationDate, ApplicationDateReadStatus, ApplicationDateSource, ApplicationDates,
};
use crate::platform::windows::{inventory, package_evidence, package_locations};

const CURRENT_APPLICATION_NAME: &str = "WingHarness";

/// One installed-application catalog captured in a single pass.
pub(crate) struct Catalog {
    pub(crate) revision: String,
    pub(crate) inventory: SystemInventory,
    pub(crate) processes: ProcessSnapshot,
    pub(crate) scan: ApplicationUninstallScanResult,
    candidate_index: HashMap<String, usize>,
    application_index: HashMap<String, usize>,
}

impl Catalog {
    pub(crate) fn candidate(&self, application_id: &str) -> Option<&ApplicationUninstallCandidate> {
        self.candidate_index
            .get(application_id)
            .and_then(|index| self.scan.candidates.get(*index))
    }

    pub(crate) fn application(&self, application_id: &str) -> Option<&InstalledApplication> {
        self.application_index
            .get(application_id)
            .and_then(|index| self.inventory.applications.get(*index))
    }

    pub(crate) fn candidates(&self) -> &[ApplicationUninstallCandidate] {
        &self.scan.candidates
    }

    pub(crate) fn applications(&self) -> &[InstalledApplication] {
        &self.inventory.applications
    }

    /// Stable process-close identity for the trusted application record.
    ///
    /// Exact executable paths are the primary authority. Names are supplied
    /// only for records that publish no executable path; mixing both would let a
    /// common helper name authorize closing another installation.
    pub(crate) fn process_target(&self, application_id: &str) -> Option<ApplicationProcessTarget> {
        let application = self.application(application_id)?;
        let candidate = self.candidate(application_id)?;
        let executable_names = if application.executable_paths.is_empty() {
            let mut names = candidate.running_processes.clone();
            if !candidate.name.trim().is_empty() {
                names.push(candidate.name.clone());
            }
            if !candidate.primary_identifier.trim().is_empty() {
                names.push(candidate.primary_identifier.clone());
            }
            names.sort_by_key(|name| name.to_ascii_lowercase());
            names.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
            names
        } else {
            Vec::new()
        };
        Some(ApplicationProcessTarget {
            executable_names,
            executable_paths: application.executable_paths.clone(),
        })
    }
}

/// Captures the inventory and the process snapshot, then derives the scan.
pub(crate) fn capture(
    cancellation: &Cancellation,
    progress: &ApplicationScanProgressReporter<'_>,
) -> Result<Catalog, String> {
    let started = Instant::now();
    let inventory = inventory::capture_inventory(cancellation, progress).map_err(|error| {
        log::warn!(
            "windows_application_catalog_inventory_failed code={:?} diagnostic={}",
            error.code(),
            error.diagnostic()
        );
        error.diagnostic().to_string()
    })?;
    if cancellation.is_cancelled() {
        return Err("windows_application_catalog_cancelled".to_string());
    }
    progress.report(ApplicationScanStage::CheckingProcesses, 76);
    let processes = ProcessSnapshot::capture(cancellation)?;
    if cancellation.is_cancelled() {
        return Err("windows_application_catalog_cancelled".to_string());
    }
    progress.report(ApplicationScanStage::CheckingProcesses, 82);

    let captured_at = now_millis();
    let observations = usage::dates();
    let mut candidates = Vec::with_capacity(inventory.applications.len());
    let mut application_index = HashMap::with_capacity(inventory.applications.len());
    let mut hidden_count = 0_u64;
    let total_applications = inventory.applications.len() as u64;
    for (index, application) in inventory.applications.iter().enumerate() {
        if is_current_application(application) {
            hidden_count = hidden_count.saturating_add(1);
            continue;
        }
        let application_id = contracts::application_id_for(&application.catalog_identifier);
        let mut candidate = build_candidate(application, &processes, captured_at, &application_id);
        apply_usage(&mut candidate, application, &observations, captured_at);
        application_index.insert(application_id.clone(), index);
        candidates.push(candidate);
        // Validating every entry is cheap but not instant, and an inventory of
        // a few hundred entries still feels stalled without a tick.
        if index % 16 == 0 || index + 1 == inventory.applications.len() {
            progress.report_items(
                ApplicationScanStage::ValidatingApplications,
                82 + ((index as u64 + 1) * 16 / total_applications.max(1)) as u8,
                index as u64 + 1,
                Some(total_applications),
                Some(application.name.clone()),
            );
        }
    }
    candidates.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.application_id.cmp(&right.application_id))
    });
    let candidate_index = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| (candidate.application_id.clone(), index))
        .collect::<HashMap<_, _>>();
    let ready_count = candidates
        .iter()
        .filter(|candidate| supports_execution(candidate.capability))
        .count() as u64;
    let blocked_count = candidates.len() as u64 - ready_count;
    let revision = inventory.revision.clone();
    let scan = ApplicationUninstallScanResult {
        schema_version: APPLICATION_UNINSTALL_SCAN_SCHEMA_VERSION,
        scanned_at_ms: captured_at,
        supported: true,
        execution_supported: true,
        // The registry and AppX evidence must be complete before a destructive
        // action may trust the catalog.
        catalog_actionable: inventory.complete,
        inventory_complete: inventory.complete,
        catalog_revision: (!revision.is_empty()).then(|| revision.clone()),
        candidates,
        ready_count,
        blocked_count,
        hidden_count,
        related_directory_count: 0,
        related_path_scan_elapsed_ms: 0,
        elapsed_ms: elapsed_millis(started),
    };
    log::info!(
        "windows_application_catalog_ready candidate_count={} ready_count={} blocked_count={} hidden_count={} inventory_complete={} catalog_actionable={} process_count={} elapsed_ms={}",
        scan.candidates.len(),
        ready_count,
        blocked_count,
        hidden_count,
        inventory.complete,
        scan.catalog_actionable,
        processes.process_count,
        scan.elapsed_ms,
    );
    Ok(Catalog {
        revision,
        inventory,
        processes,
        scan,
        candidate_index,
        application_index,
    })
}

/// Running-process evidence captured beside the inventory.
#[derive(Debug, Default)]
pub(crate) struct ProcessSnapshot {
    running_processes: HashSet<String>,
    running_executable_paths: HashSet<String>,
    unresolved_process_names: HashSet<String>,
    identities: Vec<RunningProcessIdentity>,
    pub(crate) process_count: usize,
}

impl ProcessSnapshot {
    pub(crate) fn capture(cancellation: &Cancellation) -> Result<Self, String> {
        let identities = process_control::running_identities(cancellation)?;
        Ok(Self::from_process_identities(identities))
    }

    pub(crate) fn matching_processes(&self, names: &[String]) -> Vec<String> {
        names
            .iter()
            .filter(|name| {
                process_aliases(name)
                    .iter()
                    .any(|alias| self.running_processes.contains(alias))
            })
            .cloned()
            .collect()
    }

    pub(crate) fn contains_any(&self, names: &[String]) -> bool {
        names.iter().any(|name| {
            process_aliases(name)
                .iter()
                .any(|alias| self.running_processes.contains(alias))
        })
    }

    pub(crate) fn matching_application_processes(
        &self,
        identity_names: &[String],
        executable_paths: &[PathBuf],
    ) -> Vec<String> {
        let mut matches = if executable_paths.is_empty() {
            self.matching_processes(identity_names)
        } else {
            executable_paths
                .iter()
                .filter_map(|path| {
                    let normalized = running_identity::path_identity_key(path);
                    let display_name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_else(|| normalized.clone());
                    let exact_path_match = self.running_executable_paths.contains(&normalized);
                    let unresolved_name_match = process_aliases(&display_name)
                        .iter()
                        .any(|alias| self.unresolved_process_names.contains(alias));
                    (exact_path_match || unresolved_name_match).then_some(display_name)
                })
                .collect()
        };
        matches.sort_by_key(|value| value.to_ascii_lowercase());
        matches.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        matches
    }

    /// Resolves a stable executable identity to the captured executable path.
    pub(crate) fn executable_path_for_id(&self, application_id: &str) -> Option<PathBuf> {
        self.identities
            .iter()
            .filter_map(|identity| identity.executable_path.as_ref())
            .find(|path| running_identity::executable_id(path) == application_id)
            .cloned()
    }

    /// Builds a snapshot from already captured identities. Used by the process
    /// lanes and by unit tests that must not query the operating system.
    pub(crate) fn from_process_identities(identities: Vec<RunningProcessIdentity>) -> Self {
        let process_count = identities.len();
        let mut running_processes = HashSet::new();
        let mut running_executable_paths = HashSet::new();
        let mut unresolved_process_names = HashSet::new();
        for process in &identities {
            running_processes.extend(process_aliases(&process.executable_name));
            match process.executable_path.as_ref() {
                Some(path) => {
                    running_executable_paths
                        .insert(running_identity::path_identity_key(path));
                }
                None => unresolved_process_names
                    .extend(process_aliases(&process.executable_name)),
            }
        }
        Self {
            running_processes,
            running_executable_paths,
            unresolved_process_names,
            identities,
            process_count,
        }
    }
}

fn build_candidate(
    application: &InstalledApplication,
    processes: &ProcessSnapshot,
    captured_at: u64,
    application_id: &str,
) -> ApplicationUninstallCandidate {
    let running_processes = processes.matching_application_processes(
        &[
            application.name.clone(),
            application.primary_identifier.clone(),
        ],
        &application.executable_paths,
    );
    let application_path = application
        .bundle_path
        .as_deref()
        .filter(|path| path.exists())
        .or_else(|| {
            application
                .executable_paths
                .iter()
                .map(PathBuf::as_path)
                .find(|path| path.exists())
        })
        .map(display_path);
    // Package roots live under the access-controlled WindowsApps tree, where
    // Explorer prompts for permanent access instead of revealing the package.
    let application_path = if matches!(
        application.uninstall_registration.as_ref(),
        Some(ApplicationUninstallRegistration::WindowsAppx { .. })
    ) {
        None
    } else {
        application_path
    };
    let (components, associated_data_complete) = summarize_components(application, application_id);
    let total_bytes = components
        .iter()
        .fold(0_u64, |total, component| total.saturating_add(component.bytes));
    let default_selected_bytes = components
        .iter()
        .filter(|component| component.default_selected)
        .fold(0_u64, |total, component| total.saturating_add(component.bytes));
    let record_state = if running_processes.is_empty()
        && package_evidence::registration_is_orphaned(
            application.uninstall_registration.is_some(),
            application.uninstall_diagnostic,
            application.bundle_path.as_deref(),
            &application.executable_paths,
        )
    {
        ApplicationUninstallRecordState::OrphanedRegistration
    } else {
        ApplicationUninstallRecordState::Installed
    };
    ApplicationUninstallCandidate {
        application_id: application_id.to_string(),
        primary_identifier: application.primary_identifier.clone(),
        source_identities: application
            .source_identities
            .iter()
            .map(|identity| ApplicationUninstallSourceIdentity {
                source: identity.source.to_model(),
                identifier: identity.identifier.clone(),
            })
            .collect(),
        system_kind: system_classification::classify_application(application),
        name: application.name.clone(),
        version: application.version.clone(),
        publisher: application.publisher.clone(),
        estimated_bytes: application.estimated_bytes,
        dates: ApplicationDates {
            last_used: None,
            installed: application.installed_at_ms.and_then(|timestamp| {
                ApplicationDate::new(timestamp, ApplicationDateSource::PlatformReported, captured_at)
            }),
            read_status: ApplicationDateReadStatus::Complete,
        },
        platform: ApplicationUninstallPlatform::WindowsRegistry,
        installer_kind: application
            .uninstall_registration
            .as_ref()
            .map(ApplicationUninstallRegistration::installer_kind),
        execution_mode: application
            .uninstall_registration
            .as_ref()
            .map(ApplicationUninstallRegistration::execution_mode),
        capability: capability(application, &running_processes),
        record_state,
        uninstall_diagnostic: application
            .uninstall_diagnostic
            .filter(|_| application.uninstall_registration.is_none()),
        application_path,
        possible_related_paths: Vec::new(),
        icon_path: application.icon_path.as_deref().map(display_path),
        running_processes,
        total_bytes: if total_bytes == 0 {
            application.estimated_bytes
        } else {
            total_bytes
        },
        default_selected_bytes,
        associated_data_complete,
        components,
    }
}

fn summarize_components(
    application: &InstalledApplication,
    application_id: &str,
) -> (Vec<ApplicationUninstallComponentSummary>, bool) {
    let mut components = Vec::new();
    if let Some(registration) = application.uninstall_registration.as_ref() {
        components.push(ApplicationUninstallComponentSummary {
            component_id: component_id(application_id, native_identity(registration)),
            kind: ApplicationUninstallComponentKind::NativeInstaller,
            risk: ApplicationUninstallRisk::Required,
            path: None,
            bytes: registration.estimated_bytes(),
            file_count: 1,
            default_selected: true,
        });
    }
    if let Some(path) = application
        .bundle_path
        .as_deref()
        .filter(|path| path.is_dir())
    {
        let (bytes, file_count) = package_locations::bounded_directory_size(path);
        components.push(ApplicationUninstallComponentSummary {
            component_id: component_id(
                application_id,
                &format!(
                    "install-directory:{}",
                    running_identity::path_identity_key(path)
                ),
            ),
            kind: ApplicationUninstallComponentKind::ApplicationSupport,
            risk: ApplicationUninstallRisk::Rebuildable,
            path: Some(display_path(path)),
            bytes,
            file_count,
            default_selected: false,
        });
    }
    // Registry evidence alone does not prove that every cache or preference
    // path belongs to this application, so associated data stays incomplete.
    (components, false)
}

fn native_identity(registration: &ApplicationUninstallRegistration) -> &str {
    match registration {
        ApplicationUninstallRegistration::WindowsMsi { product_code, .. } => product_code,
        ApplicationUninstallRegistration::WindowsAppx {
            package_full_name, ..
        } => package_full_name,
        ApplicationUninstallRegistration::WindowsRegistered { key_name, .. } => key_name,
        ApplicationUninstallRegistration::Winget { package_id, .. } => package_id,
    }
}

fn component_id(application_id: &str, identity: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"systools-windows-application-component-v1");
    hasher.update(application_id.as_bytes());
    hasher.update(identity.as_bytes());
    format!("component-{}", &hasher.finalize().to_hex()[..24])
}

fn apply_usage(
    candidate: &mut ApplicationUninstallCandidate,
    application: &InstalledApplication,
    observations: &HashMap<(String, PathBuf), u64>,
    captured_at: u64,
) {
    let timestamp = application
        .bundle_path
        .as_ref()
        .and_then(|path| {
            observations.get(&(application.primary_identifier.clone(), path.clone()))
        })
        .or_else(|| {
            application.executable_paths.first().and_then(|path| {
                observations.get(&(application.primary_identifier.clone(), path.clone()))
            })
        })
        .or_else(|| {
            application.bundle_path.as_ref().and_then(|path| {
                observations.get(&(application.catalog_identifier.clone(), path.clone()))
            })
        });
    let Some(timestamp) = timestamp else {
        return;
    };
    // Observations are recorded by this application, not reported by Windows,
    // but they are still a direct timestamp rather than an estimate.
    if let Some(date) =
        ApplicationDate::new(*timestamp, ApplicationDateSource::PlatformReported, captured_at)
    {
        if candidate
            .dates
            .last_used
            .as_ref()
            .is_none_or(|current| current.timestamp_ms < date.timestamp_ms)
        {
            candidate.dates.last_used = Some(date);
        }
    }
}

fn capability(
    application: &InstalledApplication,
    running_processes: &[String],
) -> ApplicationUninstallCapability {
    let Some(registration) = application.uninstall_registration.as_ref() else {
        return ApplicationUninstallCapability::ViewOnly;
    };
    if !running_processes.is_empty() {
        return ApplicationUninstallCapability::ApplicationRunning;
    }
    if matches!(
        registration,
        ApplicationUninstallRegistration::WindowsMsi {
            scope: ApplicationInstallScope::Machine,
            ..
        }
    ) {
        return ApplicationUninstallCapability::RequiresElevation;
    }
    ApplicationUninstallCapability::Ready
}

const fn supports_execution(capability: ApplicationUninstallCapability) -> bool {
    matches!(
        capability,
        ApplicationUninstallCapability::Ready | ApplicationUninstallCapability::RequiresElevation
    )
}

fn is_current_application(application: &InstalledApplication) -> bool {
    if application
        .identifiers
        .iter()
        .chain(std::iter::once(&application.primary_identifier))
        .any(|identifier| identifier.eq_ignore_ascii_case(CURRENT_APPLICATION_NAME))
        || application
            .name
            .eq_ignore_ascii_case(CURRENT_APPLICATION_NAME)
    {
        return true;
    }
    let Ok(current) = std::env::current_exe() else {
        return false;
    };
    let current_key = running_identity::path_identity_key(&current);
    application
        .executable_paths
        .iter()
        .chain(application.bundle_path.iter())
        .any(|path| running_identity::path_identity_key(path) == current_key)
}

fn process_aliases(value: &str) -> Vec<String> {
    let normalized = value.replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or(&normalized);
    let mut aliases = vec![normalize(name)];
    if let Some(without_exe) = aliases[0].strip_suffix(".exe") {
        aliases.push(without_exe.to_string());
    }
    if let Some(without_app) = aliases[0].strip_suffix(".app") {
        aliases.push(without_app.to_string());
    }
    aliases
}

fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn display_path(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(name: &str, path: Option<&str>) -> RunningProcessIdentity {
        RunningProcessIdentity {
            executable_name: name.to_string(),
            executable_path: path.map(PathBuf::from),
        }
    }

    #[test]
    fn process_names_match_with_and_without_the_exe_suffix() {
        let snapshot = ProcessSnapshot::from_process_identities(vec![
            identity("Example.exe", Some(r"C:\Apps\Example\Example.exe")),
            identity("Other.exe", Some(r"C:\Apps\Other\Other.exe")),
        ]);
        assert_eq!(
            snapshot.matching_processes(&["example".to_string()]),
            vec!["example".to_string()]
        );
        assert!(snapshot.contains_any(&["other".to_string()]));
        assert!(!snapshot.contains_any(&["missing".to_string()]));
    }

    #[test]
    fn exact_paths_take_precedence_over_process_names() {
        let snapshot = ProcessSnapshot::from_process_identities(vec![
            identity("Shared.exe", Some(r"C:\Other\Shared.exe")),
            identity("Shared.exe", Some(r"C:\Expected\Shared.exe")),
        ]);
        assert_eq!(
            snapshot.matching_application_processes(
                &["Shared".to_string()],
                &[PathBuf::from(r"C:\Expected\Shared.exe")],
            ),
            vec!["Shared.exe".to_string()]
        );
        assert!(snapshot
            .matching_application_processes(
                &["Shared".to_string()],
                &[PathBuf::from(r"C:\Missing\Shared.exe")],
            )
            .is_empty());
    }

    #[test]
    fn unresolved_names_are_only_trusted_when_no_exact_path_is_known() {
        let snapshot = ProcessSnapshot::from_process_identities(vec![identity(
            "Example.exe",
            None,
        )]);
        assert_eq!(
            snapshot.matching_application_processes(
                &["Example".to_string()],
                &[PathBuf::from(r"C:\Program Files\Example\Example.exe")],
            ),
            vec!["Example.exe".to_string()]
        );
        let snapshot = ProcessSnapshot::from_process_identities(vec![identity(
            "Example.exe",
            Some(r"C:\Other\Example.exe"),
        )]);
        assert!(snapshot
            .matching_application_processes(
                &["Example".to_string()],
                &[PathBuf::from(r"C:\Program Files\Example\Example.exe")],
            )
            .is_empty());
    }

    #[test]
    fn capabilities_support_execution_only_when_ready_or_elevated() {
        assert!(supports_execution(ApplicationUninstallCapability::Ready));
        assert!(supports_execution(
            ApplicationUninstallCapability::RequiresElevation
        ));
        for capability in [
            ApplicationUninstallCapability::ApplicationRunning,
            ApplicationUninstallCapability::ProtectedApplication,
            ApplicationUninstallCapability::ViewOnly,
        ] {
            assert!(!supports_execution(capability));
        }
    }

    #[test]
    fn process_aliases_are_case_and_extension_insensitive() {
        assert_eq!(process_aliases(r"C:\Apps\Example.EXE"), vec!["example.exe", "example"]);
        assert_eq!(process_aliases("bare"), vec!["bare"]);
    }

    /// Read-only probe against the live machine. Run manually:
    /// `cargo test -p systools-core --lib live_inventory_probe -- --ignored --nocapture`
    #[test]
    #[ignore = "reads the live Windows inventory; run manually"]
    fn live_inventory_probe() {
        let silent = |_: crate::applications::models::ApplicationScanProgress| {};
        let progress = ApplicationScanProgressReporter::new(&silent);
        let catalog =
            capture(&Cancellation::new(), &progress).expect("live inventory capture failed");
        let mut registry = 0;
        let mut appx = 0;
        let mut winget = 0;
        for candidate in catalog.candidates() {
            for identity in &candidate.source_identities {
                match identity.source {
                    crate::applications::models::ApplicationUninstallInventorySource::WindowsRegistry => registry += 1,
                    crate::applications::models::ApplicationUninstallInventorySource::WindowsAppx => appx += 1,
                    crate::applications::models::ApplicationUninstallInventorySource::Winget => winget += 1,
                    _ => {}
                }
            }
        }
        println!(
            "candidates={} applications={} complete={} registry={} appx={} winget={}",
            catalog.candidates().len(),
            catalog.applications().len(),
            catalog.inventory.complete,
            registry,
            appx,
            winget,
        );
        for candidate in catalog.candidates().iter().take(10) {
            println!(
                "  {} | {:?} | {:?} | {} bytes",
                candidate.name, candidate.capability, candidate.system_kind, candidate.estimated_bytes
            );
        }
        assert!(!catalog.candidates().is_empty());
    }
}
