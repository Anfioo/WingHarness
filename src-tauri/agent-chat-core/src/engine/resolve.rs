//! CLI location and spawnable-command construction.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/desktop-cc-gui.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! Discovery uses only `std::env::split_paths` and `PATHEXT`: the GUI process
//! often inherits a stale PATH snapshot, so npm's global prefix and the
//! well-known install directories are probed too. `spawn_plan` is the same
//! decision as `src-tauri/src/proc.rs` and is duplicated here because the
//! crate cannot depend on the application crate.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// `npm config get prefix` is a blocking spawn; cache it like the upstream.
const NPM_CACHE_TTL: Duration = Duration::from_secs(30);
const NPM_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const NPM_PREFIX_MAX_BYTES: u64 = 16 * 1024;

#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

/// Locate the CLI binary named `name` on PATH, PATHEXT and npm's global bin.
pub fn find_cli_binary(name: &str) -> Option<PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    // The Qoder CLI installs as `qodercli`, while the engine id is `qoder`.
    let name = if name == "qoder" { "qodercli" } else { name };

    if name.contains(['\\', '/']) || Path::new(name).extension().is_some() {
        let path = PathBuf::from(name);
        return path.is_file().then_some(path);
    }

    let dirs = search_dirs();
    find_in_dirs(name, &dirs)
}

/// Resolve a CLI name or path to something `Command::new` can launch. A bare
/// name that cannot be found passes through untouched, so the spawn error
/// names the command the user configured.
pub fn resolve_launchable_cli_binary(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path = Path::new(trimmed);
    if path.is_file() {
        return trimmed.to_string();
    }
    if path.is_absolute() || trimmed.contains(['\\', '/']) {
        return trimmed.to_string();
    }
    find_cli_binary(trimmed)
        .map(|found| found.to_string_lossy().into_owned())
        .unwrap_or_else(|| trimmed.to_string())
}

/// How to launch a configured `command` on this platform.
///
/// `program` is what goes to `Command::new`; `prefix` is inserted before the
/// caller's args (e.g. `cmd /C` for a batch shim).
pub struct SpawnPlan {
    pub program: String,
    pub prefix: Vec<String>,
}

/// Decide how to launch `command`.
///
/// `CreateProcess` only appends `.exe` when resolving a bare name against
/// PATH, so npm-installed `.cmd` shims have to go through `cmd.exe /C`.
pub fn spawn_plan(command: &str) -> SpawnPlan {
    #[cfg(not(target_os = "windows"))]
    {
        SpawnPlan {
            program: command.to_string(),
            prefix: Vec::new(),
        }
    }

    #[cfg(target_os = "windows")]
    {
        let as_cmd = |program: &str| SpawnPlan {
            program: "cmd".to_string(),
            prefix: vec!["/C".to_string(), program.to_string()],
        };

        if command.contains(['\\', '/']) || Path::new(command).extension().is_some() {
            let ext = Path::new(command)
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase());
            return match ext.as_deref() {
                Some("cmd") | Some("bat") => as_cmd(&format!("\"{command}\"")),
                _ => SpawnPlan {
                    program: command.to_string(),
                    prefix: Vec::new(),
                },
            };
        }

        let pathext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let exts: Vec<String> = pathext
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(|ext| ext.to_ascii_lowercase())
            .collect();

        let mut shim_found = false;
        if let Ok(path) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path) {
                for ext in &exts {
                    if !dir.join(format!("{command}{ext}")).is_file() {
                        continue;
                    }
                    match ext.as_str() {
                        ".exe" | ".com" => {
                            return SpawnPlan {
                                program: command.to_string(),
                                prefix: Vec::new(),
                            }
                        }
                        ".cmd" | ".bat" => shim_found = true,
                        _ => {}
                    }
                }
            }
        }
        if shim_found {
            return as_cmd(command);
        }

        SpawnPlan {
            program: command.to_string(),
            prefix: Vec::new(),
        }
    }
}

/// Keep a spawned CLI from flashing a console window on Windows. Every spawn
/// goes through this because forgetting the flag is silent until release.
pub(crate) fn apply_no_window(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    command.creation_flags(NO_WINDOW);
    #[cfg(not(windows))]
    let _ = command;
}

/// Kill a process and everything it spawned. npm shims start a `node` child
/// that inherits the pipes, so killing only the shim leaves the reader open.
#[cfg(windows)]
pub(crate) fn kill_process_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(NO_WINDOW)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub(crate) fn kill_process_tree(_pid: u32) -> bool {
    false
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            push_unique(&mut dirs, PathBuf::from(appdata).join("npm"));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            push_unique(&mut dirs, PathBuf::from(program_files).join("nodejs"));
        }
        if let Some(prefix) = npm_global_prefix_dir() {
            push_unique(&mut dirs, prefix);
        }
    }
    dirs
}

