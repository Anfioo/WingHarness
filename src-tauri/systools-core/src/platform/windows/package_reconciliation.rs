//! Merge rules for the Windows application inventory.
//!
//! Registry views (64-bit, 32-bit, machine, per-user) frequently publish the
//! same product more than once. Records are grouped by normalized name,
//! publisher, and version; the machine-scope registration stays primary and
//! every other view only enriches it. AppX packages merge into a matching
//! registry identity when one exists, and `winget list` is used only as a
//! non-authoritative identity hint.

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

use crate::applications::contracts::{
    ApplicationInstallScope, ApplicationSourceIdentity, ApplicationUninstallRegistration,
    ApplicationInventorySource, InstalledApplication, WindowsRegistryView,
};
use crate::platform::contracts::{ApplicationUninstallDiagnostic, PlatformError};

use super::package_locations::{bounded_directory_size, package_icon_path};
use super::package_sources::{PackagedApplicationRecord, WingetProduct};

/// One uninstall-registry entry before reconciliation.
#[derive(Debug, Clone)]
pub(crate) struct RegistryRecord {
    pub(crate) key_name: String,
    pub(crate) scope: ApplicationInstallScope,
    pub(crate) registry_view: WindowsRegistryView,
    pub(crate) name: String,
    pub(crate) version: Option<String>,
    pub(crate) publisher: Option<String>,
    pub(crate) estimated_bytes: u64,
    pub(crate) installed_at_ms: Option<u64>,
    pub(crate) icon_path: Option<PathBuf>,
    pub(crate) install_location: Option<PathBuf>,
    pub(crate) executable_paths: Vec<PathBuf>,
    pub(crate) uninstall_registration: Option<ApplicationUninstallRegistration>,
    pub(crate) uninstall_diagnostic: Option<ApplicationUninstallDiagnostic>,
}

/// Collapses duplicate registry publications of one product.
pub(crate) fn merge_registry_records(records: Vec<RegistryRecord>) -> Vec<InstalledApplication> {
    let mut groups = HashMap::<String, Vec<RegistryRecord>>::new();
    for record in records {
        groups.entry(dedupe_key(&record)).or_default().push(record);
    }
    let mut keys = groups.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    keys.into_iter()
        .filter_map(|key| groups.remove(&key))
        .map(build_application)
        .collect()
}

