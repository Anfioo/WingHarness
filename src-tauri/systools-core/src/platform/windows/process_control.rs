//! Native process enumeration, matching, and bounded close.
//!
//! Enumeration uses a ToolHelp snapshot plus a per-process image-path query.
//! A target is closed only when it belongs to the current user session and its
//! image path still matches the captured identity. Graceful close posts
//! `WM_CLOSE` to each top-level window; force close terminates the process.
//! Closing is bounded by a deadline and reports whatever remains running.

use std::{
    collections::{HashMap, HashSet},
    ffi::c_void,
    mem::{size_of, zeroed},
    os::windows::ffi::OsStringExt,
    path::{Path, PathBuf},
    ptr::null_mut,
    thread,
    time::{Duration, Instant},
};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM,
    },
    Security::{GetTokenInformation, TokenSessionId, TOKEN_QUERY},
    System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
        QueryFullProcessImageNameW, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    },
    UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE},
};

use crate::applications::contracts::{
    ApplicationProcessCloseMode, ApplicationProcessCloseResult, ApplicationProcessTarget,
    RunningProcessIdentity,
};

use super::path_identity;

const GRACEFUL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const FORCE_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(100);
const CLOSE_QUIESCENCE_INTERVAL: Duration = Duration::from_millis(500);
const MAX_EXECUTABLE_PATH_UNITS: usize = 32_768;
const MAX_TARGET_ENTRIES: usize = 256;
const MAX_IDENTITY_BYTES: usize = 1_024;
const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const MAX_PATH_UNITS: usize = 260;

/// Mirrors `PROCESSENTRY32W` from `TlHelp32.h`.
///
/// The ToolHelp module is not enabled in the shared windows-sys feature set, so
/// the structure and the three entry points are declared locally with the same
/// layout the operating system expects.
#[repr(C)]
struct ProcessEntry32W {
    dw_size: u32,
    cnt_usage: u32,
    th32_process_id: u32,
    th32_default_heap_id: usize,
    th32_module_id: u32,
    cnt_threads: u32,
    th32_parent_process_id: u32,
    pc_pri_class_base: i32,
    dw_flags: u32,
    sz_exe_file: [u16; MAX_PATH_UNITS],
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateToolhelp32Snapshot(dw_flags: u32, th32_process_id: u32) -> HANDLE;
    fn Process32FirstW(snapshot: HANDLE, entry: *mut ProcessEntry32W) -> i32;
    fn Process32NextW(snapshot: HANDLE, entry: *mut ProcessEntry32W) -> i32;
}

struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn new(handle: HANDLE) -> Option<Self> {
        (!handle.is_null() && handle != INVALID_HANDLE_VALUE).then_some(Self(handle))
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[derive(Debug, Clone)]
struct ProcessInstance {
    pid: u32,
    parent_pid: u32,
    executable_name: String,
    executable_path: Option<PathBuf>,
    /// The current application and its descendants are never closed.
    self_family: bool,
}

#[derive(Debug, Clone, Copy)]
enum CloseRequestOutcome {
    Requested,
    NotRequested,
}

impl CloseRequestOutcome {
    fn was_requested(self) -> bool {
        matches!(self, Self::Requested)
    }
}

/// Returns the executable identity of every visible process.
///
/// Processes whose image path cannot be queried remain visible by name so an
/// installed application is still reported as running.
// Part of the process snapshot contract consumed by the catalog lane.
#[allow(dead_code)]
pub(crate) fn running_process_identities() -> Result<Vec<RunningProcessIdentity>, String> {
    let processes = enumerate_processes()?;
    Ok(processes
        .into_iter()
        .filter(|process| !process.self_family)
        .map(|process| RunningProcessIdentity {
            executable_name: process.executable_name,
            executable_path: process.executable_path,
        })
        .collect())
}

/// Returns whether any current process matches the application target.
pub(crate) fn process_is_running(target: &ApplicationProcessTarget) -> Result<bool, String> {
    validate_target(target)?;
    let processes = enumerate_processes()?;
    Ok(!matching_processes(&ProcessMatcher::new(target), &processes).is_empty())
}

/// Closes every process that matches one application target.
// Single-target callers use this; the batch service uses the many-target form.
#[allow(dead_code)]
pub(crate) fn close_application_processes(
    target: &ApplicationProcessTarget,
    mode: ApplicationProcessCloseMode,
) -> Result<ApplicationProcessCloseResult, String> {
    let mut results =
        close_application_processes_many(std::slice::from_ref(target), mode).into_iter();
    results
        .next()
        .expect("a single close target must produce one result")
}

/// Closes several application targets with one snapshot per polling interval.
///
/// Every target keeps its independent result, and one target never prevents the
/// rest of the selection from being closed.
pub(crate) fn close_application_processes_many(
    targets: &[ApplicationProcessTarget],
    mode: ApplicationProcessCloseMode,
) -> Vec<Result<ApplicationProcessCloseResult, String>> {
    if targets.is_empty() {
        return Vec::new();
    }
    let validation = targets
        .iter()
        .map(|target| validate_target(target).err())
        .collect::<Vec<_>>();
    if validation.iter().all(Option::is_some) {
        return validation
            .into_iter()
            .map(|error| Err(error.expect("every target was invalid")))
            .collect();
    }
    let matchers = targets
        .iter()
        .zip(&validation)
        .map(|(target, error)| error.is_none().then(|| ProcessMatcher::new(target)))
        .collect::<Vec<_>>();
    let initial = match enumerate_processes() {
        Ok(processes) => processes,
        Err(error) => {
            return validation
                .into_iter()
                .map(|validation_error| Err(validation_error.unwrap_or_else(|| error.clone())))
                .collect()
        }
    };
    let matched = matchers
        .iter()
        .map(|matcher| {
            matcher
                .as_ref()
                .map_or_else(Vec::new, |matcher| matching_processes(matcher, &initial))
        })
        .collect::<Vec<_>>();

    let mut requests = HashMap::<u32, CloseRequestOutcome>::new();
    let mut attempted = HashSet::<u32>::new();
    for (target, processes) in targets.iter().zip(&matched) {
        request_close(target, processes, mode, &mut requests, &mut attempted);
    }

    let timeout = match mode {
        ApplicationProcessCloseMode::Graceful => GRACEFUL_CLOSE_TIMEOUT,
        ApplicationProcessCloseMode::Force => FORCE_CLOSE_TIMEOUT,
    };
    let deadline = Instant::now() + timeout;
    let mut observed = matched.clone();
    let mut quiet_since: Option<Instant> = None;
    let final_snapshot = loop {
        let snapshot = match enumerate_processes() {
            Ok(processes) => processes,
            Err(error) => {
                return validation
                    .into_iter()
                    .map(|validation_error| Err(validation_error.unwrap_or_else(|| error.clone())))
                    .collect()
            }
        };
        let remaining = matchers
            .iter()
            .map(|matcher| {
                matcher
                    .as_ref()
                    .map_or_else(Vec::new, |matcher| matching_processes(matcher, &snapshot))
            })
            .collect::<Vec<_>>();
        let has_remaining = remaining.iter().any(|processes| !processes.is_empty());
        let now = Instant::now();
        if !has_remaining {
            // Helpers can restart shortly after their parent window exits.
            // Require a short quiet interval so success is not reported while
            // the process family is still settling.
            let since = quiet_since.get_or_insert(now);
            if now.duration_since(*since) >= CLOSE_QUIESCENCE_INTERVAL || now >= deadline {
                break snapshot;
            }
            thread::sleep(CLOSE_POLL_INTERVAL);
            continue;
        }
        quiet_since = None;
        if now >= deadline {
            break snapshot;
        }
        if mode == ApplicationProcessCloseMode::Force {
            // Continue force-closing newly observed family members until the
            // selection is quiescent or the deadline expires. Each PID is
            // attempted at most once.
            for ((target, seen), processes) in targets.iter().zip(&mut observed).zip(&remaining) {
                for process in processes {
                    if !seen.iter().any(|candidate| candidate.pid == process.pid) {
                        seen.push(process.clone());
                    }
                }
                request_close(target, processes, mode, &mut requests, &mut attempted);
            }
        }
        thread::sleep(CLOSE_POLL_INTERVAL);
    };

    let results = validation
        .into_iter()
        .zip(matched)
        .zip(&matchers)
        .map(|((validation_error, matched), matcher)| {
            if let Some(error) = validation_error {
                return Err(error);
            }
            let matcher = matcher
                .as_ref()
                .expect("a valid target always has a process matcher");
            let remaining = matching_processes(matcher, &final_snapshot);
            Ok(ApplicationProcessCloseResult {
                matched_process_count: matched.len() as u64,
                requested_process_count: matched
                    .iter()
                    .filter(|process| {
                        requests
                            .get(&process.pid)
                            .copied()
                            .is_some_and(CloseRequestOutcome::was_requested)
                    })
                    .count() as u64,
                remaining_processes: unique_executable_names(&remaining),
            })
        })
        .collect::<Vec<_>>();
    log_close_summary(mode, &requests, &attempted, &results);
    results
}

fn log_close_summary(
    mode: ApplicationProcessCloseMode,
    requests: &HashMap<u32, CloseRequestOutcome>,
    attempted: &HashSet<u32>,
    results: &[Result<ApplicationProcessCloseResult, String>],
) {
    let remaining = results
        .iter()
        .filter_map(|result| result.as_ref().ok())
        .map(|result| result.remaining_processes.len() as u64)
        .sum::<u64>();
    log::info!(
        "systools_application_close_finished mode={} attempted_process_count={} requested_process_count={} remaining_name_count={}",
        close_mode_code(mode),
        attempted.len(),
        requests
            .values()
            .filter(|outcome| outcome.was_requested())
            .count(),
        remaining
    );
    if remaining > 0 {
        log::info!("systools_application_close_pending mode={}", close_mode_code(mode));
    }
}

const fn close_mode_code(mode: ApplicationProcessCloseMode) -> &'static str {
    match mode {
        ApplicationProcessCloseMode::Graceful => "graceful",
        ApplicationProcessCloseMode::Force => "force",
    }
}

