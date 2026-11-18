//! One row per process in a snapshot.

use std::sync::Arc;

use serde::Serialize;

/// The role a WebView2 helper plays in its browser process group.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WebViewRole {
    Browser,
    Renderer,
    Gpu,
    Network,
    Storage,
    Audio,
    Utility,
    Crashpad,
    #[default]
    Unknown,
}

/// The browser process a WebView2 helper belongs to plus what it does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebViewInfo {
    /// A runtime group, not every process with the same executable or host name.
    pub browser_pid: u32,
    pub browser_create_time: i64,
    pub host_name: Option<Arc<str>>,
    pub host_description: Option<Arc<str>>,
    pub host_icon: Option<u32>,
    pub role: WebViewRole,
}

/// Sparse engine contributions. Identity includes the physical adapter and
/// node; a display name alone does not distinguish duplicated Copy/Compute
/// engines.
#[derive(Debug, Clone, Serialize)]
pub struct GpuEngineUsage {
    pub id: Arc<str>,
    pub name: Arc<str>,
    pub util: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRow {
    pub pid: u32,
    pub ppid: u32,
    /// Unix ms. Together with `pid` this identifies a process instance.
    pub create_time: i64,
    pub name: Arc<str>,
    pub path: Option<Arc<str>>,
    pub description: Option<Arc<str>>,
    pub company: Option<Arc<str>>,
    pub icon: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_view: Option<Arc<WebViewInfo>>,
    /// Percent of total machine capacity, 0–100.
    pub cpu: f32,
    /// Total CPU time consumed, ms.
    pub cpu_time: u64,
    /// Private working set (what Task Manager calls "Memory").
    pub private_ws: u64,
    pub working_set: u64,
    /// Private committed bytes.
    pub commit: u64,
    /// I/O bytes per second.
    pub io_read: u64,
    pub io_write: u64,
    pub io_other: u64,
    /// Disk bytes per second; absent until the disk source has a valid interval.
    pub disk_read: Option<u64>,
    pub disk_write: Option<u64>,
    /// The process's share of its busiest GPU engine, percent.
    pub gpu: f32,
    /// That engine, e.g. `GPU 0 - 3D`; None while the process leaves the GPU idle.
    pub gpu_engine: Option<Arc<str>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub gpu_engines: Vec<GpuEngineUsage>,
    /// GPU memory in use, bytes: video memory and system memory.
    pub gpu_dedicated: u64,
    pub gpu_shared: u64,
    /// Network bytes per second, when per-process traffic is measured (ETW).
    pub net_sent: u64,
    pub net_received: u64,
    pub threads: u32,
    pub handles: u32,
    pub session_id: u32,
    pub base_priority: i32,
    pub suspended: bool,
    /// Efficiency mode (EcoQoS) is on, set by the app itself or by a user.
    pub efficiency: bool,
    /// Owns a taskbar window, which puts it under "Apps" (see `app_windows`).
    pub app_window: bool,
    /// Windows component identity for display grouping, not an action safety check.
    pub windows_process: bool,
}
