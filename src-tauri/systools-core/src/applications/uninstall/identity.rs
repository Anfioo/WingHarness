//! Application identity metadata read from Windows version resources.
//!
//! Identity is presentation evidence only: it helps a user confirm that the
//! catalog record is the application they mean. It never authorizes or blocks
//! removal, so a missing or unreadable version resource is not an error.

use crate::applications::contracts::{ApplicationUninstallRegistration, InstalledApplication};
use crate::applications::models::{
    ApplicationUninstallIdentity, APPLICATION_UNINSTALL_IDENTITY_SCHEMA_VERSION,
};
use crate::platform::contracts::ApplicationIdentityMetadata;
use crate::platform::windows::file_version;

/// Builds the identity payload for one trusted application record.
pub(crate) fn identity_for(application: &InstalledApplication) -> ApplicationUninstallIdentity {
    let metadata = version_metadata(application);
    let package_identity = match application.uninstall_registration.as_ref() {
        Some(ApplicationUninstallRegistration::WindowsAppx {
            package_full_name, ..
        }) => Some(package_full_name.clone()),
        _ => None,
    };
    ApplicationUninstallIdentity {
        schema_version: APPLICATION_UNINSTALL_IDENTITY_SCHEMA_VERSION,
        metadata: Some(ApplicationIdentityMetadata::Windows {
            product_name: metadata.as_ref().and_then(|value| value.product_name.clone()),
            file_description: metadata
                .as_ref()
                .and_then(|value| value.file_description.clone()),
            company_name: metadata.as_ref().and_then(|value| value.company_name.clone()),
            package_identity,
        }),
    }
}

/// Reads the first readable version resource from the trusted paths only.
///
/// The candidate list comes from the catalog; the caller never supplies a path.
fn version_metadata(
    application: &InstalledApplication,
) -> Option<file_version::FileVersionMetadata> {
    application
        .executable_paths
        .iter()
        .map(|path| path.as_path())
        .chain(
            application
                .bundle_path
                .as_deref()
                .filter(|path| path.is_file()),
        )
        .find_map(file_version::file_version_metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::applications::contracts::{
        ApplicationInstallScope, ApplicationInventorySource, ApplicationSourceIdentity,
    };
    use std::path::PathBuf;

    fn application(
        registration: Option<ApplicationUninstallRegistration>,
        executable_paths: Vec<PathBuf>,
    ) -> InstalledApplication {
        InstalledApplication {
            catalog_identifier: "catalog".into(),
            primary_identifier: "primary".into(),
            identifiers: vec!["primary".into()],
            source_identities: vec![ApplicationSourceIdentity {
                source: ApplicationInventorySource::WindowsRegistry,
                identifier: "primary".into(),
            }],
            system_signed: false,
            name: "Example".into(),
            version: None,
            publisher: None,
            estimated_bytes: 0,
            installed_at_ms: None,
            icon_path: None,
            bundle_path: None,
            executable_paths,
            uninstall_registration: registration,
            uninstall_diagnostic: None,
        }
    }

    #[test]
    fn missing_version_resources_still_return_a_typed_identity() {
        let identity = identity_for(&application(None, Vec::new()));
        assert_eq!(
            identity.schema_version,
            APPLICATION_UNINSTALL_IDENTITY_SCHEMA_VERSION
        );
        match identity.metadata {
            Some(ApplicationIdentityMetadata::Windows {
                product_name,
                file_description,
                company_name,
                package_identity,
            }) => {
                assert_eq!(product_name, None);
                assert_eq!(file_description, None);
                assert_eq!(company_name, None);
                assert_eq!(package_identity, None);
            }
            None => panic!("Windows identity is always reported"),
        }
    }

    #[test]
    fn appx_identity_reports_the_package_full_name() {
        let identity = identity_for(&application(
            Some(ApplicationUninstallRegistration::WindowsAppx {
                package_family_name: "Example.1234".into(),
                package_full_name: "Example.1234_1.0.0.0_x64__abcd".into(),
                estimated_bytes: 10,
            }),
            Vec::new(),
        ));
        let Some(ApplicationIdentityMetadata::Windows { package_identity, .. }) = identity.metadata
        else {
            panic!("Windows identity is always reported");
        };
        assert_eq!(
            package_identity.as_deref(),
            Some("Example.1234_1.0.0.0_x64__abcd")
        );
    }

    #[test]
    fn non_appx_registrations_do_not_invent_a_package_identity() {
        let identity = identity_for(&application(
            Some(ApplicationUninstallRegistration::WindowsMsi {
                product_code: "{9627E855-337D-45EC-A2D9-CBB92B447399}".into(),
                scope: ApplicationInstallScope::CurrentUser,
                estimated_bytes: 10,
            }),
            Vec::new(),
        ));
        let Some(ApplicationIdentityMetadata::Windows { package_identity, .. }) = identity.metadata
        else {
            panic!("Windows identity is always reported");
        };
        assert_eq!(package_identity, None);
    }
}
