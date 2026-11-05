//! Process snapshot and application close control.
//!
//! `windows-sys` exposes no ToolHelp feature in this crate, so the process table
//! is read from one static `Get-CimInstance Win32_Process` script. Close
//! requests are batched into a single PowerShell invocation per mode with
//! validated numeric process IDs; no user text is ever interpolated.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::applications::catalog::ProcessSnapshot;
use crate::applications::contracts::{
    ApplicationProcessCloseMode, ApplicationProcessCloseResult, ApplicationProcessTarget,
    Cancellation, RunningProcessIdentity,
};
use crate::applications::running_identity;
use crate::platform::windows::inventory;

const PROCESS_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(15);
const CLOSE_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const GRACEFUL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const FORCE_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const CLOSE_QUIESCENCE_INTERVAL: Duration = Duration::from_millis(500);
const MAX_IDENTITIES_PER_TARGET: usize = 256;
const MAX_PROCESS_IDENTITIES: usize = 256;

const PROCESS_SNAPSHOT_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$items = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath)
[Console]::Out.Write((ConvertTo-Json -InputObject $items -Depth 2 -Compress))
"#;

const GRACEFUL_CLOSE_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
foreach ($targetId in {IDS}) {
    $targetProcess = Get-Process -Id $targetId -ErrorAction SilentlyContinue
    if ($null -ne $targetProcess) { [void]$targetProcess.CloseMainWindow() }
}
"#;

const FORCE_CLOSE_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
foreach ($targetId in {IDS}) { Stop-Process -Id $targetId -Force -ErrorAction SilentlyContinue }
"#;

