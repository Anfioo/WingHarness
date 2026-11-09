//! User-editable application configuration.
//!
//! Deliberately plain `std` — no Tauri handle — so it stays usable from tests
//! and tools. The real config directory is handed over once at startup through
//! [`init`], with a `%APPDATA%` fallback for anything running outside the app.

use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// CC Switch（AI 编程 CLI 供应商切换）设置。
    pub ccs: crate::ccs::settings::CcsSettings,
    /// AI 配置同步（shaic）设置。
    #[serde(rename = "aiConfig")]
    pub ai_config: AiConfig,
    /// The outbound proxy the app and the tools it spawns use.
    pub proxy: ProxyConfig,
}

/// Proxy the app applies to its own HTTP clients and to its child processes.
///
/// Stored as a URL rather than a host/port pair so it covers whatever the user
/// already has — `http://`, `https://` or `socks5://`. An empty `url` means
/// "leave the environment alone", which keeps a proxy exported by the shell that
/// launched the app working.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default)]
pub struct ProxyConfig {
    /// Proxy URL, e.g. `http://127.0.0.1:7890`.
    pub url: String,
    /// Comma-separated hosts that bypass the proxy. Loopback is always added.
    #[serde(rename = "noProxy")]
    pub no_proxy: String,
}

/// Names reqwest and most command-line tools read to find a proxy. Both cases
/// are written because tools differ in which one they look at.
const PROXY_VARS: [&str; 6] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
];
const NO_PROXY_VARS: [&str; 2] = ["NO_PROXY", "no_proxy"];

/// Loopback hosts must never be proxied. The app talks to local services over
/// HTTP — the Clash controller, for one — and a proxy in global mode would route
/// those requests back into itself.
const LOOPBACK_BYPASS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// Whether this process currently carries proxy variables that *we* wrote.
/// Only those are removed when the setting is cleared, so a proxy exported by
/// the shell that started the app is never destroyed by an empty config.
static PROXY_APPLIED: AtomicBool = AtomicBool::new(false);
static NO_PROXY_APPLIED: AtomicBool = AtomicBool::new(false);

/// AI 配置同步（shaic）设置。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default)]
pub struct AiConfig {
    /// 允许被同步的 agent id 列表。
    ///
    /// `None`（键缺省）表示「全部开启」，这是新装与老配置的默认；显式列表按
    /// 原样采用，空数组表示「一个都不开」。之所以不用「空 = 全部」的约定，
    /// 是因为设置页是一排开关，必须能区分「用户全部关掉」与「用户没动过」。
    #[serde(rename = "enabledAgents")]
    pub enabled_agents: Option<Vec<String>>,
}


impl Config {
    /// Repairs values that would otherwise break a feature silently.
    fn normalize(&mut self) {
        // `None` means "every agent" and is kept as-is; an explicit list is the
        // user's literal choice, so it is only trimmed and de-duplicated. Ids are
        // lower-case constants, so folding case for the duplicate check is safe.
        self.ai_config.enabled_agents = self.ai_config.enabled_agents.as_ref().map(|ids| {
            let mut seen = HashSet::new();
            ids.iter()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .filter(|id| seen.insert(id.to_ascii_lowercase()))
                .collect()
        });

        self.proxy.url = self.proxy.url.trim().to_string();
        // A bare `host:port` is how proxy apps usually display their address.
        // Without a scheme reqwest cannot parse it, so it is assumed to be HTTP.
        if !self.proxy.url.is_empty() && !self.proxy.url.contains("://") {
            self.proxy.url = format!("http://{}", self.proxy.url);
        }
        self.proxy.no_proxy = self.proxy.no_proxy.trim().to_string();
    }
}

/// Records the directory resolved by Tauri and resolves the data directory.
///
/// Called once from `.setup()`. The pointer is read exactly once here and the
/// result cached: a directory that changed under a running app would scatter
/// state (plugins, logs, cache) across two roots. Moving the data directory
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

/// Points this process — and everything it spawns — at the configured proxy.
///
/// reqwest reads these variables when it builds a client, so every request made
/// afterwards goes through the proxy without each caller knowing about the
/// setting. Child processes inherit them too, which is why the setting replaces
/// launching the app from a console with the proxy already exported.
///
/// Called once at startup, before any client is built, and again whenever the
/// setting is saved. Already-built clients keep the proxy they were created
/// with; restarting is the only way to reach those.
pub fn apply_proxy_env(proxy: &ProxyConfig) {
    let url = proxy.url.trim();
    if url.is_empty() {
        if PROXY_APPLIED.swap(false, Ordering::SeqCst) {
            for key in PROXY_VARS {
                env::remove_var(key);
            }
        }
        if NO_PROXY_APPLIED.swap(false, Ordering::SeqCst) {
            for key in NO_PROXY_VARS {
                env::remove_var(key);
            }
        }
        return;
    }

    for key in PROXY_VARS {
        env::set_var(key, url);
    }
    PROXY_APPLIED.store(true, Ordering::SeqCst);

    // The user's list, with loopback ensured on top. Written even when the field
    // is empty: a proxy in global mode must still not swallow local requests.
    let mut bypass: Vec<&str> = LOOPBACK_BYPASS.to_vec();
    for entry in proxy.no_proxy.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        if !bypass.iter().any(|kept| kept.eq_ignore_ascii_case(entry)) {
            bypass.push(entry);
        }
    }
    let bypass = bypass.join(",");
    for key in NO_PROXY_VARS {
        env::set_var(key, &bypass);
    }
    NO_PROXY_APPLIED.store(true, Ordering::SeqCst);
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
    let mut config = fs::read(path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Config>(strip_bom(&bytes)).ok())
        .unwrap_or_default();
    config.normalize();
    config
}

