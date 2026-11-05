//! Validated permanent deletion used by leftover cleanup.
//!
//! Every path is rejected before any mutation when it is not absolute, points
//! at a volume root, lives inside a protected system location, crosses a
//! reparse point, or contains the running executable. Directories are removed
//! without ever following a link, read-only attributes are cleared first, and
//! one failure never aborts the rest of the batch.

use std::fs;
use std::path::{Component, Path, PathBuf};

use winreg::enums::{
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_ALL_ACCESS, KEY_READ, KEY_WOW64_64KEY,
};
use winreg::RegKey;

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

/// Permanent deletion applies to every path independently.
///
/// Returns the logical bytes removed for each successful path and the first
/// error for each rejected or partially failed path.
pub(crate) fn delete_paths(paths: &[PathBuf], dry_run: bool) -> Vec<Result<u64, (PathBuf, String)>> {
    paths
        .iter()
        .map(|path| delete_one(path, dry_run))
        .collect()
}

fn delete_one(path: &Path, dry_run: bool) -> Result<u64, (PathBuf, String)> {
    let reject = |reason: String| (path.to_path_buf(), reason);
    validate_target(path).map_err(reject)?;
    let bytes = logical_bytes(path).map_err(reject)?;
    if dry_run {
        return Ok(bytes);
    }
    remove_tree(path).map_err(reject)
}

// ---------------------------------------------------------------------------
// Path policy
// ---------------------------------------------------------------------------

fn validate_target(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("path is not absolute".to_string());
    }
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Prefix(_))) {
        return Err("path is not a Windows absolute path".to_string());
    }
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err("path is not rooted".to_string());
    }
    if components.next().is_none() {
        return Err("refusing to delete a volume root".to_string());
    }
    if is_protected(path) {
        return Err("path is inside a protected system location".to_string());
    }
    if contains_running_executable(path) {
        return Err("path contains the running application".to_string());
    }
    if has_reparse_component(path) {
        return Err("path crosses a reparse point".to_string());
    }
    Ok(())
}

fn is_protected(path: &Path) -> bool {
    if path
        .components()
        .any(|component| match component {
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                name.eq_ignore_ascii_case("$Recycle.Bin")
                    || name.eq_ignore_ascii_case("System Volume Information")
            }
            _ => false,
        })
    {
        return true;
    }

    let mut roots = Vec::new();
    for variable in ["SystemRoot", "windir"] {
        if let Some(value) = std::env::var_os(variable) {
            roots.push(PathBuf::from(value));
        }
    }
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(value) = std::env::var_os(variable) {
            roots.push(PathBuf::from(value));
        }
    }
    if let Some(value) = std::env::var_os("ProgramData") {
        roots.push(
            PathBuf::from(value)
                .join("Microsoft")
                .join("Windows"),
        );
    }
    roots
        .into_iter()
        .any(|root| path_is_within(path, &root))
}

/// True when `path` is equal to or below `root`, ignoring case and separator style.
fn path_is_within(path: &Path, root: &Path) -> bool {
    let root_components = root.components().map(component_key).collect::<Vec<_>>();
    if root_components.is_empty() {
        return false;
    }
    let path_components = path.components().map(component_key).collect::<Vec<_>>();
    path_components.len() >= root_components.len()
        && path_components[..root_components.len()] == root_components[..]
}

fn component_key(component: Component<'_>) -> String {
    match component {
        Component::Prefix(prefix) => prefix.as_os_str().to_string_lossy().to_ascii_lowercase(),
        Component::RootDir => "\\".to_string(),
        Component::CurDir => ".".to_string(),
        Component::ParentDir => "..".to_string(),
        Component::Normal(name) => name.to_string_lossy().to_ascii_lowercase(),
    }
}

fn contains_running_executable(path: &Path) -> bool {
    // Fail closed when the executable location cannot be resolved.
    let Ok(executable) = std::env::current_exe() else {
        return true;
    };
    path_is_within(&executable, path)
}

fn has_reparse_component(path: &Path) -> bool {
    path.ancestors().any(|ancestor| {
        fs::symlink_metadata(ancestor)
            .map(|metadata| is_reparse_point(&metadata))
            .unwrap_or(false)
    })
}

fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

// ---------------------------------------------------------------------------
// Filesystem removal
// ---------------------------------------------------------------------------

fn logical_bytes(path: &Path) -> Result<u64, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("failed to inspect target: {error}"))?;
    if is_reparse_point(&metadata) {
        return Err("target is a reparse point".to_string());
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Err("target is not a regular file or directory".to_string());
    }

    let mut total = 0_u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("failed to read directory: {error}"))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
            let child = entry.path();
            let metadata = fs::symlink_metadata(&child)
                .map_err(|error| format!("failed to inspect entry: {error}"))?;
            if is_reparse_point(&metadata) {
                return Err("directory contains a reparse point".to_string());
            }
            if metadata.is_dir() {
                pending.push(child);
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            } else {
                return Err("directory contains an unsupported entry type".to_string());
            }
        }
    }
    Ok(total)
}

