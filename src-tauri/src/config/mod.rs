//! User-editable application configuration.
//!
//! Deliberately plain `std`: the file is read and written with `serde_json`
//! alone, so it stays usable without a Tauri handle. The real config directory
//! is handed over once at startup through [`init`], with a `%APPDATA%` fallback
//! for anything running outside the app (tests, tools).

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// Identifier of the packaged build; matches `identifier` in `tauri.conf.json`.
///
/// Only the `%APPDATA%` fallback goes through here. A dev build overrides the
/// identifier (`src-tauri/tauri.dev.conf.json`), but it always reaches [`init`]
/// first with the directory Tauri resolved from that identifier, so this
/// constant is only seen by tools running outside the app.
pub const IDENTIFIER: &str = "com.anfioo.wingharness";

const FILE_NAME: &str = "config.json";
/// Lives in the default directory and names the directory to use instead.
///
/// Kept in the default directory on purpose: it has to be found before the app
/// knows where anything else is.
pub const POINTER_FILE: &str = "data-dir.txt";

/// Directory Tauri resolved, holding the pointer file. Never changes.
static DEFAULT_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Directory everything is actually stored in, resolved once from the pointer.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default)]
pub struct Config {
    pub workspace: Workspace,
}

/// The project the app is pointed at.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default)]
pub struct Workspace {
    /// Root of the project the file browser and the preview open at, as a
    /// Windows path.
    ///
    /// Empty means no project has been chosen yet: the pages show an empty
    /// state rather than treating it as an error.
    pub root: String,
}

/// Records the directory resolved by Tauri and resolves the data directory.
///
/// Called once from `.setup()`. The pointer is read exactly once here and the
/// result cached: a directory that changed under a running app would scatter
/// state (notes, logs, cached fonts) across two roots. Moving the data directory
/// therefore only takes effect after a restart, which the settings page asks for.
pub fn init(dir: PathBuf) {
    let resolved = read_pointer_at(&dir).unwrap_or_else(|| dir.clone());
    let _ = DEFAULT_DIR.set(dir);
    let _ = DATA_DIR.set(resolved);
}

/// Directory holding `config.json` and every other piece of persisted state.
pub fn dir() -> PathBuf {
    DATA_DIR.get().cloned().unwrap_or_else(fallback_dir)
}

/// Directory Tauri handed us: where the pointer file lives and where data falls
/// back to when no directory is configured.
pub fn default_dir() -> PathBuf {
    DEFAULT_DIR.get().cloned().unwrap_or_else(fallback_dir)
}

/// The directory the pointer currently names, read fresh from disk.
///
/// Unlike [`dir`], this is not cached: the settings page uses it to show what a
/// restart would apply, including a change made in this very session.
pub fn configured_data_dir() -> Option<PathBuf> {
    read_pointer_at(&default_dir())
}

/// Path of the pointer file itself, shown in the UI so it can be edited by hand.
pub fn pointer_path() -> PathBuf {
    default_dir().join(POINTER_FILE)
}

/// Reads the pointer file under `base`, if it names a usable directory.
///
/// `None` covers every "nothing configured" case: a missing file, a blank one,
/// a relative path, or a path that exists but is a file rather than a folder.
pub(crate) fn read_pointer_at(base: &Path) -> Option<PathBuf> {
    let bytes = fs::read(base.join(POINTER_FILE)).ok()?;
    // Notepad adds a BOM by default, so it is dropped before decoding.
    let text = String::from_utf8_lossy(strip_bom(&bytes));
    // Explorer's "Copy as path" wraps the value in quotes; dropping them means
    // pasting straight into the file works.
    let text = text.trim().trim_matches('"').trim();
    if text.is_empty() {
        return None;
    }

    let path = PathBuf::from(text);
    // A relative path would resolve against the working directory, which is not
    // something a user can reason about, so it is treated as unset.
    if !path.is_absolute() {
        return None;
    }
    // An existing non-directory means the value points at a file: using it would
    // make every create_dir_all fail.
    if path.exists() && !path.is_dir() {
        return None;
    }
    Some(path)
}

/// Writes or clears the pointer file under `base`.
///
/// `Some` writes the path atomically; `None` removes the file, which is how the
/// data directory returns to its default. Removing a file that is not there is
/// success, so clearing twice is harmless.
pub(crate) fn write_pointer_at(base: &Path, target: Option<&Path>) -> Result<(), String> {
    let pointer = base.join(POINTER_FILE);

    let Some(target) = target else {
        return match fs::remove_file(&pointer) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to remove {}: {error}", pointer.display())),
        };
    };

    fs::create_dir_all(base)
        .map_err(|error| format!("Failed to create {}: {error}", base.display()))?;

    let mut line = target.display().to_string();
    line.push('\n');

    let temp = pointer.with_extension("txt.tmp");
    fs::write(&temp, line)
        .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
    fs::rename(&temp, &pointer)
        .map_err(|error| format!("Failed to replace {}: {error}", pointer.display()))
}

