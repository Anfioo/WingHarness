//! Filesystem helpers used by the Windows inventory: registry path parsing,
//! display-icon resolution, and bounded directory size estimation.
//!
//! Every function here is best-effort. A missing or unreadable path is
//! reported as `None`; the inventory keeps its registration evidence and lets
//! the catalog decide whether the record is orphaned.

use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use super::package_sources;

/// Caps keep one malformed install directory from stalling a full scan.
const MAX_DIRECTORY_ENTRIES: usize = 200_000;
const MAX_DIRECTORY_DEPTH: usize = 64;
const DIRECTORY_SIZE_TIME_LIMIT: Duration = Duration::from_secs(30);
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

/// Parses a registry path value, expanding `%VARIABLE%` tokens once and
/// requiring an absolute result.
pub(crate) fn parse_registry_path(value: &str) -> Option<PathBuf> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let value = match value.strip_prefix('"') {
        Some(quoted) => quoted.strip_suffix('"')?.trim(),
        None => value,
    };
    let expanded = package_sources::expand_environment_variables(value, |name| {
        std::env::var(name).ok()
    });
    if expanded.split('%').count() >= 3 {
        return None;
    }
    let path = PathBuf::from(expanded);
    path.is_absolute().then_some(path)
}

/// Parses a `DisplayIcon` value, which may be quoted, may carry a trailing
/// `,index`, and may be an executable path with no icon resource.
pub(crate) fn parse_display_icon_path(value: &str) -> Option<PathBuf> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let candidate = if let Some(quoted) = value.strip_prefix('"') {
        let closing = quoted.find('"')?;
        quoted[..closing].trim()
    } else {
        value
            .rsplit_once(',')
            .filter(|(_, suffix)| suffix.trim().parse::<i32>().is_ok())
            .map_or(value, |(path, _)| path)
            .trim()
    };
    if candidate.is_empty() {
        return None;
    }
    parse_registry_path(candidate)
}

/// Resolves the display icon with the registry fallbacks that Windows installers
/// commonly leave behind.
pub(crate) fn resolve_icon_path(
    display_icon: Option<&str>,
    install_location: Option<&Path>,
) -> Option<PathBuf> {
    display_icon
        .and_then(parse_display_icon_path)
        .or_else(|| install_location.map(Path::to_path_buf))
}

/// Joins a package-relative icon asset onto the package root.
///
/// The declared path must stay relative: an absolute or parent-escaping value
/// is rejected instead of being resolved outside the package.
pub(crate) fn package_icon_path(install_location: &Path, declared: &str) -> Option<PathBuf> {
    let relative = Path::new(declared.trim());
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return None;
    }
    Some(install_location.join(relative))
}

/// Returns true when the path does not currently exist.
pub(crate) fn path_is_missing(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_err()
}

/// Estimates the logical bytes and file count below one directory.
///
/// The walk skips reparse points and stops at a bounded entry count, depth, or
/// elapsed time. An interrupted walk returns the bytes observed so far; the
/// caller labels the value as an estimate.
pub(crate) fn bounded_directory_size(root: &Path) -> (u64, u64) {
    let started = Instant::now();
    let Ok(metadata) = std::fs::symlink_metadata(root) else {
        return (0, 0);
    };
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return (0, 0);
    }
    let mut bytes = 0_u64;
    let mut files = 0_u64;
    let mut entries = 0_usize;
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    while let Some((directory, depth)) = pending.pop() {
        if depth > MAX_DIRECTORY_DEPTH || started.elapsed() > DIRECTORY_SIZE_TIME_LIMIT {
            break;
        }
        let Ok(read_dir) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in read_dir {
            if started.elapsed() > DIRECTORY_SIZE_TIME_LIMIT || entries >= MAX_DIRECTORY_ENTRIES {
                return (bytes, files);
            }
            let Ok(entry) = entry else { continue };
            entries = entries.saturating_add(1);
            let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if is_reparse_point(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                pending.push((entry.path(), depth.saturating_add(1)));
            } else if metadata.is_file() {
                bytes = bytes.saturating_add(metadata.len());
                files = files.saturating_add(1);
            }
        }
    }
    (bytes, files)
}

