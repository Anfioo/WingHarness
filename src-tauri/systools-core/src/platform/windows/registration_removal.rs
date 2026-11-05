//! Application-record removal.
//!
//! Record removal deletes one exact uninstall registration. It never touches
//! install files, never enumerates the registry, and never accepts a key name
//! from a client: the key comes from the trusted catalog record. Writes run in
//! a `winreg` transaction and are verified afterwards.
//!
//! The privileged helper entry point keeps its fail-closed contract until the
//! elevated record-removal flow is wired to the catalog.

use std::ffi::OsString;
use std::io;

use winreg::{
    enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, KEY_WOW64_32KEY,
        KEY_WOW64_64KEY,
    },
    transaction::Transaction,
    RegKey,
};

use crate::applications::contracts::{
    ApplicationInstallScope, ApplicationUninstallRegistration, InstalledApplication,
    WindowsRegistryView,
};
use crate::platform::contracts::{PlatformError, PlatformErrorCode, PlatformResult};

pub(crate) const FLAG: &str = "--systools-application-record-helper-v1";
const FAILURE_EXIT_CODE: i32 = 70;
const UNINSTALL_PATH: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
const MAX_KEY_NAME_BYTES: usize = 512;

/// Returns `None` for an ordinary application launch and an exit code when the
/// helper flag is present. A malformed invocation is never allowed to fall
/// through to the desktop application.
pub(crate) fn run(arguments: &[OsString]) -> Option<i32> {
    if arguments.get(1).and_then(|value| value.to_str()) != Some(FLAG) {
        return None;
    }
    match parse_arguments(arguments) {
        Some(_) => {
            log::warn!("systools_application_record_helper_unavailable reason=not_implemented")
        }
        None => {
            log::warn!("systools_application_record_helper_rejected reason=invalid_arguments")
        }
    }
    Some(FAILURE_EXIT_CODE)
}

fn parse_arguments(arguments: &[OsString]) -> Option<(&str, &str)> {
    if arguments.len() != 4 {
        return None;
    }
    let id = arguments[2].to_str()?;
    let digest = arguments[3].to_str()?;
    let valid_id = id.strip_prefix("application-").is_some_and(|suffix| {
        suffix.len() == 24 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    });
    let valid_digest = digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit());
    (valid_id && valid_digest).then_some((id, digest))
}

/// Removes the exact registry record named by one trusted application record.
///
/// Only `WindowsRegistered` and `WindowsMsi` registrations own a removable
/// record. AppX packages and winget products are managed by their own stores,
/// so they are rejected as unsupported instead of guessing a registry key.
pub(crate) fn remove_record(application: &InstalledApplication, dry_run: bool) -> PlatformResult<()> {
    let Some(registration) = application.uninstall_registration.as_ref() else {
        return Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "application_record_removal_requires_a_registration",
        ));
    };
    match registration {
        ApplicationUninstallRegistration::WindowsRegistered {
            key_name,
            scope,
            registry_view,
            ..
        } => remove_registered(key_name, *scope, *registry_view, dry_run),
        ApplicationUninstallRegistration::WindowsMsi {
            product_code,
            scope,
            ..
        } => remove_msi(product_code, *scope, dry_run),
        ApplicationUninstallRegistration::WindowsAppx { .. }
        | ApplicationUninstallRegistration::Winget { .. } => Err(PlatformError::new(
            PlatformErrorCode::Unsupported,
            "application_record_removal_unsupported_registration",
        )),
    }
}

fn remove_registered(
    key_name: &str,
    scope: ApplicationInstallScope,
    view: WindowsRegistryView,
    dry_run: bool,
) -> PlatformResult<()> {
    validate_key_name(key_name)?;
    if dry_run {
        return record_exists(key_name, scope, view).map(|_| ());
    }
    let removed = delete_record(key_name, scope, view)?;
    log::info!(
        "systools_application_record_removed scope={scope:?} view={view:?} removed={removed}"
    );
    Ok(())
}