/// Merges AppX packages into the inventory.
pub(crate) fn merge_packaged_applications(
    applications: &mut Vec<InstalledApplication>,
    packages: Vec<PackagedApplicationRecord>,
) {
    for package in packages {
        if package.package_family_name.is_empty()
            || package.name.is_empty()
            || package.install_location.is_empty()
        {
            continue;
        }
        let install_location = PathBuf::from(&package.install_location);
        let (estimated_bytes, _file_count) = bounded_directory_size(&install_location);
        let executable_path = (!package.executable.is_empty())
            .then(|| install_location.join(&package.executable))
            .filter(|path| path.is_file());
        let icon_path = package_icon_path(&install_location, &package.icon)
            .or_else(|| Some(install_location.clone()));
        let registration = ApplicationUninstallRegistration::WindowsAppx {
            package_family_name: package.package_family_name.clone(),
            package_full_name: package.package_full_name.clone(),
            estimated_bytes,
        };
        let existing = applications.iter_mut().find(|application| {
            application.identifiers.iter().any(|identifier| {
                identifier.eq_ignore_ascii_case(&package.package_family_name)
                    || identifier.eq_ignore_ascii_case(&package.package_full_name)
            })
        });
        if let Some(application) = existing {
            push_source_identity(
                &mut application.source_identities,
                ApplicationSourceIdentity {
                    source: ApplicationInventorySource::WindowsAppx,
                    identifier: package.package_family_name.clone(),
                },
            );
            for identifier in [&package.package_family_name, &package.package_full_name] {
                if !application
                    .identifiers
                    .iter()
                    .any(|value| value.eq_ignore_ascii_case(identifier))
                {
                    application.identifiers.push(identifier.clone());
                }
            }
            // Only an exact package identity may upgrade a display-only
            // registry record to an executable uninstall candidate.
            application.system_signed |= package.system_signed;
            application.estimated_bytes = estimated_bytes;
            application.icon_path = icon_path;
            application.bundle_path = Some(install_location);
            if let Some(path) = executable_path {
                if !application.executable_paths.contains(&path) {
                    application.executable_paths.push(path);
                }
            }
            application.uninstall_registration = Some(registration);
            application.uninstall_diagnostic = None;
            continue;
        }
        let (bundle_path, executable_paths) = match executable_path {
            Some(path) => (install_location.clone(), vec![path]),
            None => (install_location.clone(), Vec::new()),
        };
        applications.push(InstalledApplication {
            catalog_identifier: format!(
                "windows-appx:{}",
                package.package_family_name.to_ascii_lowercase()
            ),
            primary_identifier: package.package_family_name.clone(),
            identifiers: vec![
                package.package_family_name.clone(),
                package.package_full_name,
                package.name.clone(),
            ],
            source_identities: vec![ApplicationSourceIdentity {
                source: ApplicationInventorySource::WindowsAppx,
                identifier: package.package_family_name.clone(),
            }],
            system_signed: package.system_signed,
            name: package.name,
            version: (!package.version.is_empty()).then_some(package.version),
            publisher: (!package.publisher.is_empty()).then_some(package.publisher),
            estimated_bytes,
            installed_at_ms: super::package_locations::path_timestamp_millis(&bundle_path),
            icon_path,
            bundle_path: Some(bundle_path),
            executable_paths,
            uninstall_registration: Some(registration),
            uninstall_diagnostic: None,
        });
    }
}

/// Adds `winget list` package identifiers to uniquely named applications.
///
/// `winget list` has no publisher column, so a name shared by several
/// applications is ambiguous and is never matched. Source identities are
/// evidence only; this function never creates an uninstall registration.
pub(crate) fn merge_winget_products(
    applications: &mut [InstalledApplication],
    products: Vec<WingetProduct>,
) {
    for product in products {
        let key = normalize_fact(&product.name);
        if key.is_empty() {
            continue;
        }
        let matches = applications
            .iter()
            .enumerate()
            .filter(|(_, application)| normalize_fact(&application.name) == key)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let [index] = matches.as_slice() else {
            continue;
        };
        let application = &mut applications[*index];
        push_source_identity(
            &mut application.source_identities,
            ApplicationSourceIdentity {
                source: ApplicationInventorySource::Winget,
                identifier: product.package_id.clone(),
            },
        );
        if !application
            .identifiers
            .iter()
            .any(|value| value.eq_ignore_ascii_case(&product.package_id))
        {
            application.identifiers.push(product.package_id);
        }
    }
}