#[derive(Debug, Clone)]
struct ProcessInstance {
    pid: u32,
    parent_pid: u32,
    executable_name: String,
    executable_path: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct RawProcess {
    #[serde(rename = "ProcessId", alias = "processId", default)]
    process_id: u32,
    #[serde(rename = "ParentProcessId", alias = "parentProcessId", default)]
    parent_process_id: u32,
    #[serde(rename = "Name", alias = "name", default)]
    name: Option<String>,
    #[serde(rename = "ExecutablePath", alias = "executablePath", default)]
    executable_path: Option<String>,
}

/// Captures the process snapshot exposed by the catalog.
pub(crate) fn snapshot(cancellation: &Cancellation) -> Result<ProcessSnapshot, String> {
    ProcessSnapshot::capture(cancellation)
}

/// The process subset used to build the catalog snapshot, excluding this
/// process and everything it spawned.
pub(crate) fn running_identities(
    cancellation: &Cancellation,
) -> Result<Vec<RunningProcessIdentity>, String> {
    let processes = enumerate_processes(cancellation)?;
    let excluded = excluded_process_ids(&processes);
    let mut identities = processes
        .into_iter()
        .filter(|process| !excluded.contains(&process.pid))
        .map(|process| RunningProcessIdentity {
            executable_name: process.executable_name,
            executable_path: process.executable_path,
        })
        .collect::<Vec<_>>();
    identities.sort_by(|left, right| {
        left.executable_name
            .to_ascii_lowercase()
            .cmp(&right.executable_name.to_ascii_lowercase())
            .then_with(|| {
                running_identity::path_identity_key(
                    left.executable_path.as_deref().unwrap_or(std::path::Path::new("")),
                )
                .cmp(&running_identity::path_identity_key(
                    right
                        .executable_path
                        .as_deref()
                        .unwrap_or(std::path::Path::new("")),
                ))
            })
    });
    Ok(identities)
}

/// Closes every process owned by one trusted application target.
pub(crate) fn close_application_processes(
    target: &ApplicationProcessTarget,
    mode: ApplicationProcessCloseMode,
) -> Result<ApplicationProcessCloseResult, String> {
    close_application_processes_many(std::slice::from_ref(target), mode)
        .into_iter()
        .next()
        .unwrap_or_else(|| Err("application_close_target_missing".to_string()))
}

/// Closes the process families of several targets with one snapshot and one
/// request per polling round.
pub(crate) fn close_application_processes_many(
    targets: &[ApplicationProcessTarget],
    mode: ApplicationProcessCloseMode,
) -> Vec<Result<ApplicationProcessCloseResult, String>> {
    if targets.is_empty() {
        return Vec::new();
    }
    let started = Instant::now();
    let validation_errors = targets
        .iter()
        .map(|target| validate_target(target).err())
        .collect::<Vec<_>>();
    if validation_errors.iter().all(Option::is_some) {
        return validation_errors
            .into_iter()
            .map(|error| Err(error.unwrap_or_else(|| "application_close_target_invalid".to_string())))
            .collect();
    }
    let matchers = targets
        .iter()
        .map(TargetMatcher::new)
        .collect::<Vec<_>>();
    let cancellation = Cancellation::new();
    let initial_snapshot = match enumerate_processes(&cancellation) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return validation_errors
                .into_iter()
                .map(|validation| Err(validation.unwrap_or_else(|| error.clone())))
                .collect();
        }
    };
    let matched = targets
        .iter()
        .zip(&matchers)
        .zip(&validation_errors)
        .map(|((_, matcher), error)| {
            if error.is_none() {
                matching_processes(matcher, &initial_snapshot)
            } else {
                Vec::new()
            }
        })
        .collect::<Vec<_>>();
    let mut requested = vec![HashSet::<u32>::new(); targets.len()];
    let mut attempted = HashSet::<u32>::new();
    let mut pending = BTreePids::default();
    for (index, processes) in matched.iter().enumerate() {
        if validation_errors[index].is_some() {
            continue;
        }
        for process in processes {
            if matchers[index].authorizes(process) {
                requested[index].insert(process.pid);
                if !attempted.contains(&process.pid) {
                    pending.insert(process.pid);
                }
            }
        }
    }
    if !pending.is_empty() {
        match request_close(mode, &pending.ids()) {
            Ok(()) => {
                attempted.extend(pending.ids());
            }
            Err(error) => {
                log::warn!(
                    "windows_application_close_request_failed mode={} process_count={} error={}",
                    mode_code(mode),
                    pending.len(),
                    error
                );
                for set in &mut requested {
                    set.clear();
                }
            }
        }
        pending.clear();
    }

    let timeout = match mode {
        ApplicationProcessCloseMode::Graceful => GRACEFUL_CLOSE_TIMEOUT,
        ApplicationProcessCloseMode::Force => FORCE_CLOSE_TIMEOUT,
    };
    let deadline = Instant::now() + timeout;
    let mut empty_since = None;
    let mut final_snapshot = initial_snapshot;
    loop {
        let snapshot = match enumerate_processes(&cancellation) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                log::warn!(
                    "windows_application_close_snapshot_failed mode={} error={}",
                    mode_code(mode),
                    error
                );
                break;
            }
        };
        let remaining = targets
            .iter()
            .zip(&matchers)
            .zip(&validation_errors)
            .map(|((_, matcher), error)| {
                if error.is_none() {
                    matching_processes(matcher, &snapshot)
                } else {
                    Vec::new()
                }
            })
            .collect::<Vec<_>>();
        let has_remaining = remaining.iter().any(|processes| !processes.is_empty());
        let now = Instant::now();
        if !has_remaining {
            let since = *empty_since.get_or_insert(now);
            if now.duration_since(since) >= CLOSE_QUIESCENCE_INTERVAL || now >= deadline {
                final_snapshot = snapshot;
                break;
            }
            std::thread::sleep(CLOSE_POLL_INTERVAL);
            continue;
        }
        empty_since = None;
        if now >= deadline {
            final_snapshot = snapshot;
            break;
        }
        if mode == ApplicationProcessCloseMode::Force {
            for ((_, processes), error) in remaining.iter().enumerate().zip(&validation_errors) {
                if error.is_some() {
                    continue;
                }
                for process in processes {
                    if !attempted.contains(&process.pid) {
                        pending.insert(process.pid);
                    }
                }
            }
            if !pending.is_empty() {
                if request_close(mode, &pending.ids()).is_ok() {
                    attempted.extend(pending.ids());
                }
                pending.clear();
            }
            for (index, processes) in remaining.iter().enumerate() {
                if validation_errors[index].is_some() {
                    continue;
                }
                for process in processes {
                    if attempted.contains(&process.pid) {
                        requested[index].insert(process.pid);
                    }
                }
            }
        }
        std::thread::sleep(CLOSE_POLL_INTERVAL);
    }

    let remaining_names = targets
        .iter()
        .zip(&matchers)
        .zip(&validation_errors)
        .map(|((_, matcher), error)| {
            if error.is_none() {
                unique_executable_names(&matching_processes(matcher, &final_snapshot))
            } else {
                Vec::new()
            }
        })
        .collect::<Vec<_>>();
    log::info!(
        "windows_application_close_finished mode={} target_count={} matched_process_count={} requested_process_count={} remaining_process_count={} elapsed_ms={}",
        mode_code(mode),
        targets.len(),
        matched.iter().map(Vec::len).sum::<usize>(),
        requested.iter().map(HashSet::len).sum::<usize>(),
        remaining_names.iter().map(Vec::len).sum::<usize>(),
        started.elapsed().as_millis(),
    );
    targets
        .iter()
        .enumerate()
        .zip(validation_errors)
        .map(|((index, _), error)| match error {
            Some(error) => Err(error),
            None => {
                let target_matches = &matched[index];
                Ok(ApplicationProcessCloseResult {
                    matched_process_count: target_matches.len() as u64,
                    requested_process_count: target_matches
                        .iter()
                        .filter(|process| requested[index].contains(&process.pid))
                        .count() as u64,
                    remaining_processes: remaining_names[index].clone(),
                })
            }
        })
        .collect()
}

