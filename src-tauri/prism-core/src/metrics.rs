//! What the core process costs, for the home page's traffic card.
//!
//! mihomo's `/memory` endpoint is a WebSocket, and the page only needs two
//! numbers every few seconds, so the process itself is asked instead: its
//! working set and its creation time. Both are part of the OS, not the core's
//! REST API, which also means they keep working when the controller does not.

use serde::Serialize;

use crate::core::{self, CoreSlot};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreMetrics {
    /// Time since the core process started.
    pub uptime_ms: Option<u64>,
    /// Working set in bytes.
    pub memory: Option<u64>,
}

pub fn read(slot: &CoreSlot) -> CoreMetrics {
    let Some(pid) = core::current_pid(slot) else {
        return CoreMetrics {
            uptime_ms: None,
            memory: None,
        };
    };
    process(pid)
}

#[cfg(windows)]
fn process(pid: u32) -> CoreMetrics {
    use std::mem::size_of;
    use std::time::{SystemTime, UNIX_EPOCH};

    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // FILETIME counts 100 ns ticks since 1601-01-01.
    const EPOCH_OFFSET_MS: u64 = 11_644_473_600_000;

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return CoreMetrics {
            uptime_ms: None,
            memory: None,
        };
    }

    let memory = unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if GetProcessMemoryInfo(handle, &mut counters, counters.cb) != 0 {
            Some(counters.WorkingSetSize as u64)
        } else {
            None
        }
    };

    let uptime_ms = unsafe {
        let mut creation: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0 {
            let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
            let started_ms = ticks / 10_000;
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis() as u64)
                .unwrap_or(0);
            Some(now_ms.saturating_sub(started_ms.saturating_sub(EPOCH_OFFSET_MS)))
        } else {
            None
        }
    };

    unsafe {
        CloseHandle(handle);
    }

    CoreMetrics { uptime_ms, memory }
}

#[cfg(not(windows))]
fn process(_pid: u32) -> CoreMetrics {
    CoreMetrics {
        uptime_ms: None,
        memory: None,
    }
}