fn remove_tree(path: &Path) -> Result<u64, String> {
    clear_readonly(path)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("failed to inspect target: {error}"))?;
    if is_reparse_point(&metadata) {
        return Err("target is a reparse point".to_string());
    }
    if metadata.is_file() {
        let bytes = metadata.len();
        fs::remove_file(path).map_err(|error| format!("failed to remove file: {error}"))?;
        return Ok(bytes);
    }
    if !metadata.is_dir() {
        return Err("target is not a regular file or directory".to_string());
    }

    let entries =
        fs::read_dir(path).map_err(|error| format!("failed to read directory: {error}"))?;
    let mut total = 0_u64;
    for entry in entries {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let child = entry.path();
        let metadata = fs::symlink_metadata(&child)
            .map_err(|error| format!("failed to inspect entry: {error}"))?;
        if is_reparse_point(&metadata) {
            return Err(format!(
                "refusing to follow reparse point {}",
                child.display()
            ));
        }
        if metadata.is_dir() {
            total = total.saturating_add(remove_tree(&child)?);
        } else if metadata.is_file() {
            clear_readonly(&child)?;
            let bytes = metadata.len();
            fs::remove_file(&child).map_err(|error| format!("failed to remove file: {error}"))?;
            total = total.saturating_add(bytes);
        } else {
            return Err("directory contains an unsupported entry type".to_string());
        }
    }
    fs::remove_dir(path).map_err(|error| format!("failed to remove directory: {error}"))?;
    Ok(total)
}

fn clear_readonly(path: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("failed to inspect target: {error}"))?;
    if !metadata.permissions().readonly() {
        return Ok(());
    }
    let mut permissions = metadata.permissions();
    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("failed to clear read-only attribute: {error}"))
}

// ---------------------------------------------------------------------------
// Registry removal
// ---------------------------------------------------------------------------

/// Removes one exact registry key emitted by the leftover scanner.
///
/// The accepted shapes are intentionally narrow: an uninstall entry below one
/// of the two standard uninstall roots, or a two-component
/// `HKCU\Software\<Publisher>\<Product>` group. Wildcards, relative paths and
/// deeper application trees are rejected.
pub(crate) fn delete_registry_key(location: &str) -> Result<(), String> {
    let (hive, path) = parse_registry_location(location)?;
    let scope = removable_registry_scope(&path)?;

    let root = RegKey::predef(hive);
    match scope {
        RegistryScope::UninstallEntry {
            parent_path,
            key_name,
        } => {
            let key = root
                .open_subkey_with_flags(parent_path, KEY_ALL_ACCESS)
                .map_err(|error| format!("failed to open registry parent: {error}"))?;
            key.delete_subkey_all(key_name)
                .map_err(|error| format!("failed to remove registry record: {error}"))
        }
        RegistryScope::PublisherGroup { product } => {
            let key = root
                .open_subkey_with_flags("Software", KEY_ALL_ACCESS)
                .map_err(|error| format!("failed to open registry parent: {error}"))?;
            key.delete_subkey_all(product)
                .map_err(|error| format!("failed to remove registry group: {error}"))
        }
    }
}

/// Registry paths this module is allowed to remove.
enum RegistryScope<'a> {
    UninstallEntry {
        parent_path: &'static str,
        key_name: &'a str,
    },
    PublisherGroup {
        product: &'a str,
    },
}

fn removable_registry_scope(path: &str) -> Result<RegistryScope<'_>, String> {
    let components = path.split('\\').collect::<Vec<_>>();
    if components.iter().any(|component| component.is_empty()) {
        return Err("registry location contains an empty component".to_string());
    }
    if components
        .iter()
        .any(|component| component.contains('*') || component.contains('?'))
    {
        return Err("registry location contains a wildcard".to_string());
    }

    match components.as_slice() {
        ["Software", "Microsoft", "Windows", "CurrentVersion", "Uninstall", key] => {
            Ok(RegistryScope::UninstallEntry {
                parent_path: "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                key_name: key,
            })
        }
        ["Software", "WOW6432Node", "Microsoft", "Windows", "CurrentVersion", "Uninstall", key] => {
            Ok(RegistryScope::UninstallEntry {
                parent_path: "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                key_name: key,
            })
        }
        ["Software", publisher, product] if !publisher.is_empty() && !product.is_empty() => {
            Ok(RegistryScope::PublisherGroup { product })
        }
        _ => Err("registry location is outside the removable scope".to_string()),
    }
}

