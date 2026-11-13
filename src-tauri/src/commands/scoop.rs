//! Scoop installation, environment variables and the local package catalog.
//!
//! Everything the page changes about the machine is prepared here: the folder
//! Scoop is installed into, the junction and the `SCOOP` / `SCOOP_GLOBAL`
//! variables that point at it, and the `.cmd` scripts a terminal runs. The
//! scripts carry paths and proxy settings in the child's *environment* and
//! reference them as `%SCOOP%` or `%HTTP_PROXY%`, so a user name or folder with
//! non-ASCII characters survives the jump into `cmd.exe` — the script files
//! themselves stay pure ASCII.
//!
//! The vendor installer is bundled from `resources/scoop/install.ps1` at build
//! time; nothing is downloaded at run time. It is Unlicense (public domain);
//! see `THIRD_PARTY_NOTICES.md`.

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::config::{self, ProxyMode};
use crate::proc::NoWindow;

/// The official installer, vendored so installing Scoop never needs the app to
/// reach `get.scoop.sh` first. It still honours `-Proxy` / `-NoProxy`.
const INSTALL_SCRIPT: &str = include_str!("../../resources/scoop/install.ps1");
const INSTALL_SCRIPT_NAME: &str = "install.ps1";
const INSTALL_CMD_NAME: &str = "install.cmd";
const RUN_CMD_NAME: &str = "run.cmd";
/// Folder under the data directory holding the generated scripts. It is
/// deliberately not inside the Scoop root: the default install folder is
/// `<data dir>/scoop`, and generated files must not land in the package tree.
const WORK_DIR_NAME: &str = "scoop-page";
const SEARCH_LIMIT: usize = 80;
const LOOPBACK_BYPASS: &str = "localhost,127.0.0.1,::1";

/// One environment variable a script run receives.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScoopEnvVar {
    pub name: String,
    pub value: String,
}

/// Where the two Scoop folders and their fixed links stand right now.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopStatusView {
    /// Whether the `SCOOP` folder holds a Scoop install.
    pub installed: bool,
    pub version: Option<String>,

    /// `SCOOP`: the fixed link `ScoopCurrent`.
    pub root: String,
    /// The real folder the `SCOOP` link points at.
    pub target: String,
    /// The fixed path when it is a junction.
    pub link: Option<String>,
    /// What the `SCOOP` junction points at, when it is one.
    pub link_target: Option<String>,

    /// `SCOOP_GLOBAL`: the fixed link `ScoopGlobalCurrent`.
    pub global_root: String,
    /// The real folder the `SCOOP_GLOBAL` link points at.
    pub global_target: String,
    pub global_link: Option<String>,
    pub global_link_target: Option<String>,

    pub data_dir: String,
    pub default_dir: String,
    pub user_dir: Option<String>,
    pub user_global_dir: Option<String>,
    /// The user-scope environment variables as stored in the registry.
    pub env_scoop: Option<String>,
    pub env_scoop_global: Option<String>,
    /// A usable Scoop install somewhere else, for the adopt prompt.
    pub other_install: Option<String>,
    /// The proxy the app setting resolves to, before any page override.
    pub proxy: ScoopProxyView,
    pub buckets: Vec<ScoopBucketView>,
    pub apps: Vec<ScoopAppView>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScoopBucketView {
    pub name: String,
    /// Number of manifests in the bucket.
    pub apps: usize,
    pub path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScoopAppView {
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub homepage: Option<String>,
    pub bucket: Option<String>,
    /// Installed under `SCOOP_GLOBAL` instead of `SCOOP`.
    pub global: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScoopProxyView {
    /// `none`, `system` or `custom`.
    pub mode: String,
    /// The concrete address, when one is known.
    pub url: Option<String>,
    /// `settings` when it follows the app's proxy section, `page` otherwise.
    pub source: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScoopSearchHit {
    pub name: String,
    pub bucket: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub homepage: Option<String>,
    pub installed: bool,
}

/// A prepared terminal run: the script, its path, and the environment it needs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopPlanView {
    pub root: String,
    pub target: String,
    pub link: Option<String>,
    pub global_root: String,
    pub global_target: String,
    pub global_link: Option<String>,
    pub work_dir: String,
    /// Absolute script path to run. An explicit path matters: with
    /// `NoDefaultCurrentDirectoryInExePath` set, `cmd /c run.cmd` would not
    /// find a file in the working directory.
    pub command: String,
    pub script_path: String,
    /// The script's full text, shown in the UI before it runs.
    pub script: String,
    pub env: Vec<ScoopEnvVar>,
    pub proxy: ScoopProxyView,
    /// Preparation messages, already in the order they happened.
    pub log: Vec<String>,
}

/// One folder choice: `data`, `user` or `custom`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopPathChoice {
    pub location: String,
    #[serde(default)]
    pub custom_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopLocationRequest {
    /// The `SCOOP` folder (`scoop`, behind `ScoopCurrent`).
    pub scoop: ScoopPathChoice,
    /// The `SCOOP_GLOBAL` folder (`scoopg`, behind `ScoopGlobalCurrent`).
    pub scoop_global: ScoopPathChoice,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopInstallRequest {
    pub scoop: ScoopPathChoice,
    pub scoop_global: ScoopPathChoice,
    /// `inherit` (the app setting), `none` or `custom`.
    #[serde(default = "default_proxy_mode")]
    pub proxy_mode: String,
    #[serde(default)]
    pub proxy_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopRunRequest {
    /// `install` or `search`.
    pub kind: String,
    /// `7zip` or `scoop install 7zip`.
    pub spec: String,
    #[serde(default = "default_proxy_mode")]
    pub proxy_mode: String,
    #[serde(default)]
    pub proxy_url: Option<String>,
}

fn default_proxy_mode() -> String {
    "inherit".to_string()
}

// ---------------------------------------------------------------------------
// Paths

/// The two roots Scoop works with. Each has a fixed link and a real folder.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PathKind {
    Scoop,
    Global,
}

impl PathKind {
    /// Name of the fixed link under the default config directory.
    fn link_name(self) -> &'static str {
        match self {
            PathKind::Scoop => "ScoopCurrent",
            PathKind::Global => "ScoopGlobalCurrent",
        }
    }

    /// Name of the real folder when the data or user directory is chosen.
    fn folder_name(self) -> &'static str {
        match self {
            PathKind::Scoop => "scoop",
            PathKind::Global => "scoopg",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            PathKind::Scoop => "Scoop",
            PathKind::Global => "Scoop global",
        }
    }
}

/// The fixed path the environment variables name. It lives in the directory
/// Tauri resolved (next to `data-dir.txt`), so it does not move when the data
/// directory is changed.
fn link_path(kind: PathKind) -> PathBuf {
    config::default_dir().join(kind.link_name())
}

fn data_path(kind: PathKind) -> PathBuf {
    config::dir().join(kind.folder_name())
}

fn user_path(kind: PathKind) -> Option<PathBuf> {
    env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(kind.folder_name()))
}