fn remove_msi(
    product_code: &str,
    scope: ApplicationInstallScope,
    dry_run: bool,
) -> PlatformResult<()> {
    validate_key_name(product_code)?;
    // MSI records can live in either registry view depending on the package.
    let views = [WindowsRegistryView::Registry64, WindowsRegistryView::Registry32];
    if dry_run {
        for view in views {
            record_exists(product_code, scope, view)?;
        }
        return Ok(());
    }
    let mut removed = false;
    for view in views {
        removed |= delete_record(product_code, scope, view)?;
    }
    log::info!(
        "systools_application_record_removed scope={scope:?} kind=msi removed={removed}"
    );
    Ok(())
}

fn registry_root(scope: ApplicationInstallScope) -> RegKey {
    match scope {
        ApplicationInstallScope::CurrentUser => RegKey::predef(HKEY_CURRENT_USER),
        ApplicationInstallScope::Machine => RegKey::predef(HKEY_LOCAL_MACHINE),
    }
}

const fn registry_flags(view: WindowsRegistryView) -> u32 {
    match view {
        WindowsRegistryView::Registry32 => KEY_WOW64_32KEY,
        WindowsRegistryView::Registry64 => KEY_WOW64_64KEY,
    }
}

/// Returns whether the exact record currently exists. Read-only.
fn record_exists(
    key_name: &str,
    scope: ApplicationInstallScope,
    view: WindowsRegistryView,
) -> PlatformResult<bool> {
    let root = registry_root(scope);
    let parent = match root.open_subkey_with_flags(
        UNINSTALL_PATH,
        KEY_READ | registry_flags(view),
    ) {
        Ok(parent) => parent,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(registry_error("open uninstall key", &error)),
    };
    match parent.open_subkey_with_flags(key_name, KEY_READ) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(registry_error("open application record", &error)),
    }
}

