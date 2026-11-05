//! Where the feature keeps everything it persists.
//!
//! One directory, `clash/` under the app's data directory, laid out like this:
//!
//! ```text
//! clash/
//! ├── mihomo.exe        user-supplied core (never written by us)
//! ├── clash.json        which profile is active
//! ├── subscriptions.json  links whose downloads land in profiles/
//! ├── tests.json        sites the test tab fetches through the core
//! ├── profiles/         source configs — read-only input to the compiler
//! ├── prism/            .prism.yaml patches and groups.json
//! └── run/              compiled config, validation scratch, core log
//! ```
//!
//! Source and output are deliberately different files. `PrismExtension::apply`
//! reads the input and writes the result; pointing both at the same path would
//! re-patch already-patched output on every run, and `$append` rules would pile
//! up each time.

use once_cell::sync::OnceCell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Set once from `lib.rs` before any command runs.
pub static CONFIG_DIR: OnceCell<PathBuf> = OnceCell::new();

fn base() -> Result<PathBuf, String> {
    CONFIG_DIR
        .get()
        .cloned()
        .ok_or_else(|| "Clash data directory is not initialized".to_string())
}

pub fn root() -> Result<PathBuf, String> {
    ensure(base()?)
}

pub fn prism_dir() -> Result<PathBuf, String> {
    ensure(root()?.join("prism"))
}

pub fn profiles_dir() -> Result<PathBuf, String> {
    ensure(root()?.join("profiles"))
}

pub fn run_dir() -> Result<PathBuf, String> {
    ensure(root()?.join("run"))
}

pub fn settings_path() -> Result<PathBuf, String> {
    Ok(root()?.join("clash.json"))
}

/// Subscription links and the profiles they feed.
pub fn subscriptions_path() -> Result<PathBuf, String> {
    Ok(root()?.join("subscriptions.json"))
}

/// The sites the test tab checks, in the order the user put them.
pub fn test_sites_path() -> Result<PathBuf, String> {
    Ok(root()?.join("tests.json"))
}

/// The compiler's output — what mihomo is pointed at with `-f`.
pub fn run_config_path() -> Result<PathBuf, String> {
    Ok(run_dir()?.join("config.yaml"))
}

pub fn core_log_path() -> Result<PathBuf, String> {
    Ok(run_dir()?.join("mihomo.log"))
}

pub fn validation_path() -> Result<PathBuf, String> {
    Ok(run_dir()?.join("validate.yaml"))
}

/// The address this app last set as the system proxy. Windows keeps the setting
/// in the registry, where nothing says who put it there — this file is that
/// answer, so the app turns off only a proxy it set itself.
pub fn sysproxy_marker_path() -> Result<PathBuf, String> {
    Ok(root()?.join("sysproxy"))
}

/// The core is supplied by the user; we only ever look for it.
#[cfg(windows)]
pub fn core_binary() -> Result<PathBuf, String> {
    Ok(root()?.join("mihomo.exe"))
}

#[cfg(not(windows))]
pub fn core_binary() -> Result<PathBuf, String> {
    Ok(root()?.join("mihomo"))
}

fn ensure(dir: PathBuf) -> Result<PathBuf, String> {
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Write through a temp file and rename, so an interrupted write cannot leave a
/// half-written config behind for the core to load.
pub fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    // Unique per call: the watcher thread and a command can write the same file
    // at the same time, and one rename would otherwise move the other's temp
    // file out from under it.
    static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid path: {}", path.display()))?;
    ensure(parent.to_path_buf())?;
    let temp = parent.join(format!(
        ".{}.{}.{}.tmp",
        file_name_of(path),
        std::process::id(),
        WRITE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&temp, content).map_err(|e| format!("Failed to write {}: {e}", temp.display()))?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("Failed to write {}: {e}", path.display())
    })
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string())
}

/// Windows device names, reserved with or without an extension.
const RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Turn a user-supplied name into something safe to use as a flat file name.
///
/// Both profiles and Prism rule files are flat inside their own directories, so
/// there is no legitimate reason for a separator, a parent component, or a
/// control character to get through.
pub fn sanitize_name(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Name must not be empty".to_string());
    }
    if trimmed.len() > 128 {
        return Err("Name is too long (128 bytes max)".to_string());
    }
    if trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
        || trimmed.chars().any(char::is_control)
    {
        return Err("Name contains invalid characters".to_string());
    }

    let allowed: String = trimmed.chars().filter(|c| is_allowed_char(*c)).collect();
    if allowed.is_empty() {
        return Err("Name has no usable characters".to_string());
    }
    if allowed.starts_with('.') {
        return Err("Name must not start with a dot".to_string());
    }

    let stem = allowed.split('.').next().unwrap_or(&allowed).trim();
    if RESERVED_NAMES.contains(&stem.to_ascii_uppercase().as_str()) {
        return Err(format!("{stem} is a reserved device name"));
    }
    Ok(allowed)
}

fn is_allowed_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(c, '-' | '_' | '.' | ' ' | '(' | ')')
        || matches!(c,
            '\u{4e00}'..='\u{9fff}'   // CJK Unified Ideographs
            | '\u{3040}'..='\u{309f}' // Hiragana
            | '\u{30a0}'..='\u{30ff}' // Katakana
            | '\u{ac00}'..='\u{d7af}' // Hangul Syllables
            | '\u{f900}'..='\u{faff}' // CJK Compatibility Ideographs
        )
}