fn work_dir() -> PathBuf {
    config::dir().join(WORK_DIR_NAME)
}

fn install_script_path() -> PathBuf {
    work_dir().join(INSTALL_SCRIPT_NAME)
}

fn resolve_choice(choice: &ScoopPathChoice, kind: PathKind) -> Result<PathBuf, String> {
    match choice.location.as_str() {
        "user" => user_path(kind).ok_or_else(|| {
            "USERPROFILE is not set, so the user Scoop folder is unknown.".to_string()
        }),
        "data" => Ok(data_path(kind)),
        "custom" => {
            let raw = choice.custom_path.as_deref().unwrap_or("").trim();
            if raw.is_empty() {
                return Err(format!("Choose a folder for {}.", kind.noun()));
            }
            let path = PathBuf::from(raw);
            if !path.is_absolute() {
                return Err(format!(
                    "The {} folder must be an absolute path: {}",
                    kind.noun(),
                    path.display()
                ));
            }
            Ok(path)
        }
        other => Err(format!("Unknown {} location: {other}", kind.noun())),
    }
}

/// A Windows junction reports its target through `read_link`, and the target
/// comes back verbatim (`\\?\C:\…` or `\??\C:\…`).
fn read_link_target(path: &Path) -> Option<PathBuf> {
    fs::read_link(path).ok().map(|target| strip_verbatim(&target))
}

fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    for prefix in [r"\\?\", r"\??\"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// Lexical comparison: canonicalising would resolve a junction into its
/// target, which is exactly the distinction the caller is asking about.
fn same_path(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    let right = right.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    left.eq_ignore_ascii_case(&right)
}

/// True when `child` is strictly below `parent` lexically.
fn is_inside(child: &Path, parent: &Path) -> bool {
    let child = child.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase();
    let parent = parent.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase();
    child != parent && child.starts_with(&format!("{parent}\\"))
}

fn is_scoop_dir(path: &Path) -> bool {
    path.join("shims").join("scoop.cmd").is_file()
}

// ---------------------------------------------------------------------------
// Status

fn user_env(name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        use windows_registry::CURRENT_USER;
        let key = CURRENT_USER.open("Environment").ok()?;
        return key
            .get_string(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        None
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn text_field(value: &Option<serde_json::Value>, key: &str) -> Option<String> {
    value
        .as_ref()?
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn read_apps(target: &Path, global: bool) -> Vec<ScoopAppView> {
    let Ok(entries) = fs::read_dir(target.join("apps")) else {
        return Vec::new();
    };

    let mut apps: Vec<ScoopAppView> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| {
            let current = entry.path().join("current");
            let manifest = read_json(&current.join("manifest.json"));
            let install = read_json(&current.join("install.json"));
            ScoopAppView {
                name: entry.file_name().to_string_lossy().to_string(),
                version: text_field(&manifest, "version"),
                description: text_field(&manifest, "description"),
                homepage: text_field(&manifest, "homepage"),
                bucket: text_field(&install, "bucket"),
                global,
            }
        })
        .collect();

    apps.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    apps
}

/// Both install roots, `SCOOP` first, with global-only apps marked.
fn read_all_apps(scoop: &Path, global: &Path) -> Vec<ScoopAppView> {
    let mut apps = read_apps(scoop, false);
    if !same_path(scoop, global) {
        apps.extend(read_apps(global, true));
    }
    apps.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then(left.global.cmp(&right.global))
    });
    apps
}

fn read_buckets(target: &Path) -> Vec<ScoopBucketView> {
    let Ok(entries) = fs::read_dir(target.join("buckets")) else {
        return Vec::new();
    };

    let mut buckets: Vec<ScoopBucketView> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .map(|entry| {
            let path = entry.path();
            let apps = fs::read_dir(path.join("bucket"))
                .map(|files| {
                    files
                        .flatten()
                        .filter(|file| {
                            file.path()
                                .extension()
                                .and_then(|ext| ext.to_str())
                                .map(|ext| ext.eq_ignore_ascii_case("json"))
                                .unwrap_or(false)
                        })
                        .count()
                })
                .unwrap_or(0);
            ScoopBucketView {
                name: entry.file_name().to_string_lossy().to_string(),
                apps,
                path: path.display().to_string(),
            }
        })
        .collect();

    buckets.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    buckets
}

/// A small installer is not a version source; ask the installed CLI once.
fn scoop_version(root: &Path) -> Option<String> {
    let shim = root.join("shims").join("scoop.cmd");
    if !shim.is_file() {
        return None;
    }

    let output = Command::new("cmd")
        .arg("/d")
        .arg("/c")
        .arg(&shim)
        .arg("--version")
        .env("SCOOP", root)
        .env("SCOOP_GLOBAL", root)
        .creation_flags_no_window()
        .output()
        .ok()?;

    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    parse_version(&text)
}

/// Scoop prints `Current Scoop version:` followed by `v0.5.2 …`; the first
/// three-component version in the output is the one.
fn parse_version(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let token = token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != 'v' && c != 'V');
        let lower = token.to_ascii_lowercase();
        let digits = lower.strip_prefix('v').unwrap_or(&lower);
        let parts: Vec<&str> = digits.split('.').collect();
        if parts.len() >= 3
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        {
            return Some(format!("v{digits}"));
        }
    }
    None
}

/// Where a usable install was found when the fixed path is empty.
fn detect_other_install(root: &Path, target: &Path, env_scoop: Option<&str>) -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = user_path(PathKind::Scoop) {
        candidates.push(home);
    }
    candidates.push(data_path(PathKind::Scoop));
    if let Some(value) = env_scoop {
        candidates.push(PathBuf::from(value));
    }

    candidates
        .into_iter()
        .find(|candidate| {
            !same_path(candidate, root) && !same_path(candidate, target) && is_scoop_dir(candidate)
        })
        .map(|candidate| candidate.display().to_string())
}

/// A fixed link and the folder it stands for.
struct RootView {
    root: PathBuf,
    target: PathBuf,
    link: Option<PathBuf>,
}

fn root_view(kind: PathKind) -> RootView {
    let root = link_path(kind);
    let link = read_link_target(&root);
    let target = link.clone().unwrap_or_else(|| root.clone());
    RootView { root, target, link }
}

#[tauri::command]
pub fn scoop_status() -> ScoopStatusView {
    status()
}

fn status() -> ScoopStatusView {
    let scoop = root_view(PathKind::Scoop);
    let global = root_view(PathKind::Global);
    let installed = is_scoop_dir(&scoop.target);

    let env_scoop = user_env("SCOOP");
    let env_scoop_global = user_env("SCOOP_GLOBAL");
    let proxy = effective_proxy("inherit", None);

    ScoopStatusView {
        installed,
        version: if installed { scoop_version(&scoop.root) } else { None },
        root: scoop.root.display().to_string(),
        target: scoop.target.display().to_string(),
        link: scoop.link.as_ref().map(|_| scoop.root.display().to_string()),
        link_target: scoop.link.map(|path| path.display().to_string()),
        global_root: global.root.display().to_string(),
        global_target: global.target.display().to_string(),
        global_link: global.link.as_ref().map(|_| global.root.display().to_string()),
        global_link_target: global.link.map(|path| path.display().to_string()),
        data_dir: config::dir().display().to_string(),
        default_dir: config::default_dir().display().to_string(),
        user_dir: user_path(PathKind::Scoop).map(|path| path.display().to_string()),
        user_global_dir: user_path(PathKind::Global).map(|path| path.display().to_string()),
        other_install: detect_other_install(&scoop.root, &scoop.target, env_scoop.as_deref()),
        env_scoop,
        env_scoop_global,
        proxy: proxy.view(),
        buckets: if installed { read_buckets(&scoop.target) } else { Vec::new() },
        apps: if installed {
            read_all_apps(&scoop.target, &global.target)
        } else {
            Vec::new()
        },
    }
}

// ---------------------------------------------------------------------------
// Catalog and search