/// Persists the configuration atomically.
pub fn save(config: &Config) -> Result<(), String> {
    let _guard = SAVE_LOCK
        .lock()
        .map_err(|_| "Config lock poisoned.".to_string())?;

    let mut normalized = config.clone();
    normalized.normalize();

    let dir = dir();
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;

    let json = serde_json::to_vec_pretty(&normalized)
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

    #[test]
    fn partial_json_falls_back_to_defaults() {
        let config: Config = serde_json::from_str("{}").unwrap();
        assert_eq!(config.ai_config.enabled_agents, None);
        assert_eq!(config.proxy, ProxyConfig::default());
    }

    /// A value pasted from a proxy app is usually `host:port`; the scheme is
    /// filled in so reqwest can parse it, and an explicit scheme is kept.
    #[test]
    fn proxy_url_is_trimmed_and_gets_a_default_scheme() {
        let mut config = Config::default();
        config.proxy.url = " 127.0.0.1:7890 ".to_string();
        config.proxy.no_proxy = " localhost,127.0.0.1 ".to_string();
        config.normalize();
        assert_eq!(config.proxy.url, "http://127.0.0.1:7890");
        assert_eq!(config.proxy.no_proxy, "localhost,127.0.0.1");

        config.proxy.url = "socks5://127.0.0.1:7891".to_string();
        config.normalize();
        assert_eq!(config.proxy.url, "socks5://127.0.0.1:7891");
    }

    #[test]
    fn proxy_round_trips_through_json() {
        let mut config = Config::default();
        config.proxy.url = "http://127.0.0.1:7890".to_string();
        config.proxy.no_proxy = "localhost".to_string();

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"noProxy\":\"localhost\""), "{json}");

        let back: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(back.proxy, config.proxy);
    }

    #[test]
    fn proxy_env_is_applied_and_cleared() {
        let keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
        let saved: Vec<Option<String>> = keys.iter().map(|key| env::var(key).ok()).collect();

        apply_proxy_env(&ProxyConfig {
            url: "http://127.0.0.1:7890".to_string(),
            no_proxy: "localhost".to_string(),
        });
        for key in keys {
            assert_eq!(env::var(key).ok().as_deref(), Some("http://127.0.0.1:7890"));
        }
        assert_eq!(
            env::var("NO_PROXY").ok().as_deref(),
            Some("localhost,127.0.0.1,::1")
        );

        apply_proxy_env(&ProxyConfig::default());
        for key in keys {
            assert!(env::var(key).is_err(), "{key} should be removed");
        }
        assert!(env::var("NO_PROXY").is_err());

        for (key, value) in keys.iter().zip(saved) {
            match value {
                Some(value) => env::set_var(key, value),
                None => env::remove_var(key),
            }
        }
    }

    /// Enabled agents default to `None` ("every agent"); an explicit list is the
    /// user's literal choice, kept trimmed and de-duplicated.
    #[test]
    fn enabled_agents_default_to_every_agent() {
        assert_eq!(Config::default().ai_config.enabled_agents, None);

        let json = serde_json::to_string(&Config::default()).unwrap();
        assert!(json.contains("\"aiConfig\""), "{json}");
        assert!(json.contains("\"enabledAgents\":null"), "{json}");

        let mut patched = Config {
            ai_config: AiConfig {
                enabled_agents: Some(vec![
                    "  claude-code ".to_string(),
                    String::new(),
                    "CLAUDE-CODE".to_string(),
                    "cursor".to_string(),
                ]),
            },
            ..Config::default()
        };
        patched.normalize();
        assert_eq!(
            patched.ai_config.enabled_agents,
            Some(vec!["claude-code".to_string(), "cursor".to_string()])
        );

        // An explicit empty list means "none", which is why the field is an
        // `Option`: a plain `Vec` could not tell that apart from "untouched".
        let mut none = Config {
            ai_config: AiConfig {
                enabled_agents: Some(Vec::new()),
            },
            ..Config::default()
        };
        none.normalize();
        assert_eq!(none.ai_config.enabled_agents, Some(Vec::new()));
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
            let dir = env::temp_dir().join(format!("mabang-config-{tag}-{}", std::process::id()));
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
