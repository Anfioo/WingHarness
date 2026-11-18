// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! Operations that change process state.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use windows::Wdk::System::SystemInformation::{
    NtQuerySystemInformation, SystemProcessInformation as SPI_CLASS,
};
use windows::Wdk::System::Threading::{NtQueryInformationProcess, PROCESSINFOCLASS};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, NTSTATUS,
};
use windows::Win32::System::Threading::{
    ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, GetCurrentProcessId,
    GetPriorityClass, GetProcessTimes, HIGH_PRIORITY_CLASS, IDLE_PRIORITY_CLASS,
    NORMAL_PRIORITY_CLASS, OpenProcess, PROCESS_ACCESS_RIGHTS, PROCESS_CREATION_FLAGS,
    PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    PROCESS_POWER_THROTTLING_STATE, PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, ProcessPowerThrottling,
    REALTIME_PRIORITY_CLASS, SetPriorityClass, SetProcessInformation, TerminateProcess,
    WaitForSingleObject,
};

const PROCESS_BREAK_ON_TERMINATION: PROCESSINFOCLASS = PROCESSINFOCLASS(29);

const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004_u32 as i32;
const STATUS_BUFFER_TOO_SMALL: i32 = 0xC000_0023_u32 as i32;
/// Upper bound for the process-list query: a busy machine needs a few MB, so
/// anything beyond this means the call is failing for another reason.
const MAX_QUERY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ActionError {
    /// Needs administrator rights (or the target is protected).
    AccessDenied,
    /// The process has already exited (or its PID was reused).
    NotFound,
    /// Terminating it would crash the system; requires explicit confirmation.
    Critical,
    /// Refused: the System process, Idle, or the task manager itself.
    Refused,
    /// Denied to this app's own rights, which acted because the privileged
    /// service speaks another protocol and refused it: updating the service
    /// lets it act again. Only the host reports it; the service never sends it.
    ServiceOutdated,
    Os(String),
}

impl From<windows::core::Error> for ActionError {
    fn from(e: windows::core::Error) -> Self {
        if e.code() == ERROR_ACCESS_DENIED.to_hresult() {
            ActionError::AccessDenied
        } else if e.code() == ERROR_INVALID_PARAMETER.to_hresult() {
            ActionError::NotFound
        } else {
            ActionError::Os(e.to_string())
        }
    }
}

impl ActionError {
    pub fn diagnostic(&self) -> std::borrow::Cow<'static, str> {
        match self {
            Self::AccessDenied => "access denied".into(),
            Self::NotFound => "target exited or identity changed".into(),
            Self::Critical => "critical process requires confirmation".into(),
            Self::Refused => "operation refused by policy".into(),
            Self::ServiceOutdated => "privileged service protocol incompatible".into(),
            Self::Os(message) => message.clone().into(),
        }
    }
}

/// Closes the wrapped handle on drop.
struct OwnedHandle(HANDLE);

// Kernel handles are valid process-wide, so moving one between threads is fine.
unsafe impl Send for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// Offset between the Windows epoch (1601) and the Unix epoch, in 100 ns ticks.
const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;

fn ticks_to_unix_ms(ticks: i64) -> i64 {
    if ticks <= EPOCH_DIFF_100NS {
        0
    } else {
        (ticks - EPOCH_DIFF_100NS) / 10_000
    }
}