fn request_close(
    target: &ApplicationProcessTarget,
    processes: &[ProcessInstance],
    mode: ApplicationProcessCloseMode,
    requests: &mut HashMap<u32, CloseRequestOutcome>,
    attempted: &mut HashSet<u32>,
) {
    for process in processes {
        if attempted.contains(&process.pid) {
            continue;
        }
        let Some(handle) = open_verified_process(target, process, mode) else {
            continue;
        };
        attempted.insert(process.pid);
        let outcome = match mode {
            ApplicationProcessCloseMode::Graceful => request_graceful_close(process),
            ApplicationProcessCloseMode::Force => request_force_close(&handle),
        };
        requests.insert(process.pid, outcome);
    }
}

fn request_graceful_close(process: &ProcessInstance) -> CloseRequestOutcome {
    let mut context = WindowCloseContext {
        pid: process.pid,
        posted: false,
    };
    // SAFETY: the context lives on this stack frame for the whole enumeration,
    // and the callback only writes to it.
    unsafe {
        EnumWindows(
            Some(post_close_to_process_window),
            (&mut context as *mut WindowCloseContext) as LPARAM,
        );
    }
    if context.posted {
        CloseRequestOutcome::Requested
    } else {
        CloseRequestOutcome::NotRequested
    }
}

struct WindowCloseContext {
    pid: u32,
    posted: bool,
}

unsafe extern "system" fn post_close_to_process_window(window: HWND, context: LPARAM) -> i32 {
    // SAFETY: the caller passes a pointer to a live `WindowCloseContext`.
    let context = unsafe { &mut *(context as *mut WindowCloseContext) };
    let mut window_pid = 0_u32;
    // SAFETY: the window handle comes from `EnumWindows`.
    unsafe { GetWindowThreadProcessId(window, &mut window_pid) };
    if window_pid == context.pid && unsafe { PostMessageW(window, WM_CLOSE, 0, 0) } != 0 {
        context.posted = true;
    }
    1
}