fn build_application(mut records: Vec<RegistryRecord>) -> InstalledApplication {
    records.sort_by(|left, right| {
        scope_rank(left.scope)
            .cmp(&scope_rank(right.scope))
            .then_with(|| left.key_name.to_ascii_lowercase().cmp(&right.key_name.to_ascii_lowercase()))
    });
    let primary = &records[0];

    let mut registration = None;
    let mut conflict = false;
    for record in &records {
        let Some(candidate) = record.uninstall_registration.as_ref() else {
            continue;
        };
        match registration.as_ref() {
            Some(existing) if !registrations_are_compatible(existing, candidate) => {
                conflict = true;
            }
            Some(_) => {}
            None => registration = Some(candidate.clone()),
        }
    }
    let diagnostic = if conflict {
        Some(ApplicationUninstallDiagnostic::RegistrationConflict)
    } else if registration.is_none() {
        records
            .iter()
            .find_map(|record| record.uninstall_diagnostic)
    } else {
        None
    };

    let mut identifiers = BTreeSet::new();
    let mut source_identities = Vec::new();
    let mut executable_paths = Vec::new();
    let mut estimated_bytes = 0_u64;
    let mut installed_at_ms = None;
    let mut icon_path = None;
    let mut install_location = None;
    for record in &records {
        identifiers.insert(record.key_name.clone());
        identifiers.insert(record.name.clone());
        identifiers.insert(format!("{}:{}", scope_code(record.scope), record.key_name));
        if let Some(publisher) = record.publisher.as_deref() {
            identifiers.insert(format!("{publisher}/{}", record.name));
        }
        push_source_identity(
            &mut source_identities,
            ApplicationSourceIdentity {
                source: ApplicationInventorySource::WindowsRegistry,
                identifier: format!("{}:{}", scope_code(record.scope), record.key_name),
            },
        );
        if let Some(ApplicationUninstallRegistration::WindowsMsi { product_code, .. }) =
            record.uninstall_registration.as_ref()
        {
            identifiers.insert(product_code.clone());
            push_source_identity(
                &mut source_identities,
                ApplicationSourceIdentity {
                    source: ApplicationInventorySource::WindowsMsi,
                    identifier: product_code.clone(),
                },
            );
        }
        for path in &record.executable_paths {
            if !executable_paths.contains(path) {
                executable_paths.push(path.clone());
            }
        }
        estimated_bytes = estimated_bytes.max(record.estimated_bytes);
        installed_at_ms = installed_at_ms.or(record.installed_at_ms);
        if icon_path.is_none() {
            icon_path.clone_from(&record.icon_path);
        }
        if install_location.is_none() {
            install_location.clone_from(&record.install_location);
        }
    }

    InstalledApplication {
        catalog_identifier: format!(
            "windows-registry:{}:{}",
            scope_code(primary.scope),
            primary.key_name.to_ascii_lowercase()
        ),
        primary_identifier: primary.key_name.clone(),
        identifiers: identifiers.into_iter().collect(),
        source_identities,
        system_signed: false,
        name: primary.name.clone(),
        version: primary.version.clone(),
        publisher: primary.publisher.clone(),
        estimated_bytes,
        installed_at_ms,
        icon_path,
        bundle_path: install_location,
        executable_paths,
        uninstall_registration: registration.filter(|_| !conflict),
        uninstall_diagnostic: diagnostic,
    }
}

fn dedupe_key(record: &RegistryRecord) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}",
        normalize_fact(&record.name),
        normalize_fact(record.publisher.as_deref().unwrap_or_default()),
        normalize_fact(record.version.as_deref().unwrap_or_default())
    )
}

fn normalize_fact(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn scope_rank(scope: ApplicationInstallScope) -> u8 {
    match scope {
        ApplicationInstallScope::Machine => 0,
        ApplicationInstallScope::CurrentUser => 1,
    }
}

fn scope_code(scope: ApplicationInstallScope) -> &'static str {
    match scope {
        ApplicationInstallScope::Machine => "machine",
        ApplicationInstallScope::CurrentUser => "current-user",
    }
}

fn push_source_identity(
    identities: &mut Vec<ApplicationSourceIdentity>,
    identity: ApplicationSourceIdentity,
) {
    if identities.iter().any(|existing| {
        existing.source == identity.source
            && existing
                .identifier
                .eq_ignore_ascii_case(&identity.identifier)
    }) {
        return;
    }
    identities.push(identity);
    identities.sort_by(|left, right| {
        left.source.cmp(&right.source).then_with(|| {
            left.identifier
                .to_ascii_lowercase()
                .cmp(&right.identifier.to_ascii_lowercase())
        })
    });
}

