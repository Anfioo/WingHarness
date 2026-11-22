// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

//! Runtime probe: where `mise` lives, what version it reports and whether the
//! Windows shims are wired into `PATH`.
//!
//! A missing executable is a supported state, not an error: the page shows the
//! platform's install command instead. The same applies to a version probe that
//! fails — mise is still installed and usable.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::MiseResult;
use crate::models::{MiseRuntimeInfo, MiseRuntimeSource, MiseShimState, MiseShimStatus};
use crate::process;

const VERSION_TIMEOUT: Duration = Duration::from_secs(15);

/// Probe the local mise executable and its shims without failing when mise is
/// missing; the frontend shows an install guide instead.
pub async fn probe_runtime() -> MiseResult<MiseRuntimeInfo> {
    let install_hint = install_hint().to_string();
    let path_entries = path_entries();

    let executable = match process::resolve_executable() {
        Ok(executable) => executable,
        Err(_) => {
            return Ok(MiseRuntimeInfo {
                available: false,
                executable: None,
                version: None,
                source: None,
                install_hint,
                detail: Some("The mise executable was not found.".to_string()),
                shims: None,
            });
        }
    };

    let (version, detail) = match process::run_command(
        &["--version".to_string()],
        None,
        VERSION_TIMEOUT,
        false,
        None,
        None,
    )
    .await
    {
        Ok(result) => (parse_version(&result.stdout), None),
        Err(error) => {
            log::warn!("mise_version_probe_failed error={error}");
            (None, Some(error.message))
        }
    };

    let source = classify_source(
        &executable,
        non_empty_env("MISE_EXECUTABLE").map(PathBuf::from).as_deref(),
        &path_entries,
    );
    let shims = shim_status_for(&executable, cfg!(windows), &path_entries);

    Ok(MiseRuntimeInfo {
        available: true,
        executable: Some(executable.to_string_lossy().into_owned()),
        version,
        source: Some(source),
        install_hint,
        detail,
        shims: Some(shims),
    })
}

/// Take the version token from the first non-empty line; without a token the
/// whole line is the best answer available.
pub(crate) fn parse_version(output: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let token = trimmed
            .split_whitespace()
            .find(|token| is_version_token(token));
        return Some(token.unwrap_or(trimmed).to_string());
    }
    None
}

/// `\d{4}\.\d+\.\d+` as a whole token.
fn is_version_token(token: &str) -> bool {
    let mut parts = token.split('.');
    let (Some(year), Some(minor), Some(patch)) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }

    year.len() == 4
        && year.bytes().all(|byte| byte.is_ascii_digit())
        && !minor.is_empty()
        && minor.bytes().all(|byte| byte.is_ascii_digit())
        && !patch.is_empty()
        && patch.bytes().all(|byte| byte.is_ascii_digit())
}

/// Classify where the executable came from. A Scoop path wins over an explicit
/// `MISE_EXECUTABLE`, because the install method is what the page reports.
pub(crate) fn classify_source(
    executable: &Path,
    explicit: Option<&Path>,
    path_entries: &[PathBuf],
) -> MiseRuntimeSource {
    let lowered = executable.to_string_lossy().to_ascii_lowercase();
    if lowered.contains("scoopcurrent") || lowered.contains("scoop") {
        return MiseRuntimeSource::Scoop;
    }

    if explicit.is_some_and(|explicit| same_path(executable, explicit)) {
        return MiseRuntimeSource::Direct;
    }

    if let Some(parent) = executable.parent() {
        if path_entries.iter().any(|entry| same_path(entry, parent)) {
            return MiseRuntimeSource::Path;
        }
    }

    MiseRuntimeSource::Unknown
}

/// Whether the executable's directory is on `PATH`. Only Windows uses shims.
pub(crate) fn shim_status_for(
    executable: &Path,
    is_windows: bool,
    path_entries: &[PathBuf],
) -> MiseShimStatus {
    if !is_windows {
        return MiseShimStatus {
            state: MiseShimState::Unsupported,
            directory: None,
            detail: Some("mise shims are only checked on Windows.".to_string()),
        };
    }

    let Some(directory) = executable.parent() else {
        return MiseShimStatus {
            state: MiseShimState::Missing,
            directory: None,
            detail: Some("The mise executable has no parent directory.".to_string()),
        };
    };

    let present = path_entries
        .iter()
        .any(|entry| same_path(entry, directory));
    let detail = if present {
        "The mise shim directory is on PATH.".to_string()
    } else {
        format!(
            "The mise shim directory {} is not on PATH; new terminal sessions cannot call mise-managed tools directly.",
            directory.display()
        )
    };

    MiseShimStatus {
        state: if present {
            MiseShimState::Present
        } else {
            MiseShimState::Missing
        },
        directory: Some(directory.to_string_lossy().into_owned()),
        detail: Some(detail),
    }
}

