// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Locating a local `aria2c` and asking it what version it is.
//!
//! The application never ships aria2c and never downloads it: it only looks for
//! a binary the user already has. Three places are searched, in order — the
//! explicit path stored in the settings, the `WINGHARNESS_ARIA2` environment
//! variable, and finally `PATH`. Anything past that (the RPC child, the actual
//! transfers) lives in `aria2.rs`.
//!
//! Probing is deliberately cheap and side-effect free: it stats files and, for
//! [`Aria2Tool::status`], runs one `--version` with a timeout. Nothing is
//! persisted here.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use tokio::process::Command;

use crate::models::{ToolSource, ToolStatus};

/// Identifies this tool in `ToolStatus`, the same way a backend id does.
pub const ID: &str = "aria2";

/// Environment variable that may point at a specific `aria2c`.
pub const ENV_VAR: &str = "WINGHARNESS_ARIA2";

/// `aria2c --version` must answer within this window or the child is killed.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// A resolved binary plus where the resolution came from.
pub type Resolved = (PathBuf, ToolSource);

/// Looks up a local `aria2c` and caches a successful resolution.
///
/// The settings path is the only input, and it can change at runtime, so the
/// cache is keyed by that value and dropped whenever [`Aria2Tool::set_override`]
/// runs. Misses are not cached: a user who installs aria2c while the app is
/// running should see it after pressing "probe again" instead of restarting.
pub struct Aria2Tool {
    override_path: Mutex<Option<String>>,
    cache: Mutex<Option<(Option<String>, Resolved)>>,
}

impl Aria2Tool {
    pub fn new(override_path: Option<String>) -> Self {
        let tool = Self {
            override_path: Mutex::new(None),
            cache: Mutex::new(None),
        };
        tool.set_override(override_path);
        tool
    }

    /// Replace the explicit path. An empty or whitespace-only value is the same
    /// as "not configured", which keeps the settings round trip idempotent.
    pub fn set_override(&self, path: Option<String>) {
        let normalized = path
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Ok(mut slot) = self.override_path.lock() {
            *slot = normalized;
        }
        if let Ok(mut cache) = self.cache.lock() {
            *cache = None;
        }
    }

    /// The three-step probe chain. A configured path that does not work is
    /// logged and then skipped, so a stale setting cannot hide a working binary
    /// on `PATH`.
    pub fn resolve(&self) -> Option<Resolved> {
        let override_path = self.override_path();
        if let Some(cached) = self.cached(&override_path) {
            return Some(cached);
        }
        let resolved = self.lookup(override_path.as_deref())?;
        self.remember(override_path, &resolved);
        Some(resolved)
    }

    pub fn binary(&self) -> Option<PathBuf> {
        self.resolve().map(|(path, _)| path)
    }

    pub fn is_available(&self) -> bool {
        self.binary().is_some()
    }

    /// Resolve, then run `--version` once. `present` reports the file, `version`
    /// reports whether it answered like aria2c.
    pub async fn status(&self) -> ToolStatus {
        let Some((path, source)) = self.resolve() else {
            return ToolStatus {
                id: ID.to_string(),
                present: false,
                path: None,
                version: None,
                source: None,
            };
        };
        let version = probe_version(&path).await;
        ToolStatus {
            id: ID.to_string(),
            present: true,
            path: Some(path.to_string_lossy().into_owned()),
            version,
            source: Some(source),
        }
    }

    fn override_path(&self) -> Option<String> {
        self.override_path
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    fn cached(&self, override_path: &Option<String>) -> Option<Resolved> {
        let cache = self.cache.lock().ok()?;
        let (key, resolved) = cache.as_ref()?;
        (key == override_path).then(|| resolved.clone())
    }

    fn remember(&self, key: Option<String>, resolved: &Resolved) {
        if let Ok(mut cache) = self.cache.lock() {
            *cache = Some((key, resolved.clone()));
        }
    }

    fn lookup(&self, override_path: Option<&str>) -> Option<Resolved> {
        if let Some(path) = override_path {
            match usable_binary(Path::new(path)) {
                Some(binary) => return Some((binary, ToolSource::Override)),
                None => log::warn!("The configured aria2c path is not a usable file: {path}"),
            }
        }
        if let Some(value) = env::var_os(ENV_VAR) {
            let value = value.to_string_lossy().into_owned();
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                match usable_binary(Path::new(trimmed)) {
                    Some(binary) => return Some((binary, ToolSource::Env)),
                    None => log::warn!("{ENV_VAR} is not a usable aria2c path: {trimmed}"),
                }
            }
        }
        search_path().map(|binary| (binary, ToolSource::Path))
    }
}