fn request_force_close(handle: &OwnedHandle) -> CloseRequestOutcome {
    // SAFETY: the handle was opened with `PROCESS_TERMINATE` and its identity
    // was verified after opening.
    if unsafe { TerminateProcess(handle.0, 1) } != 0 {
        CloseRequestOutcome::Requested
    } else {
        CloseRequestOutcome::NotRequested
    }
}

/// Opens a process for mutation after re-verifying the captured identity.
///
/// Windows can reuse a PID once every handle is closed. Keeping this handle
/// open through the request prevents reuse, and the image path check rejects a
/// different executable that inherited the same PID.
fn open_verified_process(
    target: &ApplicationProcessTarget,
    process: &ProcessInstance,
    mode: ApplicationProcessCloseMode,
) -> Option<OwnedHandle> {
    if process.self_family || process.pid == 0 || process.pid == unsafe { GetCurrentProcessId() } {
        return None;
    }
    let access = match mode {
        ApplicationProcessCloseMode::Graceful => PROCESS_QUERY_LIMITED_INFORMATION,
        ApplicationProcessCloseMode::Force => PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
    };
    let handle = unsafe { OpenProcess(access, 0, process.pid) };
    let handle = OwnedHandle::new(handle)?;
    let session = process_session(handle.0)?;
    if Some(session) != current_session() {
        return None;
    }
    let current_path = query_executable_path(handle.0)?;
    let identity_matches = if target.executable_paths.is_empty() {
        current_path.file_name().is_some_and(|name| {
            normalize_name(&name.to_string_lossy()) == normalize_name(&process.executable_name)
        })
    } else {
        normalize_path(&current_path) == normalize_path(process.executable_path.as_deref()?)
    };
    identity_matches.then_some(handle)
}

fn enumerate_processes() -> Result<Vec<ProcessInstance>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    let snapshot = OwnedHandle::new(snapshot)
        .ok_or_else(|| "Windows process snapshot creation failed".to_string())?;
    // SAFETY: `PROCESSENTRY32W` is a plain C structure; zeroing is valid.
    let mut entry: ProcessEntry32W = unsafe { zeroed() };
    entry.dw_size = size_of::<ProcessEntry32W>() as u32;
    if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
        return Err("Windows process snapshot enumeration failed".to_string());
    }
    let mut processes = Vec::new();
    loop {
        let name = wide_string(&entry.sz_exe_file);
        if entry.th32_process_id != 0 && !name.is_empty() {
            let pid = entry.th32_process_id;
            let executable_path = process_identity(pid);
            processes.push(ProcessInstance {
                pid,
                parent_pid: entry.th32_parent_process_id,
                executable_name: name,
                executable_path,
                self_family: false,
            });
        }
        if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
            break;
        }
    }
    mark_self_family(&mut processes);
    Ok(processes)
}

/// Marks the current process and every descendant so a target that happens to
/// share an executable name can never authorize closing Systools itself.
fn mark_self_family(processes: &mut [ProcessInstance]) {
    let current = unsafe { GetCurrentProcessId() };
    let parents = processes
        .iter()
        .map(|process| (process.pid, process.parent_pid))
        .collect::<HashMap<_, _>>();
    let mut family = HashSet::new();
    family.insert(current);
    let mut changed = true;
    while changed {
        changed = false;
        for (pid, parent) in parents.iter() {
            if family.contains(parent) && family.insert(*pid) {
                changed = true;
            }
        }
    }
    for process in processes.iter_mut() {
        process.self_family = family.contains(&process.pid);
    }
}

fn process_identity(pid: u32) -> Option<PathBuf> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    let handle = OwnedHandle::new(handle)?;
    query_executable_path(handle.0)
}