/// Deletes one exact subkey (including MSI-owned children) in a transaction
/// and verifies it is gone.
fn delete_record(
    key_name: &str,
    scope: ApplicationInstallScope,
    view: WindowsRegistryView,
) -> PlatformResult<bool> {
    if !record_exists(key_name, scope, view)? {
        return Ok(false);
    }
    let root = registry_root(scope);
    let parent = root
        .open_subkey_with_flags(UNINSTALL_PATH, KEY_READ | KEY_WRITE | registry_flags(view))
        .map_err(|error| registry_error("open uninstall key for write", &error))?;
    let mut descendants = Vec::new();
    collect_descendants(&parent, key_name, &mut descendants)
        .map_err(|error| registry_error("enumerate application record children", &error))?;
    let transaction = Transaction::new()
        .map_err(|error| registry_error("begin registry transaction", &error))?;
    // Children are collected child-first, so every delete is a leaf delete.
    for path in &descendants {
        parent
            .delete_subkey_transacted(path, &transaction)
            .map_err(|error| registry_error("delete application record child", &error))?;
    }
    parent
        .delete_subkey_transacted(key_name, &transaction)
        .map_err(|error| registry_error("delete application record", &error))?;
    transaction
        .commit()
        .map_err(|error| registry_error("commit registry transaction", &error))?;
    match parent.open_subkey_with_flags(key_name, KEY_READ) {
        Ok(_) => Err(PlatformError::operation_failed(
            "application record still exists after removal",
        )
        .with_possible_side_effects()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(registry_error("verify application record removal", &error)
            .with_possible_side_effects()),
    }
}

/// Lists every descendant of `path` below `parent`, deepest first.
fn collect_descendants(
    parent: &RegKey,
    path: &str,
    output: &mut Vec<String>,
) -> io::Result<()> {
    let key = match parent.open_subkey_with_flags(path, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let children = key
        .enum_keys()
        .collect::<io::Result<Vec<String>>>()?;
    // The read handle must be released before the transaction commits.
    drop(key);
    for child in children {
        let child_path = format!("{path}\\{child}");
        collect_descendants(parent, &child_path, output)?;
        output.push(child_path);
    }
    Ok(())
}

fn validate_key_name(key_name: &str) -> PlatformResult<()> {
    let valid = !key_name.is_empty()
        && key_name.len() <= MAX_KEY_NAME_BYTES
        && !key_name
            .chars()
            .any(|character| matches!(character, '\\' | '\0' | '\r' | '\n'));
    if valid {
        Ok(())
    } else {
        Err(PlatformError::new(
            PlatformErrorCode::InvalidData,
            "application record key name rejected",
        ))
    }
}

fn registry_error(operation: &'static str, error: &io::Error) -> PlatformError {
    log::warn!(
        "systools_application_record_registry_error operation={operation} kind={:?} os_code={:?}",
        error.kind(),
        error.raw_os_error()
    );
    match error.kind() {
        io::ErrorKind::NotFound => PlatformError::new(
            PlatformErrorCode::ItemChanged,
            format!("{operation}: record disappeared"),
        ),
        io::ErrorKind::PermissionDenied => PlatformError::new(
            PlatformErrorCode::AccessDenied,
            format!("{operation}: access denied"),
        ),
        _ => PlatformError::io(operation, error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(id: &str, digest: &str) -> Vec<OsString> {
        vec![
            OsString::from("Systools"),
            OsString::from(FLAG),
            OsString::from(id),
            OsString::from(digest),
        ]
    }

    fn application(registration: Option<ApplicationUninstallRegistration>) -> InstalledApplication {
        InstalledApplication {
            catalog_identifier: "catalog".into(),
            primary_identifier: "primary".into(),
            identifiers: vec!["primary".into()],
            source_identities: Vec::new(),
            system_signed: false,
            name: "Example".into(),
            version: None,
            publisher: None,
            estimated_bytes: 0,
            installed_at_ms: None,
            icon_path: None,
            bundle_path: None,
            executable_paths: Vec::new(),
            uninstall_registration: registration,
            uninstall_diagnostic: None,
        }
    }

    #[test]
    fn helper_refuses_paths_commands_and_incomplete_digests() {
        for id in [
            r"HKLM\Software\Example",
            "application-../entry",
            "application-00000000000000000000000z",
        ] {
            assert!(parse_arguments(&arguments(id, &"a".repeat(64))).is_none());
        }
        assert!(parse_arguments(&arguments(
            &format!("application-{}", "a".repeat(24)),
            &"a".repeat(63)
        ))
        .is_none());
        assert!(parse_arguments(&arguments(
            &format!("application-{}", "a".repeat(24)),
            &"a".repeat(64)
        ))
        .is_some());
    }

    #[test]
    fn helper_only_claims_its_own_flag() {
        assert_eq!(run(&[OsString::from("Systools")]), None);
        assert_eq!(
            run(&arguments(
                &format!("application-{}", "a".repeat(24)),
                &"a".repeat(64)
            )),
            Some(70)
        );
    }

    #[test]
    fn unsupported_registrations_are_rejected_without_registry_access() {
        for registration in [
            ApplicationUninstallRegistration::WindowsAppx {
                package_family_name: "Example.1234".into(),
                package_full_name: "Example.1234_1.0.0.0_x64__abcd".into(),
                estimated_bytes: 0,
            },
            ApplicationUninstallRegistration::Winget {
                package_id: "Example".into(),
                source_name: "winget".into(),
                estimated_bytes: 0,
            },
        ] {
            let error = remove_record(&application(Some(registration)), true).unwrap_err();
            assert_eq!(error.code(), PlatformErrorCode::Unsupported);
        }
        let error = remove_record(&application(None), true).unwrap_err();
        assert_eq!(error.code(), PlatformErrorCode::Unsupported);
    }

    #[test]
    fn key_names_reject_path_traversal() {
        assert!(validate_key_name("Example.Key").is_ok());
        for key in ["", r"Example\Child", "Example\nKey", "\0"] {
            let error = validate_key_name(key).unwrap_err();
            assert_eq!(error.code(), PlatformErrorCode::InvalidData);
        }
    }
}