/// A path that exists and is a regular file. Empty input is "not configured".
fn usable_binary(path: &Path) -> Option<PathBuf> {
    if path.as_os_str().is_empty() {
        return None;
    }
    path.is_file().then(|| path.to_path_buf())
}

/// Walk the process `PATH`.
fn search_path() -> Option<PathBuf> {
    search_in(env::var_os("PATH"))
}

/// Walk an explicit `PATH` value, so the lookup can be tested without touching
/// the process environment.
fn search_in(path: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let path = path?;
    let names: &[&str] = if cfg!(windows) {
        &["aria2c.exe", "aria2c"]
    } else {
        &["aria2c"]
    };
    for folder in env::split_paths(&path) {
        if folder.as_os_str().is_empty() {
            continue;
        }
        for name in names {
            let candidate = folder.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Builds a command whose child never flashes a console window.
///
/// aria2c is a console program: started from a GUI process on Windows it would
/// otherwise allocate a window of its own, both for the RPC daemon and for every
/// `--version` probe.
pub fn new_command(bin: &Path) -> Command {
    let mut command = Command::new(bin);
    #[cfg(windows)]
    {
        // `tokio::process::Command` forwards this to `std` and adds the
        // `CREATE_NO_WINDOW` flag to the spawn attributes.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Run `aria2c --version` and parse the banner. `None` means the file exists but
/// could not be run, or did not answer in time.
pub async fn probe_version(bin: &Path) -> Option<String> {
    let mut command = new_command(bin);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            log::warn!("Could not run aria2c --version: {error}");
            return None;
        }
        Err(_) => {
            log::warn!("aria2c --version did not answer within {} seconds.", PROBE_TIMEOUT.as_secs());
            return None;
        }
    };
    if !output.status.success() {
        log::warn!("aria2c --version exited with {:?}.", output.status.code());
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(version) = parse_version(&stdout) {
        return Some(version);
    }
    parse_version(&String::from_utf8_lossy(&output.stderr))
}

/// Extract the version from `aria2c --version` output.
///
/// The banner reads `aria2 version 1.37.0`, followed by a copyright block; some
/// builds print `aria2c version 1.36.0` instead. When the banner word is missing
/// the first dotted numeric token on that line is accepted, and text without a
/// version returns `None`.
pub fn parse_version(output: &str) -> Option<String> {
    let line = output.lines().find(|line| !line.trim().is_empty())?;
    let mut words = line.split_whitespace();
    while let Some(word) = words.next() {
        if word.eq_ignore_ascii_case("version") {
            if let Some(next) = words.next() {
                return version_token(next);
            }
        }
    }
    line.split_whitespace().find_map(version_token)
}

/// A version-shaped word: digits, at least one dot, and only version characters.
fn version_token(word: &str) -> Option<String> {
    let trimmed = word.trim_matches(|character: char| {
        !character.is_ascii_alphanumeric() && character != '.' && character != '-' && character != '+'
    });
    let candidate = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    let mut segments = candidate.split('.');
    let major = segments.next()?;
    if major.is_empty() || !major.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if !segments.next().is_some_and(|minor| {
        minor.starts_with(|character: char| character.is_ascii_digit())
    }) {
        return None;
    }
    let shaped = candidate
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+' | '_'));
    shaped.then(|| candidate.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_binary(name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join(name);
        std::fs::write(&path, b"not a real binary").expect("a placeholder file");
        (dir, path)
    }

    #[test]
    fn parses_the_version_banner() {
        assert_eq!(
            parse_version("aria2 version 1.37.0\nCopyright (C) 2006, 2019 Tatsuhiro Tsujikawa")
                .as_deref(),
            Some("1.37.0")
        );
        assert_eq!(parse_version("aria2c version 1.36.0").as_deref(), Some("1.36.0"));
        assert_eq!(parse_version("aria2 version v1.38.0").as_deref(), Some("1.38.0"));
        assert_eq!(parse_version("\n\naria2 version 1.35.0\n").as_deref(), Some("1.35.0"));
    }

    #[test]
    fn rejects_output_without_a_version() {
        assert!(parse_version("").is_none());
        assert!(parse_version("Copyright (C) 2006, 2019 Tatsuhiro Tsujikawa").is_none());
        assert!(parse_version("aria2 is a utility for downloading files").is_none());
        assert!(parse_version("version").is_none());
    }

    #[test]
    fn a_blank_override_counts_as_not_configured() {
        let tool = Aria2Tool::new(Some("   ".to_string()));
        assert!(tool.override_path().is_none());
        assert_ne!(tool.resolve().map(|(_, source)| source), Some(ToolSource::Override));
    }

    #[test]
    fn an_explicit_path_wins_and_is_reported_as_override() {
        let (_dir, path) = temp_binary("aria2c.exe");
        let tool = Aria2Tool::new(Some(path.to_string_lossy().into_owned()));
        let (resolved, source) = tool.resolve().expect("the override resolves");
        assert_eq!(resolved, path);
        assert_eq!(source, ToolSource::Override);
        assert!(tool.is_available());
    }

    #[test]
    fn a_missing_override_falls_through_instead_of_pinning_a_dead_path() {
        let tool = Aria2Tool::new(Some("definitely-not-here/aria2c.exe".to_string()));
        assert_ne!(tool.resolve().map(|(_, source)| source), Some(ToolSource::Override));
    }

    #[test]
    fn clearing_the_override_drops_the_cached_resolution() {
        let (_dir, path) = temp_binary("aria2c.exe");
        let tool = Aria2Tool::new(Some(path.to_string_lossy().into_owned()));
        assert_eq!(tool.resolve().map(|(_, source)| source), Some(ToolSource::Override));
        tool.set_override(None);
        assert_ne!(tool.resolve().map(|(_, source)| source), Some(ToolSource::Override));
    }

    #[test]
    fn path_search_ignores_empty_entries_and_reports_hits() {
        assert!(search_in(None).is_none());
        assert!(search_in(Some(std::ffi::OsString::from(""))).is_none());

        let dir = tempfile::tempdir().expect("a temporary directory");
        let name = if cfg!(windows) { "aria2c.exe" } else { "aria2c" };
        let binary = dir.path().join(name);
        std::fs::write(&binary, b"placeholder").expect("a placeholder file");
        let found = search_in(Some(dir.path().as_os_str().to_os_string()));
        assert_eq!(found, Some(binary));
    }

    #[tokio::test]
    async fn a_missing_binary_reports_absent_without_a_source() {
        let tool = Aria2Tool::new(Some("definitely-not-here/aria2c.exe".to_string()));
        let status = tool.status().await;
        assert_eq!(status.id, ID);
        assert_eq!(status.present, tool.is_available());
        if !status.present {
            assert!(status.path.is_none());
            assert!(status.version.is_none());
            assert!(status.source.is_none());
        }
    }

    #[tokio::test]
    async fn a_file_that_cannot_run_is_present_but_has_no_version() {
        let (_dir, path) = temp_binary("aria2c.exe");
        let tool = Aria2Tool::new(Some(path.to_string_lossy().into_owned()));
        let status = tool.status().await;
        assert!(status.present);
        assert_eq!(status.source, Some(ToolSource::Override));
        assert!(status.path.is_some());
        assert!(status.version.is_none());
    }

    /// Needs a real aria2c: `set WINGHARNESS_ARIA2=<path>` and run with `--ignored`.
    #[tokio::test]
    #[ignore = "requires a local aria2c"]
    async fn probes_a_real_binary() {
        let tool = Aria2Tool::new(std::env::var(ENV_VAR).ok());
        let status = tool.status().await;
        assert!(status.present, "aria2c was not found");
        assert!(status.version.is_some(), "no version was parsed from the banner");
    }
}