#[cfg(windows)]
fn push_unique(dirs: &mut Vec<PathBuf>, dir: PathBuf) {
    if !dirs.iter().any(|existing| {
        existing
            .to_string_lossy()
            .eq_ignore_ascii_case(&dir.to_string_lossy())
    }) {
        dirs.push(dir);
    }
}

#[cfg(not(windows))]
fn push_unique(dirs: &mut Vec<PathBuf>, dir: PathBuf) {
    if !dirs.contains(&dir) {
        dirs.push(dir);
    }
}

fn candidate_is_file(dir: &Path, file_name: &str) -> Option<PathBuf> {
    let candidate = dir.join(file_name);
    candidate.is_file().then_some(candidate)
}

#[cfg(windows)]
fn find_in_dirs(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let mut exts: Vec<String> = vec![
        ".exe".to_string(),
        ".com".to_string(),
        ".cmd".to_string(),
        ".bat".to_string(),
    ];
    for ext in pathext.split(';') {
        let ext = ext.trim();
        if ext.is_empty() {
            continue;
        }
        let ext = ext.to_ascii_lowercase();
        if !exts.contains(&ext) {
            exts.push(ext);
        }
    }
    // Real executables win over batch shims, whichever directory they sit in.
    let groups = [&exts[..2], &exts[2..4], &exts[4..]];
    for group in groups {
        for dir in dirs {
            for ext in group {
                if let Some(found) = candidate_is_file(dir, &format!("{name}{ext}")) {
                    return Some(found);
                }
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn find_in_dirs(name: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().find_map(|dir| candidate_is_file(dir, name))
}

/// npm's global bin directory, cached for 30 s. The probe is only attempted on
/// Windows, where a GUI process commonly misses the npm-managed PATH entry.
#[cfg(windows)]
fn npm_global_prefix_dir() -> Option<PathBuf> {
    static CACHE: Mutex<Option<(Option<PathBuf>, Instant)>> = Mutex::new(None);
    if let Ok(cache) = CACHE.lock() {
        if let Some((value, at)) = cache.as_ref() {
            if at.elapsed() < NPM_CACHE_TTL {
                return value.clone();
            }
        }
    }
    let probed = probe_npm_prefix();
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((probed.clone(), Instant::now()));
    }
    probed
}

#[cfg(windows)]
fn probe_npm_prefix() -> Option<PathBuf> {
    use std::io::Read as _;

    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        push_unique(&mut dirs, PathBuf::from(appdata).join("npm"));
    }
    let npm = find_in_dirs("npm", &dirs)?;

    let plan = spawn_plan(&npm.to_string_lossy());
    let mut command = std::process::Command::new(&plan.program);
    command.args(&plan.prefix);
    command.args(["config", "get", "prefix"]);
    command.stdin(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(NO_WINDOW);
    }

    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + NPM_PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }

    let mut stdout = child.stdout.take()?;
    let mut text = String::new();
    (&mut stdout)
        .take(NPM_PREFIX_MAX_BYTES + 1)
        .read_to_string(&mut text)
        .ok()?;
    if text.len() as u64 > NPM_PREFIX_MAX_BYTES {
        return None;
    }
    let prefix = text.trim();
    if prefix.is_empty()
        || prefix.eq_ignore_ascii_case("undefined")
        || prefix.eq_ignore_ascii_case("null")
    {
        return None;
    }
    Some(PathBuf::from(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_paths_pass_through() {
        assert_eq!(resolve_launchable_cli_binary(""), "");
        assert_eq!(
            resolve_launchable_cli_binary("definitely-missing-cli"),
            "definitely-missing-cli"
        );
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn cmd_shim_routes_through_cmd() {
        let plan = spawn_plan("cmd");
        assert_eq!(plan.program, "cmd");
        assert!(plan.prefix.is_empty());
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn explicit_cmd_path_is_wrapped() {
        let plan = spawn_plan("C:\\tools\\thing.cmd");
        assert_eq!(plan.program, "cmd");
        assert_eq!(plan.prefix, vec!["/C", "\"C:\\tools\\thing.cmd\""]);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn explicit_exe_path_runs_directly() {
        let plan = spawn_plan("C:\\tools\\thing.exe");
        assert_eq!(plan.program, "C:\\tools\\thing.exe");
        assert!(plan.prefix.is_empty());
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn find_cli_binary_locates_a_system_executable() {
        let found = find_cli_binary("cmd").expect("cmd.exe is on PATH");
        assert!(found
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("exe"))
            .unwrap_or(false));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn bare_name_runs_directly_on_unix() {
        let plan = spawn_plan("npx");
        assert_eq!(plan.program, "npx");
        assert!(plan.prefix.is_empty());
    }
}