#[derive(Default)]
struct BTreePids {
    pids: std::collections::BTreeSet<u32>,
}

impl BTreePids {
    fn insert(&mut self, pid: u32) {
        if pid > 0 {
            self.pids.insert(pid);
        }
    }

    fn clear(&mut self) {
        self.pids.clear();
    }

    fn is_empty(&self) -> bool {
        self.pids.is_empty()
    }

    fn len(&self) -> usize {
        self.pids.len()
    }

    fn ids(&self) -> Vec<u32> {
        self.pids.iter().copied().collect()
    }
}

struct TargetMatcher {
    names: HashSet<String>,
    paths: HashSet<String>,
    path_names: HashSet<String>,
    has_paths: bool,
}

impl TargetMatcher {
    fn new(target: &ApplicationProcessTarget) -> Self {
        let names = target
            .executable_names
            .iter()
            .flat_map(|name| running_identity::process_aliases(name))
            .collect::<HashSet<_>>();
        let paths = target
            .executable_paths
            .iter()
            .map(|path| running_identity::path_identity_key(path))
            .collect::<HashSet<_>>();
        let path_names = target
            .executable_paths
            .iter()
            .filter_map(|path| path.file_name())
            .flat_map(|name| running_identity::process_aliases(&name.to_string_lossy()))
            .collect::<HashSet<_>>();
        let has_paths = !paths.is_empty();
        Self {
            names,
            paths,
            path_names,
            has_paths,
        }
    }

    fn matches(&self, process: &ProcessInstance) -> bool {
        if self.has_paths {
            match process.executable_path.as_deref() {
                Some(path) => self
                    .paths
                    .contains(&running_identity::path_identity_key(path)),
                None => running_identity::process_aliases(&process.executable_name)
                    .iter()
                    .any(|name| self.path_names.contains(name)),
            }
        } else {
            running_identity::process_aliases(&process.executable_name)
                .iter()
                .any(|name| self.names.contains(name))
        }
    }

    /// A name-only match never authorizes closing a process whose image path is
    /// known and different from the requested installation.
    fn authorizes(&self, process: &ProcessInstance) -> bool {
        if !self.has_paths {
            return true;
        }
        process.executable_path.as_deref().is_some_and(|path| {
            self.paths
                .contains(&running_identity::path_identity_key(path))
        })
    }
}

fn matching_processes(
    matcher: &TargetMatcher,
    snapshot: &[ProcessInstance],
) -> Vec<ProcessInstance> {
    snapshot
        .iter()
        .filter(|process| matcher.matches(process))
        .cloned()
        .collect()
}

