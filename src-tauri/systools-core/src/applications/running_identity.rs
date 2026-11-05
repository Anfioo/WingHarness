//! Stable identity for running applications, independent of ranking or icon
//! presentation.
//!
//! Windows process-control requests are authorized by an executable path, never
//! by a display name alone. The identity helpers here normalize that path the
//! same way the inventory digest and the process snapshot do, so one product
//! observed through two APIs keeps one identity.

use std::path::{Path, PathBuf};

/// Lowercase, separator-normalized key for one executable path.
///
/// The verbatim prefix is removed because the process API may return a
/// canonical path while the inventory still holds the user-provided DOS form.
pub(crate) fn path_identity_key(path: &Path) -> String {
    let display = path.to_string_lossy();
    let trimmed = display.trim();
    let without_verbatim = trimmed
        .strip_prefix(r"\\?\")
        .or_else(|| trimmed.strip_prefix(r"\\.\"))
        .unwrap_or(trimmed);
    let mut normalized = without_verbatim.replace('/', "\\").to_ascii_lowercase();
    while normalized.ends_with('\\') && normalized.len() > 3 {
        normalized.pop();
    }
    normalized
}

/// Stable executable identity exposed to callers that request a quit.
pub(crate) fn executable_id(path: &Path) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"systools-application-process-v1");
    hasher.update(path_identity_key(path).as_bytes());
    hasher.finalize().to_hex().to_string()
}

/// Identity used when the executable path is unavailable.
pub(crate) fn id(path: Option<&Path>, pid: u32) -> String {
    match path {
        Some(path) if path.is_absolute() => executable_id(path),
        _ => {
            let mut hasher = blake3::Hasher::new();
            hasher.update(b"systools-application-process-v1");
            hasher.update(format!("process:{pid}").as_bytes());
            hasher.finalize().to_hex().to_string()
        }
    }
}

/// The path a quit request targets. Windows has no application-bundle concept,
/// so the executable itself is the stable identity.
pub(crate) fn application_path(executable: &Path) -> PathBuf {
    executable.to_path_buf()
}

/// A graceful quit is requested only for a regular executable outside the
/// Windows installation tree.
pub(crate) fn can_quit(path: &Path) -> bool {
    path.is_absolute()
        && path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        && !is_protected(path)
}

/// Force termination additionally refuses the current application and any
/// executable inside the operating-system directory.
pub(crate) fn can_force_quit(path: &Path) -> bool {
    can_quit(path) && !is_current_application(path)
}

pub(crate) fn is_current_application(path: &Path) -> bool {
    std::env::current_exe().is_ok_and(|current| {
        path_identity_key(&current) == path_identity_key(path)
    })
}

fn is_protected(path: &Path) -> bool {
    let key = path_identity_key(path);
    let windows = std::env::var("SystemRoot")
        .ok()
        .or_else(|| std::env::var("windir").ok())
        .map(|root| path_identity_key(Path::new(&root)));
    windows.is_some_and(|root| key.starts_with(&(root + "\\")))
}

/// Lowercase process-name aliases. A trailing `.exe` is optional because
/// process APIs and registry values disagree about it.
pub(crate) fn process_aliases(value: &str) -> Vec<String> {
    let normalized = value.replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or(&normalized);
    let mut aliases = vec![name.trim().to_ascii_lowercase()];
    if let Some(without_exe) = aliases[0].strip_suffix(".exe") {
        aliases.push(without_exe.to_string());
    }
    aliases
}

/// Returns true when both values name the same executable path.
pub(crate) fn paths_match(left: &Path, right: &Path) -> bool {
    path_identity_key(left) == path_identity_key(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_keys_normalize_case_separators_and_verbatim_prefixes() {
        assert_eq!(
            path_identity_key(Path::new(r"\\?\C:\Program Files\Example\APP.EXE")),
            path_identity_key(Path::new("c:/program files/example/app.exe"))
        );
        assert_eq!(
            path_identity_key(Path::new(r"C:\Program Files\Example\")),
            path_identity_key(Path::new(r"c:\Program Files\Example"))
        );
    }

    #[test]
    fn executable_identity_is_stable_and_distinct() {
        let first = executable_id(Path::new(r"C:\Apps\Example\example.exe"));
        assert_eq!(
            first,
            executable_id(Path::new(r"c:/apps/example/EXAMPLE.EXE"))
        );
        assert_ne!(
            first,
            executable_id(Path::new(r"C:\Apps\Other\example.exe"))
        );
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn unknown_paths_fall_back_to_a_process_identity() {
        assert_eq!(id(None, 42), id(Some(Path::new("relative.exe")), 42));
        assert_ne!(id(None, 42), id(None, 43));
    }

    #[test]
    fn only_absolute_executables_outside_windows_are_quittable() {
        assert!(can_quit(Path::new(r"C:\Program Files\Example\example.exe")));
        assert!(!can_quit(Path::new(r"example.exe")));
        assert!(!can_quit(Path::new(r"C:\Program Files\Example\readme.txt")));
    }

    #[test]
    fn process_aliases_strip_case_and_extension() {
        assert_eq!(
            process_aliases(r"C:\Apps\Example.EXE"),
            vec!["example.exe", "example"]
        );
    }
}