#[tauri::command]
pub fn scoop_search(query: String) -> Result<Vec<ScoopSearchHit>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let scoop = root_view(PathKind::Scoop);
    let global = root_view(PathKind::Global);
    if !is_scoop_dir(&scoop.target) {
        return Ok(Vec::new());
    }

    let installed: BTreeSet<String> = read_all_apps(&scoop.target, &global.target)
        .into_iter()
        .map(|app| app.name.to_lowercase())
        .collect();
    let target = &scoop.target;

    let mut hits: Vec<ScoopSearchHit> = Vec::new();
    if let Ok(buckets) = fs::read_dir(target.join("buckets")) {
        'buckets: for bucket in buckets.flatten() {
            if !bucket.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let bucket_name = bucket.file_name().to_string_lossy().to_string();
            let Ok(files) = fs::read_dir(bucket.path().join("bucket")) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if !path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("json"))
                    .unwrap_or(false)
                {
                    continue;
                }
                let name = path
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().to_string())
                    .unwrap_or_default();
                if !name.to_lowercase().contains(&query) {
                    continue;
                }
                let manifest = read_json(&path);
                hits.push(ScoopSearchHit {
                    installed: installed.contains(&name.to_lowercase()),
                    description: text_field(&manifest, "description"),
                    homepage: text_field(&manifest, "homepage"),
                    version: text_field(&manifest, "version"),
                    name,
                    bucket: bucket_name.clone(),
                });
                if hits.len() >= SEARCH_LIMIT {
                    break 'buckets;
                }
            }
        }
    }

    // An app installed from a bucket that is no longer cloned still exists.
    if hits.len() < SEARCH_LIMIT {
        for app in read_all_apps(&scoop.target, &global.target) {
            if !app.name.to_lowercase().contains(&query) {
                continue;
            }
            if hits.iter().any(|hit| hit.name.eq_ignore_ascii_case(&app.name)) {
                continue;
            }
            hits.push(ScoopSearchHit {
                name: app.name.clone(),
                bucket: app.bucket.unwrap_or_default(),
                version: app.version,
                description: app.description,
                homepage: app.homepage,
                installed: true,
            });
        }
    }

    // An exact match is what the user meant; everything else follows by name.
    hits.sort_by_key(|hit| {
        let exact = if hit.name.eq_ignore_ascii_case(&query) { 0 } else { 1 };
        (exact, hit.name.to_lowercase())
    });
    Ok(hits)
}

// ---------------------------------------------------------------------------
// Proxy

#[derive(Clone, Copy, PartialEq, Eq)]
enum EffectiveMode {
    None,
    System,
    Custom,
}

struct EffectiveProxy {
    mode: EffectiveMode,
    url: Option<String>,
    source: &'static str,
}

impl EffectiveProxy {
    fn view(&self) -> ScoopProxyView {
        ScoopProxyView {
            mode: match self.mode {
                EffectiveMode::None => "none",
                EffectiveMode::System => "system",
                EffectiveMode::Custom => "custom",
            }
            .to_string(),
            url: self.url.clone(),
            source: self.source.to_string(),
        }
    }

    fn label(&self) -> String {
        let source = if self.source == "settings" {
            "app settings"
        } else {
            "page"
        };
        match self.mode {
            EffectiveMode::None => format!("direct ({source})"),
            EffectiveMode::System => match &self.url {
                Some(url) => format!("system {url}"),
                None => "system".to_string(),
            },
            EffectiveMode::Custom => {
                format!("{} ({source})", self.url.as_deref().unwrap_or_default())
            }
        }
    }

    fn env(&self) -> Vec<(&'static str, String)> {
        let (http, https, all, no_proxy) = match self.mode {
            EffectiveMode::Custom => {
                let url = self.url.clone().unwrap_or_default();
                (url.clone(), url.clone(), url, LOOPBACK_BYPASS.to_string())
            }
            // Empty values, not an unset variable: the app process may carry a
            // custom proxy from its own setting, and a page override must win.
            EffectiveMode::None => (
                String::new(),
                String::new(),
                String::new(),
                "*".to_string(),
            ),
            EffectiveMode::System => (
                String::new(),
                String::new(),
                String::new(),
                LOOPBACK_BYPASS.to_string(),
            ),
        };

        vec![
            ("HTTP_PROXY", http.clone()),
            ("HTTPS_PROXY", https.clone()),
            ("ALL_PROXY", all.clone()),
            ("http_proxy", http),
            ("https_proxy", https),
            ("all_proxy", all),
            ("NO_PROXY", no_proxy.clone()),
            ("no_proxy", no_proxy),
        ]
    }

    /// Arguments after `scoop config`. `%SCOOP_PROXY_ADDRESS%` is expanded by
    /// `cmd.exe`; the address never enters the script text itself.
    fn config_command(&self) -> &'static str {
        match self.mode {
            EffectiveMode::Custom => "proxy \"%SCOOP_PROXY_ADDRESS%\"",
            EffectiveMode::None => "proxy none",
            EffectiveMode::System => "rm proxy >nul 2>&1",
        }
    }
}

/// Scoop's `proxy` setting is `[user:pass@]host:port`; it prepends `http://`
/// itself, so a stored scheme would be doubled.
fn scoop_proxy_address(url: &str) -> String {
    let address = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    address.trim_end_matches('/').to_string()
}