fn unique_executable_names(processes: &[ProcessInstance]) -> Vec<String> {
    let mut names = processes
        .iter()
        .map(|process| process.executable_name.clone())
        .collect::<Vec<_>>();
    names.sort_by_key(|name| name.to_ascii_lowercase());
    names.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    names
}

fn enumerate_processes(cancellation: &Cancellation) -> Result<Vec<ProcessInstance>, String> {
    if cancellation.is_cancelled() {
        return Err("windows_process_snapshot_cancelled".to_string());
    }
    let output = inventory::run_powershell_with_timeout(
        PROCESS_SNAPSHOT_SCRIPT,
        PROCESS_SNAPSHOT_TIMEOUT,
        Some(cancellation),
    )
    .map_err(|error| format!("windows_process_snapshot_failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "windows_process_snapshot_exit_code={:?}",
            output.status.code()
        ));
    }
    if output.stdout.is_empty() {
        return Err("windows_process_snapshot_empty".to_string());
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("windows_process_snapshot_parse_failed: {error}"))?;
    let records = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(_) => vec![value],
        _ => return Err("windows_process_snapshot_shape_invalid".to_string()),
    };
    let mut processes = Vec::with_capacity(records.len());
    for record in records {
        let raw: RawProcess = serde_json::from_value(record)
            .map_err(|error| format!("windows_process_snapshot_record_invalid: {error}"))?;
        if raw.process_id == 0 {
            continue;
        }
        let Some(name) = raw.name.map(|name| name.trim().to_string()) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let executable_path = raw
            .executable_path
            .map(|path| path.trim().to_string())
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        processes.push(ProcessInstance {
            pid: raw.process_id,
            parent_pid: raw.parent_process_id,
            executable_name: name,
            executable_path,
        });
    }
    if processes.is_empty() {
        return Err("windows_process_snapshot_empty".to_string());
    }
    Ok(processes)
}

fn excluded_process_ids(processes: &[ProcessInstance]) -> HashSet<u32> {
    let own = std::process::id();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for process in processes {
        children
            .entry(process.parent_pid)
            .or_default()
            .push(process.pid);
    }
    let mut excluded = HashSet::from([own]);
    let mut pending = vec![own];
    while let Some(parent) = pending.pop() {
        let Some(kindred) = children.get(&parent) else {
            continue;
        };
        for pid in kindred {
            if excluded.insert(*pid) {
                pending.push(*pid);
            }
        }
    }
    excluded
}

fn request_close(mode: ApplicationProcessCloseMode, pids: &[u32]) -> Result<(), String> {
    let mut ids = pids
        .iter()
        .copied()
        .filter(|pid| *pid > 0)
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(());
    }
    let list = ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let template = match mode {
        ApplicationProcessCloseMode::Graceful => GRACEFUL_CLOSE_SCRIPT,
        ApplicationProcessCloseMode::Force => FORCE_CLOSE_SCRIPT,
    };
    let script = template.replace("{IDS}", &format!("@({list})"));
    let output = inventory::run_powershell_with_timeout(&script, CLOSE_COMMAND_TIMEOUT, None)
        .map_err(|error| format!("windows_application_close_failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "windows_application_close_exit_code={:?}",
            output.status.code()
        ));
    }
    Ok(())
}

fn validate_target(target: &ApplicationProcessTarget) -> Result<(), String> {
    let identity_count = target.executable_names.len() + target.executable_paths.len();
    if identity_count == 0 {
        return Err("application_close_target_empty".to_string());
    }
    if identity_count > MAX_PROCESS_IDENTITIES {
        return Err("application_close_target_too_large".to_string());
    }
    if target
        .executable_names
        .iter()
        .any(|name| name.trim().is_empty() || name.len() > MAX_IDENTITIES_PER_TARGET)
    {
        return Err("application_close_target_name_invalid".to_string());
    }
    if target
        .executable_paths
        .iter()
        .any(|path| !path.is_absolute())
    {
        return Err("application_close_target_path_invalid".to_string());
    }
    if requires_exact_close_identity(&target.executable_names)
        && target.executable_paths.is_empty()
    {
        return Err("application_close_target_requires_exact_path".to_string());
    }
    Ok(())
}