fn filetime_ticks(ft: FILETIME) -> i64 {
    (((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64) as i64
}

/// A heap buffer with 8-byte alignment, suitable for NT structures.
struct AlignedBuf {
    data: Vec<u64>,
}

impl AlignedBuf {
    fn with_capacity(bytes: usize) -> Self {
        Self {
            data: vec![0; bytes.div_ceil(8)],
        }
    }

    fn len(&self) -> usize {
        self.data.len() * 8
    }

    fn grow_to(&mut self, bytes: usize) {
        if bytes > self.len() {
            self.data.resize(bytes.div_ceil(8), 0);
        }
    }

    fn as_mut_ptr(&mut self) -> *mut core::ffi::c_void {
        self.data.as_mut_ptr().cast()
    }

    fn as_ptr(&self) -> *const u8 {
        self.data.as_ptr().cast()
    }
}

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

/// `SYSTEM_PROCESS_INFORMATION` up to the fields the tree walk needs. The full
/// header is 256 bytes on x64; the trailing thread array is not read here.
#[repr(C)]
struct ProcessInfo {
    next_entry_offset: u32,
    number_of_threads: u32,
    working_set_private_size: i64,
    hard_fault_count: u32,
    number_of_threads_high_watermark: u32,
    cycle_time: u64,
    create_time: i64,
    user_time: i64,
    kernel_time: i64,
    image_name: UnicodeString,
    base_priority: i32,
    unique_process_id: HANDLE,
    inherited_from_unique_process_id: HANDLE,
    handle_count: u32,
    session_id: u32,
    unique_process_key: usize,
    peak_virtual_size: usize,
    virtual_size: usize,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
    private_page_count: usize,
    read_operation_count: i64,
    write_operation_count: i64,
    other_operation_count: i64,
    read_transfer_count: i64,
    write_transfer_count: i64,
    other_transfer_count: i64,
}

#[cfg(target_pointer_width = "64")]
const _: () = assert!(std::mem::size_of::<ProcessInfo>() == 256);

fn query_process_list(buf: &mut AlignedBuf) -> Result<usize, NTSTATUS> {
    for _ in 0..4 {
        let mut needed = 0u32;
        let status = unsafe {
            NtQuerySystemInformation(SPI_CLASS, buf.as_mut_ptr(), buf.len() as u32, &mut needed)
        };
        if status.0 >= 0 {
            return Ok(needed as usize);
        }
        let length_changed = matches!(
            status.0,
            STATUS_INFO_LENGTH_MISMATCH | STATUS_BUFFER_TOO_SMALL
        );
        if length_changed && needed as usize > buf.len() {
            if needed as usize >= MAX_QUERY_BYTES {
                return Err(status);
            }
            buf.grow_to(needed as usize + 64 * 1024);
            continue;
        }
        return Err(status);
    }
    Err(NTSTATUS(STATUS_INFO_LENGTH_MISMATCH))
}

/// Minimal `(pid, parent pid, creation time)` listing, used to walk process
/// trees. Kept local to this module so the action layer does not depend on the
/// sampling layer for a single native query.
fn list_lineage() -> Vec<(u32, u32, i64)> {
    let mut buf = AlignedBuf::with_capacity(512 * 1024);
    if query_process_list(&mut buf).is_err() {
        return Vec::new();
    }
    let mut rows = Vec::new();
    let mut offset = 0usize;
    loop {
        if offset + std::mem::size_of::<ProcessInfo>() > buf.len() {
            break;
        }
        // SAFETY: the kernel wrote a chain of 8-byte aligned records into the
        // buffer, and the offset is bounds-checked above.
        let info = unsafe { &*(buf.as_ptr().add(offset) as *const ProcessInfo) };
        let pid = info.unique_process_id.0 as usize as u32;
        if pid != 0 {
            rows.push((
                pid,
                info.inherited_from_unique_process_id.0 as usize as u32,
                ticks_to_unix_ms(info.create_time),
            ));
        }
        match info.next_entry_offset {
            0 => break,
            next => offset += next as usize,
        }
    }
    rows
}

/// Opens the process instance identified by `pid` + `create_time` (Unix ms;
/// 0 skips the identity check), so a reused PID is never acted on.
fn open_instance(
    pid: u32,
    create_time: i64,
    access: PROCESS_ACCESS_RIGHTS,
) -> Result<OwnedHandle, ActionError> {
    let handle = unsafe { OpenProcess(access | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .inspect_err(|error| {
            log::warn!(
                "argus process action open failed: {error}; pid={pid}; access=0x{:08x}",
                (access | PROCESS_QUERY_LIMITED_INFORMATION).0
            );
        })?;
    let handle = OwnedHandle(handle);
    if create_time != 0 {
        let (mut created, mut exited, mut kernel, mut user) = Default::default();
        unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) }
            .inspect_err(|error| {
                log::warn!("argus process action identity query failed: {error}; pid={pid}");
            })?;
        let created: FILETIME = created;
        if ticks_to_unix_ms(filetime_ticks(created)) != create_time {
            return Err(ActionError::NotFound);
        }
    }
    Ok(handle)
}

/// Terminates the process instance identified by `pid` + `create_time`
/// (Unix ms; 0 skips the identity check).
pub fn terminate(pid: u32, create_time: i64, allow_critical: bool) -> Result<(), ActionError> {
    if pid == 0 || pid == 4 || pid == unsafe { GetCurrentProcessId() } {
        return Err(ActionError::Refused);
    }
    let handle = open_instance(pid, create_time, PROCESS_TERMINATE)?;
    if !allow_critical && is_critical(pid) {
        return Err(ActionError::Critical);
    }
    unsafe { TerminateProcess(handle.0, 1) }?;
    Ok(())
}

/// Ends process instances (`pid`, `create_time`) and waits up to `wait` for
/// them to be gone; returns how many were ended. Each is raised to high
/// priority first: a process ended while starved of CPU took half a minute to
/// finish exiting, keeping its files open all along; raised, about 0.1 s.
pub fn end_and_wait(targets: &[(u32, i64)], wait: Duration) -> usize {
    let me = unsafe { GetCurrentProcessId() };
    let access = PROCESS_TERMINATE | PROCESS_SET_INFORMATION | PROCESS_SYNCHRONIZE;
    let ended: Vec<OwnedHandle> = targets
        .iter()
        .filter(|&&(pid, _)| pid != 0 && pid != 4 && pid != me)
        .filter_map(|&(pid, create_time)| {
            let handle = open_instance(pid, create_time, access).ok()?;
            if is_critical(pid) {
                return None;
            }
            let _ = unsafe { SetPriorityClass(handle.0, HIGH_PRIORITY_CLASS) };
            unsafe { TerminateProcess(handle.0, 1) }.ok()?;
            Some(handle)
        })
        .collect();
    let deadline = std::time::Instant::now() + wait;
    for handle in &ended {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        unsafe { WaitForSingleObject(handle.0, left.as_millis() as u32) };
    }
    ended.len()
}

/// Whether the process is marked critical (terminating it bugchecks the
/// system). Needs full query access, so this only detects it when elevated —
/// which is also the only case where termination could succeed.
fn is_critical(pid: u32) -> bool {
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, false, pid) }) else {
        return false;
    };
    let handle = OwnedHandle(handle);
    let mut flag = 0u32;
    let status = unsafe {
        NtQueryInformationProcess(
            handle.0,
            PROCESS_BREAK_ON_TERMINATION,
            (&mut flag as *mut u32).cast(),
            4,
            std::ptr::null_mut(),
        )
    };
    status.0 >= 0 && flag != 0
}