fn parse_registry_location(location: &str) -> Result<(winreg::HKEY, String), String> {
    let (hive, path) = location
        .split_once('\\')
        .ok_or_else(|| "registry location has no hive".to_string())?;
    let hive = match hive.to_ascii_uppercase().as_str() {
        "HKCU" | "HKEY_CURRENT_USER" => HKEY_CURRENT_USER,
        "HKLM" | "HKEY_LOCAL_MACHINE" => HKEY_LOCAL_MACHINE,
        _ => return Err("registry location uses an unsupported hive".to_string()),
    };
    if path.is_empty() {
        return Err("registry location has no path".to_string());
    }
    Ok((hive, path.to_string()))
}

/// Opens a registry key for the scanner without crossing into an elevated hive.
pub(crate) fn open_registry_parent(
    hive: winreg::HKEY,
    path: &str,
    wow64: bool,
) -> std::io::Result<RegKey> {
    let flags = if wow64 {
        KEY_READ | KEY_WOW64_64KEY
    } else {
        KEY_READ
    };
    RegKey::predef(hive).open_subkey_with_flags(path, flags)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows_path(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    #[test]
    fn volume_roots_and_relative_paths_are_rejected() {
        for path in [
            windows_path("C:\\"),
            windows_path("C:"),
            windows_path("relative\\folder"),
            windows_path("\\\\server\\share"),
        ] {
            let error = delete_one(&path, true).expect_err("unsafe target must be rejected");
            assert!(
                error.1.contains("absolute")
                    || error.1.contains("root")
                    || error.1.contains("rooted"),
                "unexpected rejection reason: {}",
                error.1
            );
        }
    }

    #[test]
    fn protected_system_locations_are_rejected() {
        for path in [
            windows_path(r"C:\Windows\System32\fixture"),
            windows_path(r"C:\Program Files\Fixture"),
            windows_path(r"C:\Program Files (x86)\Fixture"),
            windows_path(r"C:\ProgramData\Microsoft\Windows\fixture"),
            windows_path(r"C:\$Recycle.Bin\S-1-5-21"),
            windows_path(r"D:\System Volume Information"),
        ] {
            let error = delete_one(&path, true).expect_err("protected target must be rejected");
            assert!(
                error.1.contains("protected"),
                "unexpected rejection reason: {}",
                error.1
            );
        }
    }

    #[test]
    fn case_insensitive_prefixes_are_compared_component_wise() {
        assert!(path_is_within(
            Path::new(r"c:\PROGRAM FILES\x"),
            Path::new(r"C:\Program Files")
        ));
        assert!(!path_is_within(
            Path::new(r"C:\Program Files Extra\x"),
            Path::new(r"C:\Program Files")
        ));
        assert!(path_is_within(
            Path::new(r"C:\Program Files"),
            Path::new(r"C:\Program Files")
        ));
    }

    #[test]
    fn directory_totals_follow_regular_files_only() {
        let root = std::env::temp_dir().join(format!(
            "systools-deletion-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(root.join("nested")).expect("fixture root must be created");
        fs::write(root.join("nested/a.bin"), b"12345").expect("fixture file must be written");
        fs::write(root.join("b.bin"), b"abc").expect("fixture file must be written");

        let bytes = logical_bytes(&root).expect("directory snapshot must succeed");
        assert_eq!(bytes, 8);
        let removed = remove_tree(&root).expect("fixture directory must be removed");
        assert_eq!(removed, 8);
        assert!(!root.exists());
    }

    #[test]
    fn registry_location_shapes_are_validated() {
        assert!(parse_registry_location(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\App")
            .is_ok());
        assert!(parse_registry_location(r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\App")
            .is_ok());
        assert!(parse_registry_location(r"HKCU\Software\Publisher\Product").is_ok());
        assert!(parse_registry_location(r"HKU\Software\Publisher\Product").is_err());
        assert!(parse_registry_location(r"HKCU").is_err());

        assert!(matches!(
            removable_registry_scope(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\App"),
            Ok(RegistryScope::UninstallEntry { .. })
        ));
        assert!(matches!(
            removable_registry_scope(r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\App"),
            Ok(RegistryScope::UninstallEntry { .. })
        ));
        assert!(matches!(
            removable_registry_scope(r"Software\Publisher\Product"),
            Ok(RegistryScope::PublisherGroup { .. })
        ));
        assert!(removable_registry_scope(r"Software\Publisher").is_err());
        assert!(removable_registry_scope(r"Software\Publisher\Product\Deeper").is_err());
        assert!(removable_registry_scope(r"Software\*\Product").is_err());
        assert!(removable_registry_scope(r"Microsoft\Windows\CurrentVersion\Run\App").is_err());
    }
}
