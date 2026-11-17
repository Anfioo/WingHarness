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
//!
//! Buckets are the exception to the scripts: a bucket is a git clone under
//! `<root>\buckets\<name>`, so the app clones and deletes them itself through
//! `git-core` instead of asking Scoop to shell out to `git.exe`.

use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::config::{self, ProxyMode};
use crate::proc::NoWindow;

/// The official installer, vendored so installing Scoop never needs the app to
/// reach `get.scoop.sh` first. It still honours `-Proxy` / `-NoProxy`.
const INSTALL_SCRIPT: &str = include_str!("../../resources/scoop/install.ps1");
const INSTALL_SCRIPT_NAME: &str = "install.ps1";
const INSTALL_CMD_NAME: &str = "install.cmd";
const RUN_CMD_NAME: &str = "run.cmd";
/// Every Scoop call goes through this wrapper instead of `shims\scoop.cmd`.
///
/// The `.cmd` shim picks its host with `where /q pwsh.exe`, so the same machine
/// runs Scoop on whatever PowerShell happens to be on `PATH`, and it loses the
/// exit code: `scoop.ps1` ends with `exec`, whose `& $path @args` only sets
/// `$LASTEXITCODE` in the caller, so the process still exits 0 after a failure.
/// Calling the entry script through this wrapper pins Windows PowerShell 5.1
/// (always present, and already the host of the installer), keeps the output —
/// `Out-String -Stream` formats inside the statement, so the final `exit`
/// cannot drop a buffered table — and returns the real status.
const RUN_WRAPPER_NAME: &str = "scoop-run.ps1";
const RUN_WRAPPER: &str = r#"# Runs one Scoop command and returns its real exit code.
#
# `& $entry @args` alone is not enough: Scoop's own `exec` swallows the status of
# the script it runs, and a bare `exit` at the end would discard the objects a
# command such as `bucket list` hands to the formatter. Formatting them here
# first makes the exit safe.
$root = $env:SCOOP
$entry = Join-Path $root 'apps\scoop\current\bin\scoop.ps1'
if (-not (Test-Path -LiteralPath $entry)) {
    $entry = Join-Path $root 'shims\scoop.ps1'
}
if (-not (Test-Path -LiteralPath $entry)) {
    Write-Host "[scoop] no Scoop entry script under $root"
    exit 127
}
& $entry @args | Out-String -Stream | Write-Host
$status = $LASTEXITCODE
if ($null -eq $status) { $status = 0 }
exit $status
"#;
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
    /// `scoop hold`: the app is pinned at its version and `scoop update *`
    /// skips it.
    pub hold: bool,
    /// A WingHarness plugin: the app name carries the plugin prefix, see
    /// [`crate::plugins::manifest::PLUGIN_PREFIX`].
    pub plugin: bool,
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
    /// A WingHarness plugin, by the same name test the overview uses.
    pub plugin: bool,
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
    /// Pass `-RunAsAdmin` to the installer. The official installer aborts when
    /// it sees an elevated token unless this flag is given, which is the case
    /// for an account running with UAC off or an app started as administrator.
    #[serde(default)]
    pub run_as_admin: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopRunRequest {
    /// `install`, `search`, `config`, `update`, `apps-update`, `app-update`,
    /// `hold`, `unhold` or `uninstall`. Buckets have their own commands, since
    /// they are cloned by the app rather than by Scoop.
    pub kind: String,
    /// `7zip` or `scoop install 7zip`; `update` and `apps-update` take nothing.
    pub spec: String,
    /// The app lives under `SCOOP_GLOBAL`, so the command carries `-g`.
    #[serde(default)]
    pub global: bool,
    /// `uninstall` also removes the app's `persist` folder (`-p`).
    #[serde(default)]
    pub purge: bool,
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

fn run_wrapper_path() -> PathBuf {
    work_dir().join(RUN_WRAPPER_NAME)
}

/// One line of a generated script that hands `<args>` to the wrapper.
///
/// The wrapper path is a variable: a non-ASCII user name would otherwise put
/// the data directory's encoding into a script that has to stay ASCII. No
/// `call` is needed — `powershell.exe` is a program, not a batch file.
fn scoop_call(script: &mut String, args: &str) {
    script.push_str("powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%SCOOP_WRAPPER%\" ");
    script.push_str(args);
    script.push_str("\r\n");
}

/// The `scoop config` arguments for one proxy mode. The quiet form carries a
/// `cmd` redirect, which only works at the end of the line: any further text
/// would be swallowed as the redirect target.
fn proxy_config_args(proxy: &EffectiveProxy) -> String {
    let mut args = format!("config {}", proxy.config_args());
    if proxy.config_quiet() {
        args.push_str(" >nul 2>&1");
    }
    args
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

fn is_json_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
}

/// Scoop's own record of an installed app, which it writes into `current`:
/// the manifest it installed from, and the bucket that manifest came from.
const APP_MANIFEST_FILE: &str = "scoop-manifest.json";
const APP_INSTALL_FILE: &str = "scoop-install.json";
/// The names those two files carried before Scoop qualified them. Only an app
/// installed by an older Scoop still has them.
const LEGACY_MANIFEST_FILE: &str = "manifest.json";
const LEGACY_INSTALL_FILE: &str = "install.json";

/// One of the two metadata files of an installed app, under either name.
///
/// The current name wins and the old one is the fallback, so an install made by
/// this Scoop and one made by an older Scoop are both read. Getting this wrong
/// is silent — every field simply comes back empty — so the two candidates are
/// tried in one place.
fn read_app_json(current: &Path, primary: &str, legacy: &str) -> Option<serde_json::Value> {
    read_json(&current.join(primary)).or_else(|| read_json(&current.join(legacy)))
}

fn text_field(value: &Option<serde_json::Value>, key: &str) -> Option<String> {
    value.as_ref().and_then(|value| text_of(value, key))
}

fn text_of(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// A flag Scoop wrote as `true`. `scoop unhold` saves the key as `null` rather
/// than removing it, so anything but `true` counts as "not set".
fn flag_field(value: &Option<serde_json::Value>, key: &str) -> bool {
    value
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
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
            let manifest = read_app_json(&current, APP_MANIFEST_FILE, LEGACY_MANIFEST_FILE);
            let install = read_app_json(&current, APP_INSTALL_FILE, LEGACY_INSTALL_FILE);
            let name = entry.file_name().to_string_lossy().to_string();
            ScoopAppView {
                plugin: crate::plugins::manifest::is_plugin_app(&name),
                name,
                version: text_field(&manifest, "version"),
                description: text_field(&manifest, "description"),
                homepage: text_field(&manifest, "homepage"),
                bucket: text_field(&install, "bucket"),
                hold: flag_field(&install, "hold"),
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
                        .filter(|file| is_json_file(&file.path()))
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

/// Runs a captured child with a hard deadline.
///
/// The Scoop commands are off the main thread, but a PowerShell command that
/// never exits would still leave the page waiting forever. A child that
/// outlives the deadline is killed together with its descendants.
fn run_with_timeout(mut command: Command, seconds: u64, label: &str) -> Result<std::process::Output, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags_no_window()
        .spawn()
        .map_err(|error| format!("Failed to start {label}: {error}"))?;
    let pid = child.id();

    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });

    match receiver.recv_timeout(std::time::Duration::from_secs(seconds)) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(format!("{label} failed: {error}")),
        Err(_) => {
            let _ = crate::proc::kill_tree_of(pid);
            Err(format!("{label} did not finish within {seconds} seconds."))
        }
    }
}

