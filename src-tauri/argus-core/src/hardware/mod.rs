//! Device-level telemetry for the performance view: CPU identity, clocks,
//! memory modules, physical disks, network adapters and GPUs.
//!
//! The battery, thermal-zone, power and kernel-sensor sources are deliberately
//! absent: the first scope carries only the metrics the performance tab shows.

use std::sync::Arc;

use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuThread {
    pub group: u16,
    pub processor: u8,
    /// Physical core it belongs to (hyper-threads share one).
    pub core: u32,
    /// An efficiency core of a hybrid CPU (Intel E-core).
    pub efficient: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    /// Empty when the registry does not say.
    pub name: String,
    pub vendor: String,
    pub family: u32,
    pub model: u32,
    pub stepping: u32,
    pub instructions: Vec<&'static str>,
    pub microcode: Option<u32>,
    pub base_mhz: u32,
    pub base_source: Option<&'static str>,
    pub sockets: u32,
    pub cores: u32,
    /// Hybrid CPUs only: cores in the highest efficiency class.
    pub performance_cores: u32,
    pub efficiency_cores: u32,
    pub logical: u32,
    pub l1: u64,
    pub l2: u64,
    pub l3: u64,
    /// Hardware virtualization enabled in firmware.
    pub virtualization: bool,
    /// Dense logical-processor order, sorted by (group, processor).
    pub threads: Vec<CpuThread>,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct CpuIdle {
    pub c1: Option<f32>,
    pub c2: Option<f32>,
    pub c3: Option<f32>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    /// Physically installed RAM in bytes (includes hardware-reserved memory).
    pub installed: u64,
    /// Configured speed in MT/s.
    pub speed: Option<u32>,
    pub slots_used: u32,
    pub slots_total: u32,
    /// e.g. `DIMM`, `SODIMM`; `onboard` for memory soldered to the board.
    pub form_factor: Option<String>,
    /// e.g. `DDR5`.
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub index: u32,
    /// Empty when the drive does not report one.
    pub model: String,
    pub size: u64,
    /// `nvme` | `sata` | `usb` | `sd` | `other`
    pub bus: &'static str,
    /// False for spinning disks; None when the drive does not say.
    pub ssd: Option<bool>,
    pub removable: bool,
    /// Drive letters on this disk, e.g. `["C:", "D:"]`.
    pub volumes: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    pub info: Arc<DiskInfo>,
    /// Percent of time the disk was busy, 0–100.
    pub active: f32,
    /// Bytes per second.
    pub read: u64,
    pub write: u64,
    /// Average time per transfer, ms.
    pub response_ms: f32,
    /// °C, for drives that report it (most NVMe and SATA SSDs).
    pub temperature: Option<f32>,
    /// The drive's own warning threshold, °C.
    pub temperature_warning: Option<f32>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NicInfo {
    /// Stable interface LUID, as a string (JS numbers cannot hold it).
    pub id: String,
    /// User-visible connection name, e.g. `Ethernet`, `Wi-Fi`.
    pub name: String,
    /// Adapter model, e.g. `Intel(R) Wi-Fi 6E AX211`.
    pub description: String,
    /// `ethernet` | `wifi` | `virtual` | `other`
    pub kind: &'static str,
    /// Link speed in bits per second.
    pub link_speed: u64,
    pub mac: Option<String>,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NicStats {
    pub info: Arc<NicInfo>,
    /// Bytes per second.
    pub rx: u64,
    pub tx: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    /// Adapter LUID as a string.
    pub id: String,
    pub name: String,
    pub dedicated_total: u64,
    pub shared_total: u64,
    /// Distinct engine names, e.g. `3D`, `Copy`, `Video Decode`.
    pub engines: Vec<String>,
    pub temperature_max: Option<f32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GpuUtilSource {
    #[default]
    Windows,
    Process,
    Nvml,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GpuPowerSource {
    Nvml,
    AdlBoard,
    AdlChip,
    Igcl,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStats {
    pub info: Arc<GpuInfo>,
    /// Busiest engine, supplemented by process and GPU-core telemetry, 0–100.
    pub util: f32,
    pub util_source: GpuUtilSource,
    /// Per engine name, aligned with `info.engines`.
    pub engines: Vec<f32>,
    pub dedicated_used: u64,
    pub shared_used: u64,
    /// °C.
    pub temperature: Option<f32>,
    pub fan_rpm: Option<u32>,
    /// Percent of the board's power budget.
    pub power: Option<f32>,
    /// Measured power and enforced limit, W; source specifies the scope.
    pub board_power: Option<f32>,
    pub board_power_limit: Option<f32>,
    pub power_source: Option<GpuPowerSource>,
    /// 3D engine clock and its maximum, MHz.
    pub clock_mhz: Option<u32>,
    pub clock_max_mhz: Option<u32>,
    /// 3D engine voltage, mV.
    pub voltage_mv: Option<u32>,
    pub memory_clock_mhz: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub cpu: Arc<CpuInfo>,
    /// Effective clock in MHz (base clock scaled by current performance).
    pub cpu_mhz: Option<u32>,
    /// Per logical processor, MHz; empty when Windows does not publish it.
    pub core_mhz: Vec<u32>,
    /// Logical-thread idle-state residency reported by Windows, not hardware C6/C10.
    pub cpu_idle: Vec<CpuIdle>,
    pub memory: Arc<MemoryInfo>,
    pub disks: Vec<DiskStats>,
    pub nics: Vec<NicStats>,
    pub gpus: Vec<GpuStats>,
}

/// Owns the per-device trackers. B1 replaces this stub with the ported sources.
#[derive(Debug, Default)]
pub struct HardwareTracker;

impl HardwareTracker {
    pub fn new() -> Self {
        Self
    }

    pub fn sample(&mut self) -> Hardware {
        todo!("hardware sampling is implemented by B1")
    }
}