/// Two registrations may describe one product only when they resolve to the
/// same command. Conflicting 32-bit and 64-bit facts must never keep an
/// executable uninstall path.
fn registrations_are_compatible(
    left: &ApplicationUninstallRegistration,
    right: &ApplicationUninstallRegistration,
) -> bool {
    if left == right {
        return true;
    }
    matches!(
        (left, right),
        (
            ApplicationUninstallRegistration::WindowsRegistered {
                key_name: left_key,
                scope: left_scope,
                registry_view: _,
                command_kind: left_kind,
                command_digest: left_digest,
                ..
            },
            ApplicationUninstallRegistration::WindowsRegistered {
                key_name: right_key,
                scope: right_scope,
                registry_view: _,
                command_kind: right_kind,
                command_digest: right_digest,
                ..
            }
        ) if left_key.eq_ignore_ascii_case(right_key)
            && left_scope == right_scope
            && left_kind == right_kind
            && left_digest == right_digest
    )
}

/// Converts a platform failure into an empty inventory-safe list. Retained for
/// callers that treat AppX discovery as optional enrichment.
pub(crate) fn empty_on_error<T>(result: Result<T, PlatformError>, fallback: T) -> T {
    match result {
        Ok(value) => value,
        Err(error) => {
            log::warn!(
                "windows_inventory_source_unavailable code={:?} diagnostic={}",
                error.code(),
                error.diagnostic()
            );
            fallback
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::contracts::WindowsRegisteredUninstallKind;

    fn record(key_name: &str, scope: ApplicationInstallScope, bytes: u64) -> RegistryRecord {
        RegistryRecord {
            key_name: key_name.to_string(),
            scope,
            registry_view: WindowsRegistryView::Registry64,
            name: "Example App".to_string(),
            version: Some("1.0".to_string()),
            publisher: Some("Example Corp".to_string()),
            estimated_bytes: bytes,
            installed_at_ms: None,
            icon_path: Some(PathBuf::from(r"C:\Example\app.exe")),
            install_location: Some(PathBuf::from(r"C:\Example")),
            executable_paths: vec![PathBuf::from(r"C:\Example\app.exe")],
            uninstall_registration: None,
            uninstall_diagnostic: None,
        }
    }

    fn registration(digest: &str) -> ApplicationUninstallRegistration {
        ApplicationUninstallRegistration::WindowsRegistered {
            key_name: "Example App".to_string(),
            scope: ApplicationInstallScope::Machine,
            registry_view: WindowsRegistryView::Registry64,
            command_kind: WindowsRegisteredUninstallKind::Executable,
            command_digest: digest.to_string(),
            estimated_bytes: 1024,
        }
    }

    #[test]
    fn duplicate_views_collapse_and_keep_the_machine_record_primary() {
        let mut current_user = record("Example App", ApplicationInstallScope::CurrentUser, 2048);
        current_user.registry_view = WindowsRegistryView::Registry32;
        current_user.executable_paths = vec![PathBuf::from(r"C:\Example\app32.exe")];
        let applications = merge_registry_records(vec![
            current_user,
            record("Example App", ApplicationInstallScope::Machine, 1024),
        ]);

        assert_eq!(applications.len(), 1);
        let application = &applications[0];
        assert!(application
            .catalog_identifier
            .starts_with("windows-registry:machine:"));
        assert_eq!(application.estimated_bytes, 2048);
        assert_eq!(application.executable_paths.len(), 2);
        assert_eq!(
            application
                .source_identities
                .iter()
                .filter(|identity| identity.source == ApplicationInventorySource::WindowsRegistry)
                .count(),
            2
        );
    }

    #[test]
    fn records_with_different_publishers_or_versions_stay_separate() {
        let first = record("Example App", ApplicationInstallScope::Machine, 1024);
        let mut second = record("Example App", ApplicationInstallScope::Machine, 1024);
        second.publisher = Some("Another Corp".to_string());
        let mut third = record("Example App", ApplicationInstallScope::Machine, 1024);
        third.version = Some("2.0".to_string());

        assert_eq!(merge_registry_records(vec![first, second, third]).len(), 3);
    }

    #[test]
    fn conflicting_registrations_are_never_actionable() {
        let mut machine = record("Example App", ApplicationInstallScope::Machine, 1024);
        machine.uninstall_registration = Some(registration("aaa"));
        let mut user = record("Example App", ApplicationInstallScope::CurrentUser, 1024);
        user.uninstall_registration = Some(registration("bbb"));

        let application = merge_registry_records(vec![machine, user])
            .pop()
            .expect("one merged record");
        assert!(application.uninstall_registration.is_none());
        assert_eq!(
            application.uninstall_diagnostic,
            Some(ApplicationUninstallDiagnostic::RegistrationConflict)
        );
    }

    #[test]
    fn identical_registrations_are_preserved() {
        let mut machine = record("Example App", ApplicationInstallScope::Machine, 1024);
        machine.uninstall_registration = Some(registration("aaa"));
        let mut user = record("Example App", ApplicationInstallScope::CurrentUser, 1024);
        user.uninstall_registration = Some(registration("aaa"));

        let application = merge_registry_records(vec![machine, user])
            .pop()
            .expect("one merged record");
        assert!(application.uninstall_registration.is_some());
        assert!(application.uninstall_diagnostic.is_none());
    }

    #[test]
    fn winget_enrichment_requires_a_unique_name_match() {
        let mut applications = merge_registry_records(vec![
            record("Example App", ApplicationInstallScope::Machine, 1024),
        ]);
        merge_winget_products(
            &mut applications,
            vec![WingetProduct {
                name: "example  app".to_string(),
                package_id: "Example.App".to_string(),
                version: Some("1.0".to_string()),
            }],
        );
        assert!(applications[0]
            .identifiers
            .iter()
            .any(|identifier| identifier == "Example.App"));
        assert!(applications[0].uninstall_registration.is_none());
    }

    #[test]
    fn winget_enrichment_skips_ambiguous_names() {
        let mut first = record("Example App", ApplicationInstallScope::Machine, 1024);
        first.key_name = "One".to_string();
        let mut second = record("Example App", ApplicationInstallScope::Machine, 1024);
        second.key_name = "Two".to_string();
        second.publisher = Some("Another Corp".to_string());
        let mut applications = merge_registry_records(vec![first, second]);
        merge_winget_products(
            &mut applications,
            vec![WingetProduct {
                name: "Example App".to_string(),
                package_id: "Example.App".to_string(),
                version: None,
            }],
        );
        assert!(applications
            .iter()
            .all(|application| application
                .identifiers
                .iter()
                .all(|identifier| identifier != "Example.App")));
    }

    #[test]
    fn packaged_application_requires_a_complete_identity() {
        let mut applications = Vec::new();
        merge_packaged_applications(
            &mut applications,
            vec![PackagedApplicationRecord {
                system_signed: false,
                package_family_name: String::new(),
                package_full_name: "Example_1.0_x64__abc".to_string(),
                name: "Example".to_string(),
                version: "1.0".to_string(),
                publisher: "Example".to_string(),
                install_location: r"C:\Program Files\WindowsApps\Example".to_string(),
                executable: "Example.exe".to_string(),
                icon: String::new(),
            }],
        );
        assert!(applications.is_empty());
    }

    #[test]
    fn packaged_application_without_a_real_location_is_still_listed() {
        let mut applications = Vec::new();
        merge_packaged_applications(
            &mut applications,
            vec![PackagedApplicationRecord {
                system_signed: true,
                package_family_name: "Example_abc".to_string(),
                package_full_name: "Example_1.0_x64__abc".to_string(),
                name: "Example".to_string(),
                version: "1.0".to_string(),
                publisher: "Example".to_string(),
                install_location: r"C:\Program Files\WindowsApps\Example".to_string(),
                executable: "Example.exe".to_string(),
                icon: "Assets\\Logo.png".to_string(),
            }],
        );
        assert_eq!(applications.len(), 1);
        let application = &applications[0];
        assert!(application.system_signed);
        assert!(matches!(
            application.uninstall_registration,
            Some(ApplicationUninstallRegistration::WindowsAppx { .. })
        ));
        assert_eq!(
            application.catalog_identifier,
            "windows-appx:example_abc"
        );
    }
}