/// A small installer is not a version source; ask the installed CLI once.
fn scoop_version(root: &Path) -> Option<String> {
    let entry = scoop_entry_script(root)?;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&entry)
        .arg("--version")
        .env("SCOOP", root)
        .env("SCOOP_GLOBAL", root);
    let output = run_with_timeout(command, 20, "scoop --version").ok()?;

    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    parse_version(&text)
}

/// The script that runs Scoop, preferring the real one over a shim so a stale
/// absolute path in `shims\scoop.cmd` cannot send the call to another install.
fn scoop_entry_script(root: &Path) -> Option<PathBuf> {
    let entry = root
        .join("apps")
        .join("scoop")
        .join("current")
        .join("bin")
        .join("scoop.ps1");
    if entry.is_file() {
        return Some(entry);
    }
    let shim = root.join("shims").join("scoop.ps1");
    if shim.is_file() {
        return Some(shim);
    }
    None
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

#[tauri::command(async)]
pub fn scoop_status() -> ScoopStatusView {
    status()
}

/// Whether a Scoop install is on disk, answered from the fixed link alone.
///
/// The page asks this first so it can show the overview instead of the install
/// screen while the full status is still being read: [`status`] walks every
/// bucket and every installed manifest and asks the CLI for its version, which
/// a badge cannot wait for.
#[tauri::command(async)]
pub fn scoop_installed() -> bool {
    is_scoop_dir(&root_view(PathKind::Scoop).target)
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
// Pinning
//
// A pin is not a command Scoop has to run: `scoop hold` only writes `hold:
// true` into the app's own install record, which is a file this app already
// reads. Writing it here costs one file write instead of a PowerShell session,
// and it keeps working when the CLI or the proxy is having a bad day.

/// Pins an installed app at its version, or releases it.
///
/// Returns the refreshed app list of both roots, so the page never re-reads the
/// whole catalog for a flag flip.
#[tauri::command(async)]
pub fn scoop_set_hold(name: String, global: bool, hold: bool) -> Result<Vec<ScoopAppView>, String> {
    let root = if global {
        root_view(PathKind::Global).target
    } else {
        root_view(PathKind::Scoop).target
    };
    set_app_hold(&root, name.trim(), hold)?;
    Ok(read_all_apps(
        &root_view(PathKind::Scoop).target,
        &root_view(PathKind::Global).target,
    ))
}

/// Writes the pin into the record Scoop keeps for the installed app.
fn set_app_hold(root: &Path, name: &str, hold: bool) -> Result<(), String> {
    if !is_package_name(name) {
        return Err(format!("'{name}' is not an app name."));
    }

    // `current` is a junction over the installed version, and a write through
    // it lands in that version's folder, which is where Scoop keeps the record.
    let current = root.join("apps").join(name).join("current");
    if !current.is_dir() {
        return Err(format!(
            "'{name}' is not installed under {}.",
            root.display()
        ));
    }

    let path = [APP_INSTALL_FILE, LEGACY_INSTALL_FILE]
        .iter()
        .map(|file| current.join(file))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "Neither {APP_INSTALL_FILE} nor {LEGACY_INSTALL_FILE} is in {}.",
                current.display()
            )
        })?;

    let text = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    // The record is written by Scoop and by other tools; a BOM is not JSON.
    let mut value: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object.", path.display()))?;

    if hold {
        object.insert("hold".to_string(), serde_json::Value::Bool(true));
    } else {
        // `scoop unhold` leaves the key behind as `null`; dropping it reads the
        // same way, because only `true` is a pin.
        object.remove("hold");
    }

    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("Failed to encode {}: {error}", path.display()))?;
    fs::write(&path, format!("{text}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

// ---------------------------------------------------------------------------
// Catalog and search

#[tauri::command(async)]
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
                if !is_json_file(&path) {
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
                    plugin: crate::plugins::manifest::is_plugin_app(&name),
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
                plugin: app.plugin,
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
    fn config_args(&self) -> &'static str {
        match self.mode {
            EffectiveMode::Custom => "proxy \"%SCOOP_PROXY_ADDRESS%\"",
            EffectiveMode::None => "proxy none",
            // Removing a setting that is not there is an error to Scoop, and on
            // System mode with no stored proxy that is the ordinary case.
            EffectiveMode::System => "rm proxy",
        }
    }

    fn config_quiet(&self) -> bool {
        matches!(self.mode, EffectiveMode::System)
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
    let mut process = Command::new("cmd");
    process.arg("/d").arg("/c").raw_arg(&command);
    let output = run_with_timeout(process, 20, "mklink")?;

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

/// Writes the user-scope variables and asks Windows to reload its environment.
///
/// The registry write is the part that must succeed, and it is instant. The
/// broadcast is what lets already-running shells see the change, but
/// `SetEnvironmentVariable` waits on every top-level window while doing it —
/// measured at seconds even with a responsive desktop, and indefinitely when
/// one window is stuck. It therefore runs in a detached helper and is not
/// awaited; the app's own commands always pass the variables explicitly.
#[cfg(windows)]
fn set_user_env(values: &[(&str, &str)]) -> Result<(), String> {
    use windows_registry::CURRENT_USER;

    let key = CURRENT_USER
        .create("Environment")
        .map_err(|error| format!("Failed to open the user environment key: {error}"))?;
    for (name, value) in values {
        key.set_string(name, value)
            .map_err(|error| format!("Failed to write {name}: {error}"))?;
    }

    let escape = |value: &str| value.replace('\'', "''");
    let mut script = String::new();
    for (name, value) in values {
        script.push_str(&format!(
            "[Environment]::SetEnvironmentVariable('{}', '{}', 'User');",
            escape(name),
            escape(value)
        ));
    }

    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &script,
    ]);
    let _ = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags_no_window()
        .spawn();

    Ok(())
}

#[cfg(not(windows))]
fn set_user_env(_values: &[(&str, &str)]) -> Result<(), String> {
    Err("Scoop is only supported on Windows.".to_string())
}

// ---------------------------------------------------------------------------
// Plans

fn environment(applied: &AppliedLocation, proxy: &EffectiveProxy) -> Result<Vec<ScoopEnvVar>, String> {
    // Refreshed on every plan: a newer app build can change the wrapper, and a
    // stale copy would keep running the old one.
    let wrapper = run_wrapper_path();
    fs::create_dir_all(work_dir())
        .map_err(|error| format!("Failed to create {}: {error}", work_dir().display()))?;
    fs::write(&wrapper, RUN_WRAPPER)
        .map_err(|error| format!("Failed to write {}: {error}", wrapper.display()))?;

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
        ("SCOOP_WRAPPER", wrapper.display().to_string()),
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

    Ok(values
        .into_iter()
        .map(|(name, value)| ScoopEnvVar {
            name: name.to_string(),
            value,
        })
        .collect())
}

/// The real folder behind `SCOOP`: where the installed apps live.
pub(crate) fn scoop_root() -> Result<PathBuf, String> {
    Ok(current_location()?.scoop.target)
}

/// `<scoop>/apps` — one folder per installed app, plugin or not.
pub(crate) fn apps_dir() -> Result<PathBuf, String> {
    Ok(scoop_root()?.join("apps"))
}

/// `<scoop>/persist` — the per-app folder Scoop keeps across updates.
pub(crate) fn persist_dir() -> Result<PathBuf, String> {
    Ok(scoop_root()?.join("persist"))
}

/// A Scoop command prepared for a caller that captures its output instead of
/// running it in the page's terminal.
pub(crate) struct ScoopCommand {
    pub script: PathBuf,
    pub env: Vec<ScoopEnvVar>,
}

/// Prepares `<subcommand> <app>` as a script plus the environment it needs.
///
/// The app name travels in the child's environment rather than in the script
/// text, so the script file stays pure ASCII and the name cannot become part of
/// a command line (`cmd.exe` would expand it). The caller validates the name
/// first: this is the last point before it reaches a shell variable.
pub(crate) fn prepare_scoop_command(subcommand: &str, app: &str) -> Result<ScoopCommand, String> {
    let applied = current_location()?;
    let proxy = effective_proxy("inherit", None);

    let mut env = environment(&applied, &proxy)?;
    env.push(ScoopEnvVar {
        name: "SCOOP_PLUGIN_APP".to_string(),
        value: app.to_string(),
    });

    let mut script = String::from("@echo off\r\nchcp 65001 >nul\r\n");
    scoop_call(&mut script, &format!("{subcommand} \"%SCOOP_PLUGIN_APP%\""));
    script.push_str("exit /b %ERRORLEVEL%\r\n");
    let path = write_script(&format!("plugin-{subcommand}.cmd"), &script)?;

    Ok(ScoopCommand { script: path, env })
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

fn install_script_text(proxy: &EffectiveProxy, run_as_admin: bool) -> String {
    let mut script = String::new();
    script.push_str("@echo off\r\n");
    script.push_str("chcp 65001 >nul\r\n");
    script.push_str("echo [scoop] proxy: %SCOOP_PROXY_LABEL%\r\n");
    script.push_str("echo [scoop] SCOOP link        : %SCOOP%\r\n");
    script.push_str("echo [scoop] SCOOP real        : %SCOOP_TARGET%\r\n");
    script.push_str("echo [scoop] SCOOP_GLOBAL link : %SCOOP_GLOBAL%\r\n");
    script.push_str("echo [scoop] SCOOP_GLOBAL real : %SCOOP_GLOBAL_TARGET%\r\n");
    script.push_str("echo [scoop] installer: %SCOOP_INSTALL_PS1%\r\n");
    script.push_str(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%SCOOP_INSTALL_PS1%\" \
         -ScoopDir \"%SCOOP%\" -ScoopGlobalDir \"%SCOOP_GLOBAL%\"",
    );
    // The vendor installer aborts under an elevated token unless it is told to
    // go ahead; that is what the install screen's switch is for. A bare flag
    // carries no variable, so it cannot upset the ASCII-only script.
    if run_as_admin {
        script.push_str(" -RunAsAdmin");
    }
    match proxy.mode {
        EffectiveMode::Custom => script.push_str(" -Proxy \"%HTTP_PROXY%\""),
        EffectiveMode::None => script.push_str(" -NoProxy"),
        EffectiveMode::System => {}
    }
    script.push_str("\r\n");
    script.push_str("set \"SCOOP_EXIT=%ERRORLEVEL%\"\r\n");
    script.push_str("echo [scoop] installer exited with code %SCOOP_EXIT%\r\n");
    // `goto` rather than an `if (...)` block: a `)` inside an expanded proxy
    // address would close the block early.
    script.push_str("if not \"%SCOOP_EXIT%\"==\"0\" goto scoop_done\r\n");
    script.push_str("echo [scoop] configuring the Scoop proxy for future installs\r\n");
    let config = proxy_config_args(proxy);
    scoop_call(&mut script, &config);
    script.push_str(":scoop_done\r\n");
    script.push_str("exit /b %SCOOP_EXIT%\r\n");
    script
}

fn run_script_text(kind: &str, proxy: &EffectiveProxy, update_globals: bool) -> String {
    let mut script = String::new();
    script.push_str("@echo off\r\n");
    script.push_str("chcp 65001 >nul\r\n");
    script.push_str("echo [scoop] proxy: %SCOOP_PROXY_LABEL%\r\n");
    script.push_str("echo [scoop] SCOOP link        : %SCOOP%\r\n");
    script.push_str("echo [scoop] SCOOP real        : %SCOOP_TARGET%\r\n");
    script.push_str("echo [scoop] SCOOP_GLOBAL link : %SCOOP_GLOBAL%\r\n");
    script.push_str("echo [scoop] SCOOP_GLOBAL real : %SCOOP_GLOBAL_TARGET%\r\n");

    let config = proxy_config_args(proxy);

    if kind == "config" {
        script.push_str("echo [scoop] applying the proxy to Scoop\r\n");
        scoop_call(&mut script, &config);
    } else if kind == "update" {
        // No app argument: Scoop updates itself and every cloned bucket.
        script.push_str("echo [scoop] command: scoop update\r\n");
        scoop_call(&mut script, &config);
        scoop_call(&mut script, "update");
    } else if kind == "apps-update" {
        // `*` is every app in one root, and Scoop skips the held ones itself,
        // which is the whole point of holding: a pinned version stays put.
        script.push_str("echo [scoop] command: scoop update *\r\n");
        scoop_call(&mut script, &config);
        scoop_call(&mut script, "update *");
        if update_globals {
            script.push_str("set \"SCOOP_EXIT=%ERRORLEVEL%\"\r\n");
            script.push_str("if not \"%SCOOP_EXIT%\"==\"0\" goto scoop_run_done\r\n");
            script.push_str("echo [scoop] command: scoop update -g *\r\n");
            scoop_call(&mut script, "update -g *");
        }
    } else if kind == "app-update" {
        script.push_str(
            "echo [scoop] command: scoop update %SCOOP_GLOBAL_FLAG% %SCOOP_APP_ARGS%\r\n",
        );
        scoop_call(&mut script, &config);
        scoop_call(&mut script, "update %SCOOP_GLOBAL_FLAG% %SCOOP_APP_ARGS%");
    } else if kind == "uninstall" {
        // Scoop keeps the app's `persist` folder unless it is given `-p`, which
        // is what a reinstall needs to find the user's settings again.
        script.push_str(
            "echo [scoop] command: scoop uninstall %SCOOP_GLOBAL_FLAG% %SCOOP_PURGE_FLAG% %SCOOP_APP_ARGS%\r\n",
        );
        scoop_call(
            &mut script,
            "uninstall %SCOOP_GLOBAL_FLAG% %SCOOP_PURGE_FLAG% %SCOOP_APP_ARGS%",
        );
    } else {
        let subcommand = if kind == "search" { "search" } else { "install" };
        script.push_str(&format!(
            "echo [scoop] command: scoop {subcommand} %SCOOP_APP_ARGS%\r\n"
        ));
        scoop_call(&mut script, &config);
        scoop_call(&mut script, &format!("{subcommand} %SCOOP_APP_ARGS%"));
    }

    script.push_str(":scoop_run_done\r\n");
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

/// Parses `7zip`, `scoop install 7zip`, `scoop update 7zip` and the same forms
/// for search into the arguments the subcommand takes.
///
/// Only app names are accepted: the result is expanded by `cmd.exe`, so a
/// token containing a shell metacharacter would be a command injection.
fn parse_spec(spec: &str) -> Result<String, String> {
    let mut tokens: Vec<String> = spec.split_whitespace().map(str::to_string).collect();
    if tokens
        .first()
        .map(|token| token.eq_ignore_ascii_case("scoop"))
        .unwrap_or(false)
    {
        tokens.remove(0);
    }
    // The verb is optional and either one: a line typed in a terminal reads as
    // `scoop update 7zip`, a line typed into a box on this page as `7zip`.
    if let Some(first) = tokens.first() {
        if ["install", "search", "update", "uninstall"]
            .iter()
            .any(|verb| first.eq_ignore_ascii_case(verb))
        {
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

/// Parses `<name> <url>`, `bucket add <name> <url>` or a bare repository URL
/// into the name and the git address `scoop bucket add` takes.
///
/// Both values reach the generated script through quoted variables; they are
/// still restricted, because neither a bucket name nor a clone address has any
/// business carrying a shell metacharacter.
fn parse_bucket_spec(spec: &str) -> Result<(String, String), String> {
    let mut tokens: Vec<&str> = spec.split_whitespace().collect();
    for prefix in ["scoop", "bucket", "add"] {
        if tokens
            .first()
            .map(|token| token.eq_ignore_ascii_case(prefix))
            .unwrap_or(false)
        {
            tokens.remove(0);
        }
    }

    let (name, url) = match tokens.as_slice() {
        [url] => (bucket_name_from_url(url)?, (*url).to_string()),
        [name, url] => ((*name).to_string(), (*url).to_string()),
        [] => {
            return Err(
                "Enter a bucket name and its repository, for example extras https://github.com/ScoopInstaller/Extras."
                    .to_string(),
            )
        }
        _ => {
            return Err(
                "Enter one bucket at a time: a name and its repository, for example extras https://github.com/ScoopInstaller/Extras."
                    .to_string(),
            )
        }
    };

    if !is_bucket_name(&name) {
        return Err(format!(
            "'{name}' is not a bucket name. Use letters, digits, dots, dashes and underscores, as in extras."
        ));
    }
    if !is_bucket_url(&url) {
        return Err(format!(
            "'{url}' is not a repository address. Use a git URL, for example https://github.com/ScoopInstaller/Extras."
        ));
    }

    Ok((name.to_ascii_lowercase(), url))
}

/// Parses `<name>`, `bucket rm <name>` or `scoop bucket rm <name>` into the
/// bucket name `scoop bucket rm` takes. One bucket per run, since the command
/// takes one name.
fn parse_bucket_name(spec: &str) -> Result<String, String> {
    let mut tokens: Vec<&str> = spec.split_whitespace().collect();
    for prefix in ["scoop", "bucket"] {
        if tokens
            .first()
            .map(|token| token.eq_ignore_ascii_case(prefix))
            .unwrap_or(false)
        {
            tokens.remove(0);
        }
    }
    if tokens
        .first()
        .map(|token| token.eq_ignore_ascii_case("rm") || token.eq_ignore_ascii_case("remove"))
        .unwrap_or(false)
    {
        tokens.remove(0);
    }

    let name = match tokens.as_slice() {
        [name] => *name,
        [] => return Err("Enter the name of the bucket to remove, for example extras.".to_string()),
        _ => return Err("Enter one bucket at a time, for example extras.".to_string()),
    };
    if !is_bucket_name(name) {
        return Err(format!(
            "'{name}' is not a bucket name. Use letters, digits, dots, dashes and underscores, as in extras."
        ));
    }
    Ok(name.to_string())
}

/// The repository name of a clone URL, lowercased the way Scoop names buckets.
fn bucket_name_from_url(url: &str) -> Result<String, String> {
    let repo = url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim_end_matches(".git");
    if !is_bucket_name(repo) {
        return Err(format!(
            "Cannot read a bucket name from '{url}'. Enter the name first, as in extras {url}."
        ));
    }
    Ok(repo.to_ascii_lowercase())
}

fn is_bucket_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// An http(s) address with a host, restricted to the characters a git URL uses.
fn is_bucket_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let host = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .and_then(|rest| rest.split('/').next());
    let host_ok = host
        .map(|host| (host.contains('.') || host == "localhost") && !host.starts_with('.'))
        .unwrap_or(false);

    host_ok
        && url.len() <= 200
        && url
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".:/_-~".contains(c))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopBucketRequest {
    /// `<name> <url>` or a bare repository URL, as the bucket form accepts it.
    pub spec: String,
    #[serde(default = "default_proxy_mode")]
    pub proxy_mode: String,
    #[serde(default)]
    pub proxy_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopBucketResult {
    pub name: String,
    pub path: String,
    pub log: Vec<String>,
}

/// `<root>\buckets`, the only place Scoop looks for a bucket.
fn buckets_dir(applied: &AppliedLocation) -> PathBuf {
    applied.scoop.target.join("buckets")
}

/// Compares repository addresses the way a person would: the scheme, a trailing
/// slash and a trailing `.git` do not make it a different repository.
fn same_repository(left: &str, right: &str) -> bool {
    fn normalize(url: &str) -> String {
        let url = url.trim().trim_end_matches('/');
        let url = url.strip_suffix(".git").unwrap_or(url);
        let url = url
            .strip_prefix("https://")
            .or_else(|| url.strip_prefix("http://"))
            .unwrap_or(url);
        url.trim_end_matches('/').to_ascii_lowercase()
    }
    normalize(left) == normalize(right)
}

/// The bucket already holding `url`, if any. Scoop refuses a second clone of
/// the same repository, so a copy added under another name must not happen.
fn bucket_with_remote(dir: &Path, url: &str) -> Option<String> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if let Some(remote) = git_core::remote::origin_url(&path.to_string_lossy()) {
            if same_repository(&remote, url) {
                return Some(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    None
}

/// The proxy libgit2 should use. `None` leaves it to git's own configuration,
/// which is the right answer when the page asks for a direct connection.
fn clone_proxy(proxy: &EffectiveProxy) -> Option<String> {
    match proxy.mode {
        EffectiveMode::None => None,
        // libgit2 wants a full URL, and the Windows system setting is a bare
        // `host:port`; a page or settings override already has a scheme.
        EffectiveMode::System | EffectiveMode::Custom => {
            proxy.url.as_deref().and_then(normalize_proxy_url)
        }
    }
}

/// Clones `url` into `<buckets>\<name>` and returns the folder it landed in.
fn clone_bucket(
    app: &AppHandle,
    dir: &Path,
    name: &str,
    url: &str,
    proxy: Option<String>,
) -> Result<PathBuf, String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;
    let path = dir.join(name);
    if path.exists() {
        return Err(format!(
            "The '{name}' bucket already exists. Remove it first, or pick another name."
        ));
    }
    if let Some(other) = bucket_with_remote(dir, url) {
        return Err(format!("{url} is already cloned as the '{other}' bucket."));
    }

    let emitter = app.clone();
    let target = path.to_string_lossy().to_string();
    match git_core::remote::clone_with_proxy(url, &target, None, proxy.as_deref(), move |pct| {
        let _ = emitter.emit("scoop-bucket-progress", pct);
    }) {
        Ok(_) => Ok(path),
        Err(error) => {
            // Half a clone is worse than none: Scoop would count the folder as
            // a bucket, and its manifests would be missing.
            let _ = fs::remove_dir_all(&path);
            Err(format!("Failed to clone {url}: {error}"))
        }
    }
}

/// `scoop bucket add`, without Scoop. A bucket is a git clone under
/// `<root>\buckets\<name>` — that folder *is* the registration — so cloning it
/// here keeps the call inside the app: no PowerShell, no `git.exe`, and the
/// page's proxy is actually used, which libgit2 will not pick up on its own.
#[tauri::command(async)]
pub fn scoop_add_bucket(
    app: AppHandle,
    request: ScoopBucketRequest,
) -> Result<ScoopBucketResult, String> {
    let applied = current_location()?;
    let (name, url) = parse_bucket_spec(&request.spec)?;
    let proxy = effective_proxy(&request.proxy_mode, request.proxy_url.as_deref());
    let path = clone_bucket(&app, &buckets_dir(&applied), &name, &url, clone_proxy(&proxy))?;

    Ok(ScoopBucketResult {
        log: vec![
            format!("Scoop command: scoop bucket add {name} {url} (cloned by the app)"),
            format!("Proxy: {}", proxy.label()),
            format!("Bucket folder: {}", path.display()),
        ],
        name,
        path: path.display().to_string(),
    })
}

/// `scoop bucket rm`, without Scoop: the clone goes, and the apps installed
/// from it stay where they are.
#[tauri::command(async)]
pub fn scoop_remove_bucket(spec: String) -> Result<ScoopBucketResult, String> {
    let applied = current_location()?;
    let name = parse_bucket_name(&spec)?;
    let dir = buckets_dir(&applied);
    let path = dir.join(&name);
    // The name is already limited to letters, digits, dots, dashes and
    // underscores; this is the second lock on a recursive delete.
    if !is_inside(&path, &dir) {
        return Err(format!("'{name}' is not inside {}", dir.display()));
    }
    if !path.is_dir() {
        return Err(format!("The '{name}' bucket is not installed."));
    }
    fs::remove_dir_all(&path)
        .map_err(|error| format!("Failed to delete {}: {error}", path.display()))?;

    let log = vec![
        format!("Scoop command: scoop bucket rm {name} (deleted by the app)"),
        format!("Removed: {}", path.display()),
        "Apps installed from this bucket stay installed.".to_string(),
    ];
    Ok(ScoopBucketResult {
        name,
        path: path.display().to_string(),
        log,
    })
}

// ---------------------------------------------------------------------------
// Details
//
// Every row of the page can be opened: a package shows what its manifest says,
// a bucket shows where its clone came from and what it holds. Both read from
// disk, so nothing here runs Scoop or touches the network.

/// One package, as its manifest describes it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopPackageInfoView {
    pub name: String,
    /// The bucket the details were read from.
    pub bucket: Option<String>,
    pub installed: bool,
    pub global: bool,
    /// The manifest's own version: what an install would fetch.
    pub version: Option<String>,
    /// What is on disk, which a held app keeps behind `version`.
    pub installed_version: Option<String>,
    pub description: Option<String>,
    pub homepage: Option<String>,
    pub license: Option<String>,
    pub license_url: Option<String>,
    pub notes: Option<String>,
    pub depends: Vec<String>,
    pub suggests: Vec<String>,
    /// The commands the manifest puts on `PATH`, aliases included.
    pub bins: Vec<String>,
    pub manifest_path: String,
    /// The manifest exactly as it is on disk.
    pub manifest: String,
}

/// One bucket: the repository its clone came from, and what is in it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoopBucketInfoView {
    pub name: String,
    pub path: String,
    /// Manifest names, sorted: the bucket's catalog.
    pub packages: Vec<String>,
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub commit: Option<String>,
    /// Last commit time, in seconds since the Unix epoch.
    pub committed_at: Option<i64>,
    pub subject: Option<String>,
}

/// A manifest read from disk, with the text it was parsed from.
#[derive(Clone)]
struct ManifestSource {
    path: PathBuf,
    text: String,
    value: serde_json::Value,
    bucket: Option<String>,
}

/// A single manifest name: the character set an app spec allows, without the
/// separators that would make it a bucket-qualified spec.
fn is_package_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-_+@".contains(c))
}

/// A manifest field that may be written as one string or as a list of them.
fn string_list(manifest: &serde_json::Value, key: &str) -> Vec<String> {
    match manifest.get(key) {
        Some(serde_json::Value::String(text)) => vec![text.clone()],
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

/// `notes` is shown as it would be printed, one entry per line.
fn notes_field(manifest: &serde_json::Value) -> Option<String> {
    let lines = string_list(manifest, "notes");
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

/// `license` is either an identifier or `{ identifier, url }`.
fn license_fields(manifest: &serde_json::Value) -> (Option<String>, Option<String>) {
    match manifest.get("license") {
        Some(serde_json::Value::String(identifier)) => (Some(identifier.clone()), None),
        Some(value) => (
            value.get("identifier").and_then(|text| text.as_str()).map(str::to_string),
            value.get("url").and_then(|text| text.as_str()).map(str::to_string),
        ),
        None => (None, None),
    }
}

/// The commands a manifest exposes. `bin` is a string, a list of strings, a
/// list of `[path, alias]` pairs, or a list of `{ path: alias }` objects.
fn bin_names(manifest: &serde_json::Value) -> Vec<String> {
    match manifest.get("bin") {
        Some(serde_json::Value::String(name)) => vec![name.clone()],
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                serde_json::Value::String(name) => Some(name.clone()),
                serde_json::Value::Array(pair) => pair
                    .get(1)
                    .or_else(|| pair.first())
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                serde_json::Value::Object(alias) => match alias.iter().next() {
                    // `{ "path\\to.exe": "command" }`: the command is what a
                    // person types, so it is the alias and not the path.
                    Some((path, command)) => Some(command.as_str().unwrap_or(path).to_string()),
                    None => None,
                },
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `<root>\buckets\<bucket>\bucket\<name>.json`, when that manifest is there.
fn bucket_manifest(root: &Path, bucket: &str, name: &str) -> Option<PathBuf> {
    let path = root
        .join("buckets")
        .join(bucket)
        .join("bucket")
        .join(format!("{name}.json"));
    path.is_file().then_some(path)
}

/// The manifest a cloned bucket holds for `name`, and which bucket that was.
///
/// The named bucket is tried first, then the buckets on disk in turn: a row
/// can carry a bucket that is gone, and the manifest is often still there.
fn find_bucket_manifest(
    root: &Path,
    name: &str,
    bucket: Option<&str>,
) -> Option<(PathBuf, String)> {
    if let Some(bucket) = bucket {
        if let Some(path) = bucket_manifest(root, bucket, name) {
            return Some((path, bucket.to_string()));
        }
    }

    let entries = fs::read_dir(root.join("buckets")).ok()?;
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let candidate = entry.file_name().to_string_lossy().to_string();
        if let Some(path) = bucket_manifest(root, &candidate, name) {
            return Some((path, candidate));
        }
    }
    None
}

/// `apps\<name>\current\scoop-manifest.json`, the manifest Scoop installed from.
fn installed_manifest(root: &Path, name: &str) -> Option<PathBuf> {
    let current = root.join("apps").join(name).join("current");
    [APP_MANIFEST_FILE, LEGACY_MANIFEST_FILE]
        .iter()
        .map(|file| current.join(file))
        .find(|path| path.is_file())
}

fn manifest_source(path: &Path, bucket: Option<String>) -> Option<ManifestSource> {
    // Manifests are written by other tools and may carry a BOM, which
    // `serde_json` refuses.
    let text = fs::read_to_string(path)
        .ok()?
        .trim_start_matches('\u{feff}')
        .to_string();
    let value = serde_json::from_str(&text).ok()?;
    Some(ManifestSource {
        path: path.to_path_buf(),
        text,
        value,
        bucket,
    })
}

/// Everything the manifest of one package says, plus what is installed.
#[tauri::command(async)]
pub fn scoop_package_info(
    name: String,
    bucket: Option<String>,
    global: bool,
) -> Result<ScoopPackageInfoView, String> {
    let name = name.trim().to_string();
    if !is_package_name(&name) {
        return Err(format!("'{name}' is not an app name."));
    }

    let scoop = root_view(PathKind::Scoop);
    let global_root = root_view(PathKind::Global);
    let install_root = if global {
        &global_root.target
    } else {
        &scoop.target
    };

    let installed = installed_manifest(install_root, &name)
        .and_then(|path| manifest_source(&path, None));
    // The bucket's manifest wins: it is the version an install would fetch,
    // while the installed one only says what is on disk today.
    let source = find_bucket_manifest(&scoop.target, &name, bucket.as_deref())
        .and_then(|(path, bucket)| manifest_source(&path, Some(bucket)))
        .or_else(|| installed.clone())
        .ok_or_else(|| {
            format!("No cloned bucket holds a manifest for '{name}'. Update the buckets first.")
        })?;

    let installed_bucket = || {
        let current = install_root.join("apps").join(&name).join("current");
        let install = read_app_json(&current, APP_INSTALL_FILE, LEGACY_INSTALL_FILE);
        text_field(&install, "bucket")
    };
    let (license, license_url) = license_fields(&source.value);

    Ok(ScoopPackageInfoView {
        bucket: source
            .bucket
            .clone()
            .or_else(installed_bucket)
            .or(bucket)
            .filter(|bucket| !bucket.is_empty()),
        installed: installed.is_some(),
        installed_version: installed
            .as_ref()
            .and_then(|installed| text_of(&installed.value, "version")),
        version: text_of(&source.value, "version"),
        description: text_of(&source.value, "description"),
        homepage: text_of(&source.value, "homepage"),
        notes: notes_field(&source.value),
        depends: string_list(&source.value, "depends"),
        suggests: string_list(&source.value, "suggests"),
        bins: bin_names(&source.value),
        manifest_path: source.path.display().to_string(),
        manifest: source.text,
        name,
        global,
        license,
        license_url,
    })
}

/// One bucket: its clone's git metadata and the manifests it holds.
#[tauri::command(async)]
pub fn scoop_bucket_info(name: String) -> Result<ScoopBucketInfoView, String> {
    let applied = current_location()?;
    let name = parse_bucket_name(&name)?;
    let dir = buckets_dir(&applied);
    let path = dir.join(&name);
    if !is_inside(&path, &dir) || !path.is_dir() {
        return Err(format!("The '{name}' bucket is not installed."));
    }

    let mut packages: Vec<String> = fs::read_dir(path.join("bucket"))
        .map(|files| {
            files
                .flatten()
                .filter(|file| is_json_file(&file.path()))
                .filter_map(|file| {
                    file.path()
                        .file_stem()
                        .map(|stem| stem.to_string_lossy().to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    packages.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));

    // A bucket is a clone, so where it came from and how old it is are git's
    // to answer; a folder that is not a repository simply has none of it.
    let summary = git_core::remote::summarize(&path.to_string_lossy()).unwrap_or_default();

    Ok(ScoopBucketInfoView {
        name,
        path: path.display().to_string(),
        packages,
        remote: summary.remote,
        branch: summary.branch,
        commit: summary.commit,
        committed_at: summary.committed_at,
        subject: summary.subject,
    })
}

#[tauri::command(async)]
pub fn scoop_apply_location(request: ScoopLocationRequest) -> Result<ScoopStatusView, String> {
    apply_location(&request.scoop, &request.scoop_global)?;
    Ok(status())
}

#[tauri::command(async)]
pub fn scoop_prepare_install(request: ScoopInstallRequest) -> Result<ScoopPlanView, String> {
    let mut applied = apply_location(&request.scoop, &request.scoop_global)?;
    let proxy = effective_proxy(&request.proxy_mode, request.proxy_url.as_deref());

    let script = install_script_text(&proxy, request.run_as_admin);
    let env = environment(&applied, &proxy)?;
    let mut log = std::mem::take(&mut applied.log);
    log.push(format!("Installer: {}", install_script_path().display()));
    log.push(format!(
        "Installer runs as: {}",
        if request.run_as_admin {
            "administrator (-RunAsAdmin)"
        } else {
            "the current user"
        }
    ));
    log.extend(proxy_warnings(&proxy));

    // Refresh the bundled copy every time: a newer app build carries a newer
    // installer, and a stale copy would silently keep installing the old one.
    fs::create_dir_all(work_dir())
        .map_err(|error| format!("Failed to create {}: {error}", work_dir().display()))?;
    fs::write(install_script_path(), INSTALL_SCRIPT)
        .map_err(|error| format!("Failed to write {}: {error}", install_script_path().display()))?;

    plan_view(&applied, &proxy, INSTALL_CMD_NAME, script, env, log)
}

#[tauri::command(async)]
pub fn scoop_plan_run(request: ScoopRunRequest) -> Result<ScoopPlanView, String> {
    let applied = current_location()?;
    let proxy = effective_proxy(&request.proxy_mode, request.proxy_url.as_deref());

    let mut env = environment(&applied, &proxy)?;
    let folder_line = format!("Folder: {}", applied.scoop.target.display());
    let global_flag = if request.global { "-g" } else { "" };
    let update_globals = request.kind == "apps-update" && has_global_apps(&applied);
    let mut log = if request.kind == "config" {
        vec![
            "Scoop command: scoop config (proxy only)".to_string(),
            folder_line,
        ]
    } else if request.kind == "update" {
        vec![
            "Scoop command: scoop update (Scoop itself and every bucket)".to_string(),
            folder_line,
        ]
    } else if request.kind == "apps-update" {
        let mut lines = vec![
            "Scoop command: scoop update * (held apps are skipped)".to_string(),
            folder_line,
        ];
        if update_globals {
            lines.push("Global apps follow with scoop update -g *.".to_string());
        }
        lines
    } else if request.kind == "app-update" {
        let args = parse_spec(&request.spec)?;
        env.push(ScoopEnvVar {
            name: "SCOOP_APP_ARGS".to_string(),
            value: args.clone(),
        });
        env.push(ScoopEnvVar {
            name: "SCOOP_GLOBAL_FLAG".to_string(),
            value: global_flag.to_string(),
        });
        vec![
            format!("Scoop command: scoop update {global_flag} {args}"),
            folder_line,
        ]
    } else if request.kind == "uninstall" {
        let args = parse_spec(&request.spec)?;
        check_uninstall_targets(&args)?;
        let purge_flag = if request.purge { "-p" } else { "" };
        env.push(ScoopEnvVar {
            name: "SCOOP_APP_ARGS".to_string(),
            value: args.clone(),
        });
        env.push(ScoopEnvVar {
            name: "SCOOP_GLOBAL_FLAG".to_string(),
            value: global_flag.to_string(),
        });
        env.push(ScoopEnvVar {
            name: "SCOOP_PURGE_FLAG".to_string(),
            value: purge_flag.to_string(),
        });
        let persist = if request.purge {
            "The app's persist folder is deleted too."
        } else {
            "The app's persist folder is kept for a later reinstall."
        };
        vec![
            format!("Scoop command: scoop uninstall {global_flag} {purge_flag} {args}"),
            folder_line,
            persist.to_string(),
        ]
    } else {
        let args = parse_spec(&request.spec)?;
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
    let script = run_script_text(&request.kind, &proxy, update_globals);
    plan_view(&applied, &proxy, RUN_CMD_NAME, script, env, log)
}

/// Whether the global root holds any app. Only `scoop update -g <app>` can
/// refresh those, and it needs an elevated window, so a run that updates
/// everything adds it only when there is something for it to do.
fn has_global_apps(applied: &AppliedLocation) -> bool {
    !same_path(&applied.scoop.target, &applied.global.target)
        && !read_apps(&applied.global.target, true).is_empty()
}

/// `scoop uninstall scoop` removes Scoop and every app it installed, so this
/// page refuses it rather than letting one click wipe the whole installation.
fn check_uninstall_targets(args: &str) -> Result<(), String> {
    if args
        .split_whitespace()
        .any(|token| token.eq_ignore_ascii_case("scoop"))
    {
        return Err("Scoop itself cannot be uninstalled from this page.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        bin_names, check_uninstall_targets, clone_proxy, flag_field, install_script_text,
        is_inside, is_package_name, license_fields, notes_field, parse_bucket_name,
        parse_bucket_spec, parse_spec, parse_version, read_app_json, read_json, run_script_text,
        same_path, same_repository, set_app_hold, string_list, strip_verbatim, text_of,
        EffectiveMode, EffectiveProxy, PathKind, APP_INSTALL_FILE, APP_MANIFEST_FILE,
        LEGACY_INSTALL_FILE, LEGACY_MANIFEST_FILE,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    #[test]
    fn a_pin_is_written_into_the_install_record() {
        let root =
            std::env::temp_dir().join(format!("wingharness-pin-write-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let current = root.join("apps/demo/current");
        fs::create_dir_all(&current).unwrap();
        let info = current.join(APP_INSTALL_FILE);
        fs::write(&info, r#"{"bucket":"main","architecture":"64bit"}"#).unwrap();

        set_app_hold(&root, "demo", true).unwrap();
        let value = read_json(&info).unwrap();
        assert_eq!(value.get("hold"), Some(&serde_json::json!(true)));
        // Everything Scoop wrote is still there: this rewrites one key, not the
        // whole record.
        assert_eq!(text_of(&value, "bucket").as_deref(), Some("main"));
        assert_eq!(text_of(&value, "architecture").as_deref(), Some("64bit"));

        set_app_hold(&root, "demo", false).unwrap();
        let value = read_json(&info).unwrap();
        assert!(value.get("hold").is_none());
        assert_eq!(text_of(&value, "bucket").as_deref(), Some("main"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_legacy_record_is_pinned_too() {
        let root =
            std::env::temp_dir().join(format!("wingharness-pin-legacy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let current = root.join("apps/demo/current");
        fs::create_dir_all(&current).unwrap();
        let info = current.join(LEGACY_INSTALL_FILE);
        // The BOM an older Scoop wrote, which is why the read strips it.
        fs::write(&info, "\u{feff}{\"bucket\":\"main\"}").unwrap();

        set_app_hold(&root, "demo", true).unwrap();
        assert_eq!(
            read_json(&info).and_then(|value| value.get("hold").cloned()),
            Some(serde_json::json!(true))
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn only_an_installed_app_can_be_pinned() {
        let root =
            std::env::temp_dir().join(format!("wingharness-pin-missing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        // No `apps` folder at all.
        assert!(set_app_hold(&root, "demo", true).is_err());
        // A name that could walk out of `apps` never reaches the file system.
        assert!(set_app_hold(&root, "../demo", true).is_err());

        // The folder is there but carries no record.
        fs::create_dir_all(root.join("apps/demo/current")).unwrap();
        assert!(set_app_hold(&root, "demo", true).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn app_metadata_is_read_under_either_name() {
        let root = std::env::temp_dir().join(format!("wingharness-app-json-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        let write = |dir: &str, file: &str, text: &str| {
            let path = root.join(dir);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join(file), text).unwrap();
            path
        };

        // An install made by a current Scoop: both qualified names.
        let current = write(
            "current",
            APP_MANIFEST_FILE,
            r#"{"version":"1.2.3"}"#,
        );
        write("current", APP_INSTALL_FILE, r#"{"bucket":"main"}"#);
        assert_eq!(
            read_app_json(&current, APP_MANIFEST_FILE, LEGACY_MANIFEST_FILE)
                .and_then(|value| value.get("version").cloned()),
            Some(serde_json::json!("1.2.3"))
        );
        assert_eq!(
            read_app_json(&current, APP_INSTALL_FILE, LEGACY_INSTALL_FILE)
                .and_then(|value| value.get("bucket").cloned()),
            Some(serde_json::json!("main"))
        );

        // An install made by an older Scoop: only the bare names, which is the
        // case the fallback exists for.
        let legacy = write("legacy", LEGACY_MANIFEST_FILE, r#"{"version":"0.1.0"}"#);
        write("legacy", LEGACY_INSTALL_FILE, r#"{"bucket":"extras"}"#);
        assert_eq!(
            read_app_json(&legacy, APP_MANIFEST_FILE, LEGACY_MANIFEST_FILE)
                .and_then(|value| value.get("version").cloned()),
            Some(serde_json::json!("0.1.0"))
        );
        assert_eq!(
            read_app_json(&legacy, APP_INSTALL_FILE, LEGACY_INSTALL_FILE)
                .and_then(|value| value.get("bucket").cloned()),
            Some(serde_json::json!("extras"))
        );

        // Both present: the qualified name is Scoop's own record and wins.
        let both = write("both", APP_MANIFEST_FILE, r#"{"version":"2.0.0"}"#);
        write("both", LEGACY_MANIFEST_FILE, r#"{"version":"1.0.0"}"#);
        assert_eq!(
            read_app_json(&both, APP_MANIFEST_FILE, LEGACY_MANIFEST_FILE)
                .and_then(|value| value.get("version").cloned()),
            Some(serde_json::json!("2.0.0"))
        );

        // Nothing there: no metadata, not a crash.
        let empty = write("empty", "unrelated.txt", "");
        assert!(read_app_json(&empty, APP_MANIFEST_FILE, LEGACY_MANIFEST_FILE).is_none());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn versions_are_read_from_the_reported_line() {
        let text = "Current Scoop version:\nv0.5.2 - Released at 2024-06-01\n";
        assert_eq!(parse_version(text).as_deref(), Some("v0.5.2"));
        assert_eq!(parse_version("nothing here").as_deref(), None);
    }

    #[test]
    fn the_installer_runs_elevated_only_when_asked() {
        let proxy = EffectiveProxy {
            mode: EffectiveMode::System,
            url: None,
            source: "settings",
        };
        assert!(!install_script_text(&proxy, false).contains("-RunAsAdmin"));
        assert!(install_script_text(&proxy, true).contains("-RunAsAdmin"));
    }

    #[test]
    fn scoop_runs_through_the_pinned_wrapper() {
        let proxy = EffectiveProxy {
            mode: EffectiveMode::System,
            url: None,
            source: "settings",
        };
        for text in [
            install_script_text(&proxy, false),
            run_script_text("config", &proxy, false),
            run_script_text("install", &proxy, false),
            run_script_text("update", &proxy, false),
            run_script_text("apps-update", &proxy, true),
            run_script_text("app-update", &proxy, false),
            run_script_text("uninstall", &proxy, false),
            run_script_text("search", &proxy, false),
        ] {
            // The `.cmd` shim picks its host with `where /q pwsh.exe`, so it is
            // never the way in: the wrapper pins Windows PowerShell and returns
            // the real exit code.
            assert!(!text.contains("scoop.cmd"));
            assert!(text.contains("-File \"%SCOOP_WRAPPER%\""));
            // It is run by `cmd.exe`, so it must survive a non-ASCII code page.
            assert!(text.is_ascii(), "not ASCII: {text}");
        }
    }

    #[test]
    fn the_proxy_redirect_stays_at_the_end_of_its_line() {
        let system = EffectiveProxy {
            mode: EffectiveMode::System,
            url: None,
            source: "settings",
        };
        let script = run_script_text("config", &system, false);
        let line = script
            .lines()
            .find(|line| line.contains("config rm proxy"))
            .expect("the removal line is missing");
        // Anything after the redirect would become its target.
        assert!(line.ends_with(">nul 2>&1"), "{line}");
    }

    #[test]
    fn specs_accept_the_documented_forms() {
        assert_eq!(parse_spec("7zip").unwrap(), "7zip");
        assert_eq!(parse_spec("scoop install 7zip").unwrap(), "7zip");
        assert_eq!(
            parse_spec("Scoop INSTALL extras/vscode git").unwrap(),
            "extras/vscode git"
        );
        assert_eq!(parse_spec("scoop search 7z").unwrap(), "7z");
        assert_eq!(parse_spec("scoop update 7zip").unwrap(), "7zip");
        assert_eq!(parse_spec("scoop uninstall 7zip").unwrap(), "7zip");
    }

    #[test]
    fn specs_reject_shell_metacharacters() {
        assert!(parse_spec("7zip & del x").is_err());
        assert!(parse_spec("").is_err());
        assert!(parse_spec("-g").is_err());
    }

    #[test]
    fn bucket_names_are_parsed_for_removal() {
        assert_eq!(parse_bucket_name("extras").unwrap(), "extras");
        assert_eq!(parse_bucket_name("scoop bucket rm extras").unwrap(), "extras");
        assert_eq!(parse_bucket_name("bucket remove extras").unwrap(), "extras");
        assert!(parse_bucket_name("").is_err());
        assert!(parse_bucket_name("extras git@github.com:a/b").is_err());
        // A name that could be read as a flag, or carry a metacharacter, would
        // reach `cmd.exe` through a quoted variable.
        assert!(parse_bucket_name("-rf").is_err());
        assert!(parse_bucket_name("extras & del x").is_err());
    }

    #[test]
    fn uninstalling_scoop_itself_is_refused() {
        assert!(check_uninstall_targets("7zip extras/vscode").is_ok());
        assert!(check_uninstall_targets("scoop").is_err());
        // The whole list is checked, not just the first name.
        assert!(check_uninstall_targets("7zip Scoop").is_err());
    }

    #[test]
    fn a_hold_flag_is_read_as_a_boolean() {
        assert!(flag_field(
            &Some(serde_json::json!({ "bucket": "main", "hold": true })),
            "hold"
        ));
        // `scoop unhold` saves the key as null rather than dropping it.
        assert!(!flag_field(
            &Some(serde_json::json!({ "bucket": "main", "hold": null })),
            "hold"
        ));
        assert!(!flag_field(&Some(serde_json::json!({ "bucket": "main" })), "hold"));
        assert!(!flag_field(&None, "hold"));
    }

    #[test]
    fn bucket_specs_accept_the_documented_forms() {
        let expected = (
            "extras".to_string(),
            "https://github.com/ScoopInstaller/Extras".to_string(),
        );
        assert_eq!(
            parse_bucket_spec("extras https://github.com/ScoopInstaller/Extras").unwrap(),
            expected
        );
        assert_eq!(
            parse_bucket_spec("scoop bucket add extras https://github.com/ScoopInstaller/Extras")
                .unwrap(),
            expected
        );
        assert_eq!(
            parse_bucket_spec("https://github.com/ScoopInstaller/Extras").unwrap(),
            expected
        );
        assert_eq!(
            parse_bucket_spec("https://github.com/ScoopInstaller/Extras.git/").unwrap(),
            (
                "extras".to_string(),
                "https://github.com/ScoopInstaller/Extras.git/".to_string()
            )
        );
        assert_eq!(
            parse_bucket_spec("Extras https://gitlab.com/someone/Extras").unwrap(),
            (
                "extras".to_string(),
                "https://gitlab.com/someone/Extras".to_string()
            )
        );
    }

    #[test]
    fn bucket_specs_reject_shell_metacharacters() {
        assert!(parse_bucket_spec("extras & del x").is_err());
        assert!(parse_bucket_spec("ex\"tras https://github.com/a/b").is_err());
        assert!(parse_bucket_spec("extras ftp://example.com/x").is_err());
        assert!(parse_bucket_spec("extras https://github.com/a/b & del x").is_err());
        assert!(parse_bucket_spec("").is_err());
        assert!(parse_bucket_spec("a b c").is_err());
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

    #[test]
    fn repository_addresses_compare_the_way_a_person_would() {
        // The same repository, written the three ways a bucket URL arrives.
        assert!(same_repository(
            "https://github.com/ScoopInstaller/Extras",
            "https://github.com/ScoopInstaller/Extras.git"
        ));
        assert!(same_repository(
            "https://GitHub.com/ScoopInstaller/Extras/",
            "https://github.com/scoopinstaller/extras"
        ));
        assert!(!same_repository(
            "https://github.com/ScoopInstaller/Extras",
            "https://github.com/ScoopInstaller/Main"
        ));
    }

    #[test]
    fn a_clone_proxy_is_always_a_full_url() {
        let custom = EffectiveProxy {
            mode: EffectiveMode::Custom,
            url: Some("socks5://127.0.0.1:7891".to_string()),
            source: "page",
        };
        assert_eq!(clone_proxy(&custom).as_deref(), Some("socks5://127.0.0.1:7891"));

        // The Windows setting is a bare `host:port`; libgit2 wants a scheme.
        let system = EffectiveProxy {
            mode: EffectiveMode::System,
            url: Some("127.0.0.1:7890".to_string()),
            source: "settings",
        };
        assert_eq!(clone_proxy(&system).as_deref(), Some("http://127.0.0.1:7890"));

        let none = EffectiveProxy {
            mode: EffectiveMode::None,
            url: None,
            source: "page",
        };
        assert_eq!(clone_proxy(&none), None);
    }

    #[test]
    fn a_manifest_may_write_a_list_as_one_value() {
        let manifest = serde_json::json!({
            "depends": ["7zip", "git"],
            "suggests": "vcredist",
            "notes": ["First line.", "Second line."],
        });
        assert_eq!(string_list(&manifest, "depends"), vec!["7zip", "git"]);
        assert_eq!(string_list(&manifest, "suggests"), vec!["vcredist"]);
        assert_eq!(
            notes_field(&manifest).as_deref(),
            Some("First line.\nSecond line.")
        );
        assert_eq!(notes_field(&serde_json::json!({})), None);
    }

    #[test]
    fn a_license_is_read_in_either_shape() {
        let bare = serde_json::json!({ "license": "MIT" });
        assert_eq!(license_fields(&bare), (Some("MIT".to_string()), None));

        let full = serde_json::json!({
            "license": { "identifier": "Freeware", "url": "https://example.invalid/licence" },
        });
        assert_eq!(
            license_fields(&full),
            (
                Some("Freeware".to_string()),
                Some("https://example.invalid/licence".to_string())
            )
        );

        assert_eq!(license_fields(&serde_json::json!({})), (None, None));
    }

    #[test]
    fn bin_entries_are_read_in_every_shape() {
        // A bare path, a `[path, alias]` pair, and a `{ path: alias }` object.
        let manifest = serde_json::json!({
            "bin": ["foo.exe", ["bar.exe", "baz"], { "qux.exe": "quux" }],
        });
        assert_eq!(bin_names(&manifest), vec!["foo.exe", "baz", "quux"]);
        assert!(bin_names(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn only_a_plain_name_reaches_the_manifest_reader() {
        assert!(is_package_name("7zip"));
        assert!(is_package_name("notepadplusplus"));
        assert!(is_package_name("python312"));
        assert!(!is_package_name(""));
        assert!(!is_package_name("extras/7zip"));
        assert!(!is_package_name("-rf"));
        assert!(!is_package_name("7zip & del x"));
    }
}