/// A process priority class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Idle,
    BelowNormal,
    Normal,
    AboveNormal,
    High,
    Realtime,
}

impl Priority {
    fn class(self) -> PROCESS_CREATION_FLAGS {
        match self {
            Priority::Idle => IDLE_PRIORITY_CLASS,
            Priority::BelowNormal => BELOW_NORMAL_PRIORITY_CLASS,
            Priority::Normal => NORMAL_PRIORITY_CLASS,
            Priority::AboveNormal => ABOVE_NORMAL_PRIORITY_CLASS,
            Priority::High => HIGH_PRIORITY_CLASS,
            Priority::Realtime => REALTIME_PRIORITY_CLASS,
        }
    }

    fn from_class(class: u32) -> Option<Self> {
        [
            Priority::Idle,
            Priority::BelowNormal,
            Priority::Normal,
            Priority::AboveNormal,
            Priority::High,
            Priority::Realtime,
        ]
        .into_iter()
        .find(|p| p.class().0 == class)
    }
}

/// Sets the priority class of a process instance and returns the class it
/// ended up with: without the privilege to raise base priority (elevation),
/// Windows quietly turns "realtime" into "high".
pub fn set_priority(
    pid: u32,
    create_time: i64,
    priority: Priority,
) -> Result<Priority, ActionError> {
    let handle = open_instance(pid, create_time, PROCESS_SET_INFORMATION)?;
    unsafe { SetPriorityClass(handle.0, priority.class()) }?;
    Ok(Priority::from_class(unsafe { GetPriorityClass(handle.0) }).unwrap_or(priority))
}

/// Turns efficiency mode on or off the way Task Manager does: EcoQoS (the
/// scheduler prefers efficient cores and low clocks) plus the idle priority
/// class; turning it off hands QoS back to Windows and restores normal
/// priority if it is still idle.
pub fn set_efficiency_mode(pid: u32, create_time: i64, on: bool) -> Result<(), ActionError> {
    let handle = open_instance(pid, create_time, PROCESS_SET_INFORMATION)?;
    let mask = if on {
        PROCESS_POWER_THROTTLING_EXECUTION_SPEED
    } else {
        0
    };
    let state = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: mask,
        StateMask: mask,
    };
    unsafe {
        SetProcessInformation(
            handle.0,
            ProcessPowerThrottling,
            (&state as *const PROCESS_POWER_THROTTLING_STATE).cast(),
            size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        )
    }?;
    if on {
        unsafe { SetPriorityClass(handle.0, IDLE_PRIORITY_CLASS) }?;
    } else if unsafe { GetPriorityClass(handle.0) } == IDLE_PRIORITY_CLASS.0 {
        unsafe { SetPriorityClass(handle.0, NORMAL_PRIORITY_CLASS) }?;
    }
    Ok(())
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeKillReport {
    pub terminated: u32,
    pub failed: u32,
    /// A descendant was denied while the privileged service needs an update
    /// (`ActionError::ServiceOutdated`), so the UI offers it. The count alone
    /// would lose that; a denied root fails the whole call with the error.
    pub service_outdated: bool,
}

impl TreeKillReport {
    /// Counts how ending one descendant went.
    fn note(&mut self, result: Result<(), ActionError>) {
        match result {
            Ok(()) => self.terminated += 1,
            Err(e) => {
                self.failed += 1;
                self.service_outdated |= matches!(e, ActionError::ServiceOutdated);
            }
        }
    }
}