fn proxy_warnings(proxy: &EffectiveProxy) -> Vec<String> {
    match &proxy.url {
        Some(url) if url.to_ascii_lowercase().starts_with("socks") => vec![
            "Scoop can only use HTTP proxies; the socks address is stored as an HTTP proxy for its own downloads."
                .to_string(),
        ],
        _ => Vec::new(),
    }
}

fn normalize_proxy_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.contains("://") {
        Some(value.to_string())
    } else {
        Some(format!("http://{value}"))
    }
}

/// `inherit` follows Settings → Proxy; `none` and `custom` are page overrides.
fn effective_proxy(mode: &str, url: Option<&str>) -> EffectiveProxy {
    match mode {
        "none" => EffectiveProxy {
            mode: EffectiveMode::None,
            url: None,
            source: "page",
        },
        "custom" => match normalize_proxy_url(url.unwrap_or("")) {
            Some(url) => EffectiveProxy {
                mode: EffectiveMode::Custom,
                url: Some(url),
                source: "page",
            },
            None => EffectiveProxy {
                mode: EffectiveMode::None,
                url: None,
                source: "page",
            },
        },
        _ => {
            let proxy = config::load().proxy;
            match proxy.resolved_mode() {
                ProxyMode::None => EffectiveProxy {
                    mode: EffectiveMode::None,
                    url: None,
                    source: "settings",
                },
                ProxyMode::System => EffectiveProxy {
                    mode: EffectiveMode::System,
                    url: config::system_proxy_url(),
                    source: "settings",
                },
                ProxyMode::Custom => match normalize_proxy_url(&proxy.url) {
                    Some(url) => EffectiveProxy {
                        mode: EffectiveMode::Custom,
                        url: Some(url),
                        source: "settings",
                    },
                    None => EffectiveProxy {
                        mode: EffectiveMode::None,
                        url: None,
                        source: "settings",
                    },
                },
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Location, link and environment

struct AppliedLink {
    root: PathBuf,
    target: PathBuf,
    link: Option<PathBuf>,
    log: Vec<String>,
}

/// Points one fixed link at the chosen folder.
fn apply_link(choice: &ScoopPathChoice, kind: PathKind) -> Result<AppliedLink, String> {
    let root = link_path(kind);
    let target = resolve_choice(choice, kind)?;

    if target.exists() && !target.is_dir() {
        return Err(format!("{} is a file, not a folder.", target.display()));
    }
    fs::create_dir_all(&target)
        .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
    let target = strip_verbatim(&fs::canonicalize(&target).unwrap_or(target));

    // A link may not point at a folder that contains it, or at its own child:
    // either one is a loop for everything that walks the tree.
    if is_inside(&target, &root) || is_inside(&root, &target) {
        return Err(format!(
            "The {} folder cannot contain {} or sit inside it.",
            kind.noun(),
            root.display()
        ));
    }

    let mut log = vec![format!(
        "{} folder: {}",
        kind.noun(),
        target.display()
    )];
    let existing_link = read_link_target(&root);
    let mut link = None;

    if same_path(&target, &root) {
        // The chosen folder is the fixed path itself, so it must be a real
        // folder. A junction left by an earlier choice is removed (its files
        // stay where they were) rather than hidden behind.
        if existing_link.is_some() {
            fs::remove_dir(&root).map_err(|error| {
                format!("Failed to remove the link {}: {error}", root.display())
            })?;
            log.push(format!(
                "Removed the link {}; files in the previous folder were left in place",
                root.display()
            ));
        }
        fs::create_dir_all(&root)
            .map_err(|error| format!("Failed to create {}: {error}", root.display()))?;
    } else {
        if let Some(parent) = root.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }

        let replace = match &existing_link {
            Some(current) => !same_path(current, &target),
            None => root.exists(),
        };

        if replace {
            if existing_link.is_none() {
                // A real directory here must be empty, or it is the user's data.
                let empty = fs::read_dir(&root)
                    .map(|mut entries| entries.next().is_none())
                    .unwrap_or(false);
                if !empty {
                    return Err(format!(
                        "{} already exists and is not empty. Choose that folder as the {} folder instead of replacing it.",
                        root.display(),
                        kind.noun()
                    ));
                }
            }
            fs::remove_dir(&root)
                .map_err(|error| format!("Failed to remove {}: {error}", root.display()))?;
            log.push(format!("Removed the previous link {}", root.display()));
        }

        if !root.exists() {
            create_junction(&root, &target)?;
            log.push(format!(
                "Linked {} -> {} (link)",
                root.display(),
                target.display()
            ));
        }
        link = Some(root.clone());
    }

    Ok(AppliedLink {
        root,
        target,
        link,
        log,
    })
}

struct AppliedLocation {
    scoop: AppliedLink,
    global: AppliedLink,
    log: Vec<String>,
}

fn apply_location(
    scoop: &ScoopPathChoice,
    global: &ScoopPathChoice,
) -> Result<AppliedLocation, String> {
    let scoop = apply_link(scoop, PathKind::Scoop)?;
    let global = apply_link(global, PathKind::Global)?;

    let mut log = scoop.log.clone();
    log.extend(global.log.clone());

    let scoop_text = scoop.root.display().to_string();
    let global_text = global.root.display().to_string();
    set_user_env(&[
        ("SCOOP", scoop_text.as_str()),
        ("SCOOP_GLOBAL", global_text.as_str()),
    ])?;
    log.push(format!("Set user environment SCOOP={scoop_text}"));
    log.push(format!("Set user environment SCOOP_GLOBAL={global_text}"));

    Ok(AppliedLocation {
        scoop,
        global,
        log,
    })
}

#[cfg(windows)]
fn create_junction(link: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let command = format!("mklink /J \"{}\" \"{}\"", link.display(), target.display());
    let output = Command::new("cmd")
        .arg("/d")
        .arg("/c")
        .raw_arg(&command)
        .creation_flags_no_window()
        .output()
        .map_err(|error| format!("Failed to create the link: {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        Err(format!(
            "Failed to create the link {}: {}",
            link.display(),
            text.trim()
        ))
    }
}

#[cfg(not(windows))]
fn create_junction(_link: &Path, _target: &Path) -> Result<(), String> {
    Err("Scoop is only supported on Windows.".to_string())
}

/// Writes the user-scope variables. `SetEnvironmentVariable` also broadcasts
/// `WM_SETTINGCHANGE`, so Explorer and new consoles see the change.
#[cfg(windows)]
fn set_user_env(values: &[(&str, &str)]) -> Result<(), String> {
    let escape = |value: &str| value.replace('\'', "''");
    let mut script = String::new();
    for (name, value) in values {
        script.push_str(&format!(
            "[Environment]::SetEnvironmentVariable('{}', '{}', 'User');",
            escape(name),
            escape(value)
        ));
    }

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .creation_flags_no_window()
        .output()
        .map_err(|error| format!("Failed to run PowerShell: {error}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(windows))]
fn set_user_env(_values: &[(&str, &str)]) -> Result<(), String> {
    Err("Scoop is only supported on Windows.".to_string())
}

// ---------------------------------------------------------------------------
// Plans

fn environment(applied: &AppliedLocation, proxy: &EffectiveProxy) -> Vec<ScoopEnvVar> {
    let mut values = vec![
        ("SCOOP", applied.scoop.root.display().to_string()),
        ("SCOOP_GLOBAL", applied.global.root.display().to_string()),
        ("SCOOP_TARGET", applied.scoop.target.display().to_string()),
        (
            "SCOOP_GLOBAL_TARGET",
            applied.global.target.display().to_string(),
        ),
        (
            "SCOOP_INSTALL_PS1",
            install_script_path().display().to_string(),
        ),
        ("SCOOP_PROXY_LABEL", proxy.label()),
        (
            "SCOOP_PROXY_ADDRESS",
            proxy
                .url
                .as_deref()
                .map(scoop_proxy_address)
                .unwrap_or_default(),
        ),
    ];
    values.extend(proxy.env());

    values
        .into_iter()
        .map(|(name, value)| ScoopEnvVar {
            name: name.to_string(),
            value,
        })
        .collect()
}

fn write_script(name: &str, text: &str) -> Result<PathBuf, String> {
    let dir = work_dir();
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;
    let path = dir.join(name);
    fs::write(&path, text)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(path)
}

fn install_script_text(proxy: &EffectiveProxy) -> String {
    let mut script = String::new();
    script.push_str("@echo off\r\n");
    script.push_str("chcp 65001 >nul\r\n");
    script.push_str("echo [scoop] proxy: %SCOOP_PROXY_LABEL%\r\n");
    script.push_str("echo [scoop] SCOOP        (link): %SCOOP% -> %SCOOP_TARGET%\r\n");
    script.push_str("echo [scoop] SCOOP_GLOBAL (link): %SCOOP_GLOBAL% -> %SCOOP_GLOBAL_TARGET%\r\n");
    script.push_str("echo [scoop] installer: %SCOOP_INSTALL_PS1%\r\n");
    script.push_str(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%SCOOP_INSTALL_PS1%\" \
         -ScoopDir \"%SCOOP%\" -ScoopGlobalDir \"%SCOOP_GLOBAL%\"",
    );
    match proxy.mode {
        EffectiveMode::Custom => script.push_str(" -Proxy \"%HTTP_PROXY%\""),
        EffectiveMode::None => script.push_str(" -NoProxy"),
        EffectiveMode::System => {}
    }
    script.push_str("\r\n");
    script.push_str("set \"SCOOP_EXIT=%ERRORLEVEL%\"\r\n");
    script.push_str("echo [scoop] installer exited with code %SCOOP_EXIT%\r\n");
    script.push_str("if \"%SCOOP_EXIT%\"==\"0\" (\r\n");
    script.push_str("  echo [scoop] configuring the Scoop proxy for future installs\r\n");
    script.push_str(&format!(
        "  call \"%SCOOP%\\shims\\scoop.cmd\" config {}\r\n",
        proxy.config_command()
    ));
    script.push_str(")\r\n");
    script.push_str("exit /b %SCOOP_EXIT%\r\n");
    script
}

fn run_script_text(kind: &str, proxy: &EffectiveProxy) -> String {
    let mut script = String::new();
    script.push_str("@echo off\r\n");
    script.push_str("chcp 65001 >nul\r\n");
    script.push_str("echo [scoop] proxy: %SCOOP_PROXY_LABEL%\r\n");
    script.push_str("echo [scoop] SCOOP        (link): %SCOOP% -> %SCOOP_TARGET%\r\n");
    script.push_str("echo [scoop] SCOOP_GLOBAL (link): %SCOOP_GLOBAL% -> %SCOOP_GLOBAL_TARGET%\r\n");

    // `call` is required: invoking a batch file without it transfers control
    // and `exit /b` inside scoop.cmd would end this script before the next line.
    if kind == "config" {
        script.push_str("echo [scoop] applying the proxy to Scoop\r\n");
        script.push_str(&format!(
            "call \"%SCOOP%\\shims\\scoop.cmd\" config {}\r\n",
            proxy.config_command()
        ));
    } else {
        let subcommand = if kind == "search" { "search" } else { "install" };
        script.push_str(&format!(
            "echo [scoop] command: scoop {subcommand} %SCOOP_APP_ARGS%\r\n"
        ));
        script.push_str(&format!(
            "call \"%SCOOP%\\shims\\scoop.cmd\" config {}\r\n",
            proxy.config_command()
        ));
        script.push_str(&format!(
            "call \"%SCOOP%\\shims\\scoop.cmd\" {subcommand} %SCOOP_APP_ARGS%\r\n"
        ));
    }

    script.push_str("set \"SCOOP_EXIT=%ERRORLEVEL%\"\r\n");
    script.push_str("echo [scoop] scoop exited with code %SCOOP_EXIT%\r\n");
    script.push_str("exit /b %SCOOP_EXIT%\r\n");
    script
}

fn plan_view(
    applied: &AppliedLocation,
    proxy: &EffectiveProxy,
    file_name: &str,
    script: String,
    env: Vec<ScoopEnvVar>,
    mut log: Vec<String>,
) -> Result<ScoopPlanView, String> {
    let script_path = write_script(file_name, &script)?;
    log.push(format!("Script: {}", script_path.display()));
    log.push(format!("Proxy: {}", proxy.label()));

    Ok(ScoopPlanView {
        root: applied.scoop.root.display().to_string(),
        target: applied.scoop.target.display().to_string(),
        link: applied
            .scoop
            .link
            .as_ref()
            .map(|path| path.display().to_string()),
        global_root: applied.global.root.display().to_string(),
        global_target: applied.global.target.display().to_string(),
        global_link: applied
            .global
            .link
            .as_ref()
            .map(|path| path.display().to_string()),
        work_dir: work_dir().display().to_string(),
        command: script_path.display().to_string(),
        script_path: script_path.display().to_string(),
        script,
        env,
        proxy: proxy.view(),
        log,
    })
}

fn current_location() -> Result<AppliedLocation, String> {
    let scoop = root_view(PathKind::Scoop);
    if !is_scoop_dir(&scoop.target) {
        return Err("Scoop is not installed yet.".to_string());
    }
    let global = root_view(PathKind::Global);

    let scoop_link = scoop.link.as_ref().map(|_| scoop.root.clone());
    let global_link = global.link.as_ref().map(|_| global.root.clone());
    Ok(AppliedLocation {
        scoop: AppliedLink {
            link: scoop_link,
            root: scoop.root,
            target: scoop.target,
            log: Vec::new(),
        },
        global: AppliedLink {
            link: global_link,
            root: global.root,
            target: global.target,
            log: Vec::new(),
        },
        log: Vec::new(),
    })
}

/// Parses `7zip`, `scoop install 7zip` and `scoop search 7zip` into arguments.
///
/// Only app names are accepted: the result is expanded by `cmd.exe`, so a
/// token containing a shell metacharacter would be a command injection.
fn parse_spec(spec: &str, kind: &str) -> Result<String, String> {
    let mut tokens: Vec<String> = spec.split_whitespace().map(str::to_string).collect();
    if tokens
        .first()
        .map(|token| token.eq_ignore_ascii_case("scoop"))
        .unwrap_or(false)
    {
        tokens.remove(0);
    }
    if let Some(first) = tokens.first() {
        let expected = if kind == "search" { "search" } else { "install" };
        let also_ok = if kind == "search" { "install" } else { "search" };
        if first.eq_ignore_ascii_case(expected) || first.eq_ignore_ascii_case(also_ok) {
            tokens.remove(0);
        }
    }

    if tokens.is_empty() {
        return Err(
            "Enter an app name, for example 7zip or scoop install 7zip.".to_string(),
        );
    }
    if tokens.len() > 8 {
        return Err("Enter at most eight app names at a time.".to_string());
    }

    for token in &tokens {
        let valid = !token.starts_with('-')
            && token.len() <= 100
            && token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-_+/@".contains(c));
        if !valid {
            return Err(format!(
                "'{token}' is not an app name. Use names like 7zip or scoop install 7zip."
            ));
        }
    }

    Ok(tokens.join(" "))
}

#[tauri::command]
pub fn scoop_apply_location(request: ScoopLocationRequest) -> Result<ScoopStatusView, String> {
    apply_location(&request.scoop, &request.scoop_global)?;
    Ok(status())
}

#[tauri::command]
pub fn scoop_prepare_install(request: ScoopInstallRequest) -> Result<ScoopPlanView, String> {
    let mut applied = apply_location(&request.scoop, &request.scoop_global)?;
    let proxy = effective_proxy(&request.proxy_mode, request.proxy_url.as_deref());

    let script = install_script_text(&proxy);
    let env = environment(&applied, &proxy);
    let mut log = std::mem::take(&mut applied.log);
    log.push(format!("Installer: {}", install_script_path().display()));
    log.extend(proxy_warnings(&proxy));

    // Refresh the bundled copy every time: a newer app build carries a newer
    // installer, and a stale copy would silently keep installing the old one.
    fs::create_dir_all(work_dir())
        .map_err(|error| format!("Failed to create {}: {error}", work_dir().display()))?;
    fs::write(install_script_path(), INSTALL_SCRIPT)
        .map_err(|error| format!("Failed to write {}: {error}", install_script_path().display()))?;

    plan_view(&applied, &proxy, INSTALL_CMD_NAME, script, env, log)
}

#[tauri::command]
pub fn scoop_plan_run(request: ScoopRunRequest) -> Result<ScoopPlanView, String> {
    let applied = current_location()?;
    let proxy = effective_proxy(&request.proxy_mode, request.proxy_url.as_deref());

    let mut env = environment(&applied, &proxy);
    let folder_line = format!("Folder: {}", applied.scoop.target.display());
    let mut log = if request.kind == "config" {
        vec![
            "Scoop command: scoop config (proxy only)".to_string(),
            folder_line,
        ]
    } else {
        let args = parse_spec(&request.spec, &request.kind)?;
        env.push(ScoopEnvVar {
            name: "SCOOP_APP_ARGS".to_string(),
            value: args.clone(),
        });
        let subcommand = if request.kind == "search" { "search" } else { "install" };
        vec![
            format!("Scoop command: scoop {subcommand} {args}"),
            folder_line,
        ]
    };

    log.extend(proxy_warnings(&proxy));
    let script = run_script_text(&request.kind, &proxy);
    plan_view(&applied, &proxy, RUN_CMD_NAME, script, env, log)
}

#[cfg(test)]
mod tests {
    use super::{is_inside, parse_spec, parse_version, same_path, strip_verbatim, PathKind};
    use std::path::{Path, PathBuf};

    #[test]
    fn versions_are_read_from_the_reported_line() {
        let text = "Current Scoop version:\nv0.5.2 - Released at 2024-06-01\n";
        assert_eq!(parse_version(text).as_deref(), Some("v0.5.2"));
        assert_eq!(parse_version("nothing here").as_deref(), None);
    }

    #[test]
    fn specs_accept_the_documented_forms() {
        assert_eq!(parse_spec("7zip", "install").unwrap(), "7zip");
        assert_eq!(parse_spec("scoop install 7zip", "install").unwrap(), "7zip");
        assert_eq!(
            parse_spec("Scoop INSTALL extras/vscode git", "install").unwrap(),
            "extras/vscode git"
        );
        assert_eq!(parse_spec("scoop search 7z", "search").unwrap(), "7z");
    }

    #[test]
    fn specs_reject_shell_metacharacters() {
        assert!(parse_spec("7zip & del x", "install").is_err());
        assert!(parse_spec("", "install").is_err());
        assert!(parse_spec("-g", "install").is_err());
    }

    #[test]
    fn verbatim_prefixes_are_dropped() {
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\C:\Users\x\scoop")),
            PathBuf::from(r"C:\Users\x\scoop")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"\??\C:\Users\x\scoop")),
            PathBuf::from(r"C:\Users\x\scoop")
        );
    }

    #[test]
    fn paths_compare_lexically_and_case_insensitively() {
        assert!(same_path(Path::new(r"C:\Scoop\"), Path::new(r"c:\scoop")));
        assert!(!same_path(Path::new(r"C:\a"), Path::new(r"C:\b")));
    }

    #[test]
    fn each_root_has_its_own_link_and_folder() {
        assert_eq!(PathKind::Scoop.link_name(), "ScoopCurrent");
        assert_eq!(PathKind::Global.link_name(), "ScoopGlobalCurrent");
        assert_eq!(PathKind::Scoop.folder_name(), "scoop");
        assert_eq!(PathKind::Global.folder_name(), "scoopg");
    }

    #[test]
    fn nested_folders_are_detected() {
        assert!(is_inside(Path::new(r"C:\a\b"), Path::new(r"C:\a")));
        assert!(!is_inside(Path::new(r"C:\a"), Path::new(r"C:\a")));
        assert!(!is_inside(Path::new(r"C:\ab"), Path::new(r"C:\a")));
    }
}