fn install_hint() -> &'static str {
    if cfg!(target_os = "windows") {
        "winget install jdx.mise"
    } else if cfg!(target_os = "macos") {
        "brew install mise"
    } else {
        "curl https://mise.run | sh"
    }
}

fn path_entries() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Compare two paths as the platform does: case-insensitively on Windows, with
/// `/` and `\` treated alike there, and without trailing separators.
fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        normalize_for_compare(left) == normalize_for_compare(right)
    } else {
        left == right
    }
}

fn normalize_for_compare(path: &Path) -> String {
    let mut text = path.to_string_lossy().replace('/', "\\").to_lowercase();
    while text.len() > 1 && text.ends_with('\\') {
        text.pop();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_token_is_taken_from_the_first_non_empty_line() {
        assert_eq!(
            parse_version("mise 2024.11.0 windows-x64 (2024-11-01)\n"),
            Some("2024.11.0".to_string())
        );
        assert_eq!(
            parse_version("\n  \nmise 2025.1.2\n"),
            Some("2025.1.2".to_string())
        );
    }

    #[test]
    fn a_line_without_a_version_token_is_kept_whole() {
        assert_eq!(
            parse_version("mise development build"),
            Some("mise development build".to_string())
        );
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("\n\n"), None);
    }

    #[test]
    fn four_digit_major_is_required() {
        assert!(!is_version_token("2024.11"));
        assert!(!is_version_token("202.11.0"));
        assert!(!is_version_token("2024.11.0.1"));
        assert!(!is_version_token("v2024.11.0"));
        assert!(is_version_token("2024.11.0"));
    }

    #[test]
    fn a_scoop_path_is_classified_as_scoop() {
        let executable = Path::new(r"C:\Users\me\scoop\shims\mise.exe");
        assert_eq!(
            classify_source(executable, Some(executable), &[]),
            MiseRuntimeSource::Scoop
        );
    }

    #[test]
    fn an_explicit_executable_is_direct() {
        let executable = Path::new(r"C:\Tools\mise.exe");
        assert_eq!(
            classify_source(executable, Some(executable), &[]),
            MiseRuntimeSource::Direct
        );
    }

    #[test]
    fn an_executable_on_path_is_classified_as_path() {
        let executable = Path::new(r"C:\Users\me\.local\bin\mise.exe");
        let entries = vec![
            PathBuf::from(r"C:\Users\me\.local\bin"),
            PathBuf::from(r"C:\Other"),
        ];
        assert_eq!(
            classify_source(executable, None, &entries),
            MiseRuntimeSource::Path
        );
    }

    #[test]
    fn any_other_location_is_unknown() {
        let executable = Path::new(r"C:\Tools\mise.exe");
        let entries = vec![PathBuf::from(r"C:\Users\me\.local\bin")];
        assert_eq!(
            classify_source(executable, None, &entries),
            MiseRuntimeSource::Unknown
        );
    }

    #[test]
    fn a_shim_directory_on_path_is_present() {
        let executable = Path::new(r"C:\Users\me\scoop\shims\mise.exe");
        let status = shim_status_for(
            executable,
            true,
            &[PathBuf::from(r"C:\Users\me\scoop\shims")],
        );
        assert_eq!(status.state, MiseShimState::Present);
        assert_eq!(
            status.directory.as_deref(),
            Some(r"C:\Users\me\scoop\shims")
        );
        assert!(status.detail.is_some());
    }

    #[test]
    fn a_shim_directory_outside_path_is_missing() {
        let executable = Path::new(r"C:\Users\me\scoop\shims\mise.exe");
        let status = shim_status_for(executable, true, &[]);
        assert_eq!(status.state, MiseShimState::Missing);
        assert!(status.detail.is_some());
    }

    #[test]
    fn other_platforms_do_not_use_shims() {
        let executable = Path::new("/usr/local/bin/mise");
        let status = shim_status_for(executable, false, &[]);
        assert_eq!(status.state, MiseShimState::Unsupported);
        assert_eq!(status.directory, None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_comparison_ignores_case_and_trailing_separator() {
        let executable = Path::new(r"C:\Users\Me\Scoop\shims\mise.exe");
        let status = shim_status_for(
            executable,
            true,
            &[PathBuf::from(r"c:\users\me\scoop\shims\")],
        );
        assert_eq!(status.state, MiseShimState::Present);
    }

    #[test]
    fn the_install_hint_is_a_command() {
        assert!(!install_hint().is_empty());
    }

    #[test]
    #[ignore = "requires a local mise install"]
    fn real_runtime_probe_reports_the_executable() {
        let info = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(probe_runtime())
            .expect("the runtime probe itself must not fail");

        assert!(info.available);
        assert!(info.executable.is_some());
        assert!(info.version.is_some());
    }
}