/// Terminates a process and all of its descendants, deepest first.
pub fn terminate_tree(pid: u32, create_time: i64) -> Result<TreeKillReport, ActionError> {
    terminate_tree_with(pid, create_time, |pid, created| {
        terminate(pid, created, false)
    })
}

/// Enumerates locally while allowing the host to route individual operations
/// through its privileged service. Every target retains its creation time.
pub fn terminate_tree_with(
    pid: u32,
    create_time: i64,
    mut terminate_one: impl FnMut(u32, i64) -> Result<(), ActionError>,
) -> Result<TreeKillReport, ActionError> {
    let procs = list_lineage();
    let mut children: HashMap<u32, Vec<(u32, i64)>> = HashMap::new();
    let created: HashMap<u32, i64> = procs.iter().map(|&(p, _, c)| (p, c)).collect();
    for &(p, parent, c) in &procs {
        // A child must start after its parent; otherwise the parent PID was reused.
        if let Some(&pc) = created.get(&parent)
            && pc <= c
            && p != parent
        {
            children.entry(parent).or_default().push((p, c));
        }
    }
    if create_time != 0 && created.get(&pid) != Some(&create_time) {
        return Err(ActionError::NotFound);
    }

    // Post-order: collect descendants, then reverse so leaves go first.
    let mut order = Vec::new();
    let mut stack = vec![(pid, create_time)];
    while let Some((p, c)) = stack.pop() {
        order.push((p, c));
        if let Some(kids) = children.get(&p) {
            stack.extend(kids.iter().copied());
        }
    }
    let root = order.remove(0);

    let mut report = TreeKillReport::default();
    for (p, c) in order.into_iter().rev() {
        report.note(terminate_one(p, c));
    }
    terminate_one(root.0, root.1)?;
    report.terminated += 1;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_keep_their_wire_form() {
        // The UI reads these tags; the service protocol reuses them.
        let json = |e: ActionError| serde_json::to_string(&e).unwrap();
        assert_eq!(
            json(ActionError::AccessDenied),
            r#"{"kind":"accessDenied"}"#
        );
        assert_eq!(json(ActionError::NotFound), r#"{"kind":"notFound"}"#);
        assert_eq!(json(ActionError::Critical), r#"{"kind":"critical"}"#);
        assert_eq!(json(ActionError::Refused), r#"{"kind":"refused"}"#);
        assert_eq!(
            json(ActionError::ServiceOutdated),
            r#"{"kind":"serviceOutdated"}"#
        );
        assert_eq!(
            json(ActionError::Os("x".into())),
            r#"{"kind":"os","message":"x"}"#
        );
        assert!(matches!(
            serde_json::from_str(r#"{"kind":"serviceOutdated"}"#),
            Ok(ActionError::ServiceOutdated)
        ));
    }

    #[test]
    fn windows_errors_map_to_action_errors() {
        let denied = windows::core::Error::from_hresult(ERROR_ACCESS_DENIED.to_hresult());
        assert!(matches!(
            ActionError::from(denied),
            ActionError::AccessDenied
        ));
        let invalid = windows::core::Error::from_hresult(ERROR_INVALID_PARAMETER.to_hresult());
        assert!(matches!(ActionError::from(invalid), ActionError::NotFound));
        let other = windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL);
        assert!(matches!(ActionError::from(other), ActionError::Os(_)));
    }

    #[test]
    fn a_tree_report_keeps_whether_updating_the_service_would_help() {
        let mut report = TreeKillReport::default();
        report.note(Ok(()));
        report.note(Err(ActionError::NotFound));
        report.note(Err(ActionError::AccessDenied));
        // Gone or denied for good: an update would not help.
        assert!(!report.service_outdated);
        report.note(Err(ActionError::ServiceOutdated));
        report.note(Ok(()));
        assert_eq!((report.terminated, report.failed), (2, 3));
        assert!(report.service_outdated);
        assert_eq!(
            serde_json::to_string(&report).unwrap(),
            r#"{"terminated":2,"failed":3,"serviceOutdated":true}"#
        );
    }

    #[test]
    fn terminating_this_process_is_refused() {
        let me = std::process::id();
        assert!(matches!(terminate(me, 0, true), Err(ActionError::Refused)));
        assert!(matches!(terminate(0, 0, true), Err(ActionError::Refused)));
        assert!(matches!(terminate(4, 0, true), Err(ActionError::Refused)));
    }

    #[test]
    fn every_priority_maps_back_from_its_class() {
        for priority in [
            Priority::Idle,
            Priority::BelowNormal,
            Priority::Normal,
            Priority::AboveNormal,
            Priority::High,
            Priority::Realtime,
        ] {
            assert_eq!(Priority::from_class(priority.class().0), Some(priority));
        }
        assert_eq!(Priority::from_class(0), None);
    }
}