/// Creation time with a modification-time fallback.
pub(crate) fn path_timestamp_millis(path: &Path) -> Option<u64> {
    let metadata = path.metadata().ok()?;
    metadata
        .created()
        .or_else(|_| metadata.modified())
        .ok()
        .and_then(system_time_millis)
}

pub(crate) fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

/// Parses the eight-digit `InstallDate` registry value into Unix milliseconds.
pub(crate) fn parse_install_date(value: &str) -> Option<u64> {
    let digits = value.trim();
    if digits.len() != 8 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let year = digits[0..4].parse::<i32>().ok()?;
    let month = digits[4..6].parse::<u32>().ok()?;
    let day = digits[6..8].parse::<u32>().ok()?;
    let days = days_from_civil(year, month, day)?;
    u64::try_from(days).ok()?.checked_mul(86_400_000)
}

/// Converts a Gregorian calendar date to days since the Unix epoch without a
/// date-time dependency.
fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31_u32,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day == 0 || day > month_days[usize::try_from(month - 1).ok()?] {
        return None;
    }
    let adjusted_year = year - i32::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = i32::try_from(month).ok()? + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + i32::try_from(day).ok()? - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(i64::from(era * 146_097 + day_of_era - 719_468))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_paths_reject_relative_and_unresolved_values() {
        assert_eq!(
            parse_registry_path(r"  C:\Program Files\Example  "),
            Some(PathBuf::from(r"C:\Program Files\Example"))
        );
        assert_eq!(
            parse_registry_path(r#""C:\Program Files\Example""#),
            Some(PathBuf::from(r"C:\Program Files\Example"))
        );
        assert_eq!(parse_registry_path("Program Files"), None);
        assert_eq!(parse_registry_path("%SYSTOOLS_MISSING%\\Example"), None);
        assert_eq!(parse_registry_path(""), None);
    }

    #[test]
    fn display_icons_handle_quotes_indexes_and_bare_paths() {
        assert_eq!(
            parse_display_icon_path(r#""C:\Vendor\app.exe",0"#),
            Some(PathBuf::from(r"C:\Vendor\app.exe"))
        );
        assert_eq!(
            parse_display_icon_path(r"C:\Vendor\app.exe,-128"),
            Some(PathBuf::from(r"C:\Vendor\app.exe"))
        );
        assert_eq!(
            parse_display_icon_path(r"C:\Vendor\app.exe"),
            Some(PathBuf::from(r"C:\Vendor\app.exe"))
        );
        assert_eq!(parse_display_icon_path(",0"), None);
    }

    #[test]
    fn package_icon_assets_must_stay_inside_the_package() {
        let root = Path::new(r"C:\Program Files\WindowsApps\Example");
        assert_eq!(
            package_icon_path(root, "Assets\\Logo.png"),
            Some(root.join("Assets\\Logo.png"))
        );
        assert_eq!(package_icon_path(root, r"C:\outside.png"), None);
        assert_eq!(package_icon_path(root, r"..\outside.png"), None);
    }

    #[test]
    fn install_dates_are_parsed_only_when_the_calendar_date_is_valid() {
        assert_eq!(parse_install_date("19700101"), Some(0));
        assert_eq!(parse_install_date("20240229"), Some(1_709_164_800_000));
        assert_eq!(parse_install_date("20230229"), None);
        assert_eq!(parse_install_date("2024-01-01"), None);
    }

    #[test]
    fn bounded_size_ignores_missing_directories() {
        let missing = std::env::temp_dir().join("systools-inventory-missing-directory");
        assert_eq!(bounded_directory_size(&missing), (0, 0));
    }
}