fn fallback_dir() -> PathBuf {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("USERPROFILE")
                .map(|profile| PathBuf::from(profile).join("AppData").join("Roaming"))
        })
        .unwrap_or_else(|| PathBuf::from("."))
        .join(IDENTIFIER)
}

/// Full path of the configuration file.
pub fn path() -> PathBuf {
    dir().join(FILE_NAME)
}

/// Reads the configuration, falling back to defaults for anything unreadable.
///
/// Never fails: a corrupt or missing file must not stop the app from starting.
pub fn load() -> Config {
    fs::read(path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Config>(strip_bom(&bytes)).ok())
        .unwrap_or_default()
}

/// Persists the configuration atomically.
pub fn save(config: &Config) -> Result<(), String> {
    let _guard = SAVE_LOCK
        .lock()
        .map_err(|_| "Config lock poisoned.".to_string())?;

    let dir = dir();
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;

    let json = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Failed to serialize config: {error}"))?;

    let target = path();
    let temp = target.with_extension("json.tmp");

    {
        let mut file = fs::File::create(&temp)
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        file.write_all(&json)
            .map_err(|error| format!("Failed to write {}: {error}", temp.display()))?;
        file.sync_all()
            .map_err(|error| format!("Failed to flush {}: {error}", temp.display()))?;
    }

    // `fs::rename` maps to MoveFileExW with MOVEFILE_REPLACE_EXISTING on
    // Windows, so replacing an existing config is atomic on the same volume.
    fs::rename(&temp, &target)
        .map_err(|error| format!("Failed to replace {}: {error}", target.display()))
}

/// Drops a UTF-8 byte order mark.
///
/// Notepad adds one by default, and serde rejects it, which would look like
/// "my settings never save".
pub(crate) fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh install has no project, and a config file written before the
    /// workspace fields existed still loads.
    #[test]
    fn a_fresh_config_has_no_workspace_root() {
        assert!(Config::default().workspace.root.is_empty());

        // Unknown keys are dropped and the missing ones fall back to their
        // defaults, so an older file keeps working without a migration step.
        let config: Config = serde_json::from_str(r#"{"gitSvn":{"repo":"X:\\repo"}}"#).unwrap();
        assert!(config.workspace.root.is_empty());

        let json = serde_json::to_string(&Config::default()).unwrap();
        assert!(json.contains("\"workspace\""), "{json}");
    }

    #[test]
    fn strips_utf8_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"{}");
        assert_eq!(strip_bom(&bytes), b"{}");
        assert_eq!(strip_bom(b"{}"), b"{}");
    }

    /// A scratch directory that removes itself, so the pointer tests never touch
    /// the real app-data folder.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = env::temp_dir().join(format!("wingharness-config-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_and_reads_back_a_pointer() {
        let scratch = Scratch::new("roundtrip");
        let target = scratch.0.join("data");

        write_pointer_at(&scratch.0, Some(&target)).unwrap();
        assert_eq!(read_pointer_at(&scratch.0), Some(target.clone()));

        // Clearing removes the file, and clearing again is still success.
        write_pointer_at(&scratch.0, None).unwrap();
        assert_eq!(read_pointer_at(&scratch.0), None);
        write_pointer_at(&scratch.0, None).unwrap();
    }

    #[test]
    fn pointer_tolerates_a_hand_edited_file() {
        let scratch = Scratch::new("hand-edited");
        let target = scratch.0.join("data");
        let write = |contents: &[u8]| fs::write(scratch.0.join(POINTER_FILE), contents).unwrap();

        // BOM, surrounding quotes copied from Explorer, and a trailing newline.
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice(format!("\"{}\"\r\n", target.display()).as_bytes());
        write(&with_bom);
        assert_eq!(read_pointer_at(&scratch.0), Some(target.clone()));

        write(b"   \n");
        assert_eq!(read_pointer_at(&scratch.0), None);
    }

    #[test]
    fn pointer_rejects_values_that_are_not_a_directory() {
        let scratch = Scratch::new("invalid");

        // A relative path would resolve against the working directory.
        fs::write(scratch.0.join(POINTER_FILE), "data\n").unwrap();
        assert_eq!(read_pointer_at(&scratch.0), None);

        // An existing file cannot be used as a directory.
        let file = scratch.0.join("a-file");
        fs::write(&file, b"x").unwrap();
        fs::write(
            scratch.0.join(POINTER_FILE),
            format!("{}\n", file.display()),
        )
        .unwrap();
        assert_eq!(read_pointer_at(&scratch.0), None);

        // A directory that does not exist yet is fine: it starts empty.
        let missing = scratch.0.join("not-yet");
        fs::write(
            scratch.0.join(POINTER_FILE),
            format!("{}\n", missing.display()),
        )
        .unwrap();
        assert_eq!(read_pointer_at(&scratch.0), Some(missing));
    }
}