fn query_executable_path(handle: HANDLE) -> Option<PathBuf> {
    let mut buffer = vec![0_u16; MAX_EXECUTABLE_PATH_UNITS];
    let mut length = buffer.len() as u32;
    // SAFETY: the buffer is writable for `length` UTF-16 code units.
    if unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer)))
}

fn process_session(handle: HANDLE) -> Option<u32> {
    let mut token: HANDLE = null_mut();
    // SAFETY: `handle` is a live process handle.
    if unsafe { OpenProcessToken(handle, TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let token = OwnedHandle::new(token)?;
    let mut session = 0_u32;
    let mut returned = 0_u32;
    // SAFETY: the output buffer is exactly one `u32`.
    let result = unsafe {
        GetTokenInformation(
            token.0,
            TokenSessionId,
            (&mut session as *mut u32).cast::<c_void>(),
            size_of::<u32>() as u32,
            &mut returned,
        )
    };
    (result != 0).then_some(session)
}

fn current_session() -> Option<u32> {
    // SAFETY: the pseudo-handle for the current process is always valid.
    process_session(unsafe { GetCurrentProcess() })
}

/// Precomputed identity sets for one target, reused across snapshot polls.
struct ProcessMatcher {
    names: HashSet<String>,
    paths: HashSet<String>,
    path_names: HashSet<String>,
}

impl ProcessMatcher {
    fn new(target: &ApplicationProcessTarget) -> Self {
        Self {
            names: target
                .executable_names
                .iter()
                .flat_map(|name| normalized_name_aliases(name))
                .collect(),
            paths: target
                .executable_paths
                .iter()
                .map(|path| normalize_path(path))
                .collect(),
            path_names: target
                .executable_paths
                .iter()
                .filter_map(|path| path.file_name())
                .flat_map(|name| normalized_name_aliases(&name.to_string_lossy()))
                .collect(),
        }
    }

    fn matches(&self, process: &ProcessInstance) -> bool {
        if self.paths.is_empty() {
            return normalized_name_aliases(&process.executable_name)
                .iter()
                .any(|name| self.names.contains(name));
        }
        // Exact configured paths take precedence. A process whose image path is
        // unresolved may still match by name, but it stays blocked from closing
        // when the caller supplied exact paths.
        process.executable_path.as_deref().map_or_else(
            || {
                normalized_name_aliases(&process.executable_name)
                    .iter()
                    .any(|name| self.path_names.contains(name))
            },
            |path| self.paths.contains(&normalize_path(path)),
        )
    }
}

fn matching_processes(
    matcher: &ProcessMatcher,
    snapshot: &[ProcessInstance],
) -> Vec<ProcessInstance> {
    let current_pid = unsafe { GetCurrentProcessId() };
    snapshot
        .iter()
        .filter(|process| process.pid != current_pid && !process.self_family)
        .filter(|process| matcher.matches(process))
        .cloned()
        .collect()
}

fn validate_target(target: &ApplicationProcessTarget) -> Result<(), String> {
    if target.executable_names.is_empty() && target.executable_paths.is_empty() {
        return Err("application process target contains no identity".to_string());
    }
    if target.executable_names.len() > MAX_TARGET_ENTRIES
        || target.executable_paths.len() > MAX_TARGET_ENTRIES
    {
        return Err("application process target contains too many identities".to_string());
    }
    if target.executable_names.iter().any(|name| {
        name.trim().is_empty() || name.len() > MAX_IDENTITY_BYTES || name.contains('\0')
    }) {
        return Err("application process target contains an invalid executable name".to_string());
    }
    if target
        .executable_paths
        .iter()
        .any(|path| !path.is_absolute() || paths_contain_nul(path))
    {
        return Err("application process target contains an invalid executable path".to_string());
    }
    Ok(())
}

fn paths_contain_nul(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().any(|unit| unit == 0)
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

fn wide_string(units: &[u16]) -> String {
    let length = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    std::ffi::OsString::from_wide(&units[..length])
        .to_string_lossy()
        .into_owned()
}

fn normalize_name(name: &str) -> String {
    Path::new(name.trim())
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
}

fn normalized_name_aliases(name: &str) -> Vec<String> {
    let normalized = normalize_name(name);
    let mut aliases = vec![normalized.clone()];
    if let Some(stem) = normalized.strip_suffix(".exe") {
        aliases.push(stem.to_string());
    }
    aliases
}

fn normalize_path(path: &Path) -> String {
    path_identity::comparison_key(path)
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
            self_family: false,
        }
    }

    #[test]
    fn path_normalization_is_case_and_separator_insensitive() {
        assert_eq!(
            normalize_path(Path::new("C:/Program Files/Example/App.exe")),
            normalize_path(Path::new(r"c:\Program Files\Example\APP.EXE"))
        );
    }

    #[test]
    fn executable_extension_is_an_optional_process_alias() {
        let target = normalized_name_aliases("ExampleCloseFixture");
        let process = normalized_name_aliases("ExampleCloseFixture.exe");
        assert!(process.iter().any(|name| target.contains(name)));
    }

    #[test]
    fn exact_paths_disable_the_name_fallback() {
        let snapshot = vec![instance(
            42,
            "SharedHelper.exe",
            Some(r"C:\Other\SharedHelper.exe"),
        )];
        let target = ApplicationProcessTarget {
            executable_names: vec!["SharedHelper.exe".to_string()],
            executable_paths: vec![PathBuf::from(r"C:\Expected\SharedHelper.exe")],
        };
        assert!(matching_processes(&ProcessMatcher::new(&target), &snapshot).is_empty());
    }

    #[test]
    fn unresolved_image_falls_back_to_the_name_only_without_exact_paths() {
        let snapshot = vec![instance(42, "SharedHelper.exe", None)];
        let by_path = ApplicationProcessTarget {
            executable_names: Vec::new(),
            executable_paths: vec![PathBuf::from(r"C:\Expected\SharedHelper.exe")],
        };
        assert_eq!(
            matching_processes(&ProcessMatcher::new(&by_path), &snapshot).len(),
            1
        );
        let by_name = ApplicationProcessTarget {
            executable_names: vec!["SharedHelper.exe".to_string()],
            executable_paths: Vec::new(),
        };
        assert_eq!(
            matching_processes(&ProcessMatcher::new(&by_name), &snapshot).len(),
            1
        );
    }

    #[test]
    fn self_family_is_never_matched() {
        let mut process = instance(42, "Systools.exe", None);
        process.self_family = true;
        let target = ApplicationProcessTarget {
            executable_names: vec!["Systools.exe".to_string()],
            executable_paths: Vec::new(),
        };
        assert!(matching_processes(&ProcessMatcher::new(&target), &[process]).is_empty());
    }

    #[test]
    fn targets_require_a_bounded_identity() {
        assert!(validate_target(&ApplicationProcessTarget::default()).is_err());
        assert!(validate_target(&ApplicationProcessTarget {
            executable_names: vec!["  ".to_string()],
            executable_paths: Vec::new(),
        })
        .is_err());
        assert!(validate_target(&ApplicationProcessTarget {
            executable_names: Vec::new(),
            executable_paths: vec![PathBuf::from("relative\\app.exe")],
        })
        .is_err());
        assert!(validate_target(&ApplicationProcessTarget {
            executable_names: vec!["app.exe".to_string()],
            executable_paths: Vec::new(),
        })
        .is_ok());
    }

    #[test]
    fn remaining_names_are_sorted_and_deduplicated() {
        let processes = vec![
            instance(1, "b.exe", None),
            instance(2, "A.exe", None),
            instance(3, "a.exe", None),
        ];
        assert_eq!(unique_executable_names(&processes), vec!["A.exe", "b.exe"]);
    }

    #[test]
    fn missing_targets_produce_no_close_results() {
        assert!(close_application_processes_many(&[], ApplicationProcessCloseMode::Graceful)
            .is_empty());
    }
}