/// Brave and standalone Brave Origin share an executable filename on Windows;
/// a name-only request cannot distinguish the selected product.
fn requires_exact_close_identity(names: &[String]) -> bool {
    names
        .iter()
        .any(|name| name.eq_ignore_ascii_case("brave.exe"))
}

const fn mode_code(mode: ApplicationProcessCloseMode) -> &'static str {
    match mode {
        ApplicationProcessCloseMode::Graceful => "graceful",
        ApplicationProcessCloseMode::Force => "force",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance(pid: u32, name: &str, path: Option<&str>) -> ProcessInstance {
        ProcessInstance {
            pid,
            parent_pid: 0,
            executable_name: name.to_string(),
            executable_path: path.map(PathBuf::from),
        }
    }

    fn matcher(names: &[&str], paths: &[&str]) -> TargetMatcher {
        TargetMatcher::new(&ApplicationProcessTarget {
            executable_names: names.iter().map(|name| name.to_string()).collect(),
            executable_paths: paths.iter().map(PathBuf::from).collect(),
        })
    }

    #[test]
    fn exact_paths_take_precedence_and_unauthorized_processes_are_never_closed() {
        let matcher = matcher(&["Shared.exe"], &[r"C:\Expected\Shared.exe"]);
        let other = instance(1, "Shared.exe", Some(r"C:\Other\Shared.exe"));
        let expected = instance(2, "Shared.exe", Some(r"C:\Expected\Shared.exe"));
        assert!(!matcher.matches(&other));
        assert!(matcher.matches(&expected));
        assert!(matcher.authorizes(&expected));
        assert!(!matcher.authorizes(&other));
    }

    #[test]
    fn unresolved_image_paths_block_a_path_scoped_request() {
        let matcher = matcher(&[], &[r"C:\Expected\Shared.exe"]);
        let unknown = instance(1, "Shared.exe", None);
        assert!(matcher.matches(&unknown));
        assert!(!matcher.authorizes(&unknown));
    }

    #[test]
    fn name_only_targets_match_case_and_extension_insensitively() {
        let matcher = matcher(&["Example"], &[]);
        assert!(matcher.matches(&instance(1, "Example.exe", None)));
        assert!(!matcher.matches(&instance(2, "Other.exe", None)));
        assert!(matcher.authorizes(&instance(1, "Example.exe", None)));
    }

    #[test]
    fn invalid_targets_are_rejected() {
        assert!(validate_target(&ApplicationProcessTarget::default()).is_err());
        assert!(validate_target(&ApplicationProcessTarget {
            executable_names: vec!["brave.exe".to_string()],
            executable_paths: Vec::new(),
        })
        .is_err());
        assert!(validate_target(&ApplicationProcessTarget {
            executable_names: vec!["Example.exe".to_string()],
            executable_paths: Vec::new(),
        })
        .is_ok());
    }

    #[test]
    fn own_process_and_descendants_are_excluded() {
        let own = std::process::id();
        let child = own.wrapping_add(1);
        let grandchild = own.wrapping_add(2);
        let mut processes = vec![
            instance(own, "self.exe", None),
            instance(child, "child.exe", None),
            instance(grandchild, "grandchild.exe", None),
            instance(own.wrapping_add(3), "other.exe", None),
        ];
        processes[1].parent_pid = own;
        processes[2].parent_pid = child;
        let excluded = excluded_process_ids(&processes);
        assert!(excluded.contains(&own));
        assert!(excluded.contains(&child));
        assert!(excluded.contains(&grandchild));
        assert!(!excluded.contains(&own.wrapping_add(3)));
    }

    #[test]
    fn close_scripts_contain_only_validated_numeric_ids() {
        let script = FORCE_CLOSE_SCRIPT.replace("{IDS}", "@(10,20)");
        assert!(script.contains("@(10,20)"));
        assert!(script.contains("Stop-Process -Id $targetId -Force"));
    }
}
