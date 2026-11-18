//! Machine-wide totals sampled once per snapshot.

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// Total CPU usage, 0–100.
    pub cpu: f32,
    /// Kernel portion reported by the Windows time counters, bounded by `cpu`.
    pub cpu_kernel: f32,
    /// Dense (group, processor) order; None until a valid interval is available.
    pub cores: Vec<Option<f32>>,
    pub logical_cpus: u32,
    pub mem_total: u64,
    pub mem_used: u64,
    pub mem_available: u64,
    pub commit_used: u64,
    pub commit_limit: u64,
    pub cached: u64,
    /// Disjoint memory lists; None when the native query is unavailable.
    pub memory_lists: Option<MemoryLists>,
    pub kernel_paged: u64,
    pub kernel_nonpaged: u64,
    pub process_count: u32,
    pub thread_count: u32,
    pub handle_count: u32,
    pub uptime_ms: u64,
    /// Aggregate process I/O, bytes per second.
    pub io_read: u64,
    pub io_write: u64,
    pub io_other: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryLists {
    pub modified: u64,
    pub standby: u64,
    /// Free and zeroed pages can both be immediately reused.
    pub free: u64,
}
