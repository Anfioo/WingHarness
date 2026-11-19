// DTOs and error discrimination for the task manager page.
//
// Mirrors `argus-core/src/{error,models,process,system,details,collector}.rs`
// and `argus-service/src/lib.rs`. Every field is camelCase on the wire; the
// framework maps the wrapper's arguments onto the Rust snake_case parameters.

/** Stable error codes returned by every `argus_*` command. */
export type ArgusErrorCode =
  | "not-found"
  | "invalid-input"
  | "access-denied"
  | "service-unavailable"
  | "internal";

/** Shape of a rejected `argus_*` command. */
export type ArgusError = {
  code: ArgusErrorCode;
  message: string;
  detail?: string;
};

export type ArgusSettings = {
  /** Sampling interval, 250–5000 ms. */
  intervalMs: number;
};

export type Priority = "idle" | "belowNormal" | "normal" | "aboveNormal" | "high" | "realtime";

export type TreeKillReport = {
  terminated: number;
  failed: number;
  serviceOutdated: boolean;
};

export type VersionInfo = {
  description: string | null;
  company: string | null;
  productName: string | null;
  fileVersion: string | null;
};

export type Integrity =
  | "untrusted"
  | "low"
  | "medium"
  | "mediumPlus"
  | "high"
  | "system"
  | "protected";
export type Architecture = "x64" | "x86" | "arm64" | "arm";

export type ProcessDetails = {
  pid: number;
  accessible: boolean;
  commandLine: string | null;
  user: string | null;
  integrity: Integrity | null;
  elevated: boolean | null;
  architecture: Architecture | null;
  priorityClass: Priority | null;
  version: VersionInfo;
};

export type WebViewRole =
  | "browser"
  | "renderer"
  | "gpu"
  | "network"
  | "storage"
  | "audio"
  | "utility"
  | "crashpad"
  | "unknown";

export type WebViewInfo = {
  browserPid: number;
  browserCreateTime: number;
  hostName: string | null;
  hostDescription: string | null;
  hostIcon: number | null;
  role: WebViewRole;
};

export type GpuEngineUsage = { id: string; name: string; util: number };

export type ProcessRow = {
  pid: number;
  ppid: number;
  /** Unix ms; with `pid`, identifies a process instance. */
  createTime: number;
  name: string;
  path: string | null;
  description: string | null;
  company: string | null;
  icon: number | null;
  webView?: WebViewInfo;
  /** Percent of total machine capacity. */
  cpu: number;
  /** Total CPU time, ms. */
  cpuTime: number;
  privateWs: number;
  workingSet: number;
  commit: number;
  ioRead: number;
  ioWrite: number;
  ioOther: number;
  diskRead: number | null;
  diskWrite: number | null;
  /** The process's share of its busiest GPU engine, percent. */
  gpu: number;
  /** That engine, e.g. `GPU 0 - 3D`; null while the GPU is idle for it. */
  gpuEngine: string | null;
  /** Sparse physical-engine contributions, used for aggregation. */
  gpuEngines?: GpuEngineUsage[];
  /** GPU memory in use, bytes. */
  gpuDedicated: number;
  gpuShared: number;
  /** Network bytes per second; 0 unless `Snapshot.processNetwork`. */
  netSent: number;
  netReceived: number;
  threads: number;
  handles: number;
  sessionId: number;
  basePriority: number;
  suspended: boolean;
  /** Efficiency mode (EcoQoS) is on. */
  efficiency: boolean;
  /** Owns a taskbar window, which puts it under "Apps". */
  appWindow: boolean;
  windowsProcess: boolean;
};

export type MemoryLists = { modified: number; standby: number; free: number };

export type SystemStats = {
  cpu: number;
  /** Portion of `cpu` spent in kernel mode. */
  cpuKernel: number;
  cores: (number | null)[];
  logicalCpus: number;
  memTotal: number;
  memUsed: number;
  memAvailable: number;
  commitUsed: number;
  commitLimit: number;
  cached: number;
  memoryLists: MemoryLists | null;
  kernelPaged: number;
  kernelNonpaged: number;
  processCount: number;
  threadCount: number;
  handleCount: number;
  uptimeMs: number;
  ioRead: number;
  ioWrite: number;
  ioOther: number;
};

export type CpuThread = {
  group: number;
  processor: number;
  /** Physical core (hyper-threads share one). */
  core: number;
  /** An efficiency core of a hybrid CPU. */
  efficient: boolean;
};

export type CpuInfo = {
  name: string;
  vendor: string;
  family: number;
  model: number;
  stepping: number;
  instructions: string[];
  microcode: number | null;
  baseMhz: number;
  baseSource: "cpuid" | "windows" | null;
  sockets: number;
  cores: number;
  /** Hybrid CPUs only (0 otherwise). */
  performanceCores: number;
  efficiencyCores: number;
  logical: number;
  l1: number;
  l2: number;
  l3: number;
  virtualization: boolean;
  /** One per logical processor, indexed like `SystemStats.cores`. */
  threads: CpuThread[];
};

export type MemoryInfo = {
  installed: number;
  /** MT/s */
  speed: number | null;
  slotsUsed: number;
  slotsTotal: number;
  /** e.g. `DIMM`; `onboard` for memory soldered to the board. */
  formFactor: string | null;
  kind: string | null;
};

export type DiskInfo = {
  index: number;
  model: string;
  size: number;
  bus: "nvme" | "sata" | "usb" | "sd" | "other";
  ssd: boolean | null;
  removable: boolean;
  volumes: string[];
};

export type DiskStats = {
  info: DiskInfo;
  /** Percent of time busy. */
  active: number;
  read: number;
  write: number;
  responseMs: number;
  /** °C */
  temperature: number | null;
  temperatureWarning: number | null;
};

export type NicInfo = {
  id: string;
  name: string;
  description: string;
  kind: "ethernet" | "wifi" | "virtual" | "other";
  /** bits per second */
  linkSpeed: number;
  mac: string | null;
  ipv4: string[];
  ipv6: string[];
};

export type NicStats = {
  info: NicInfo;
  /** bytes per second */
  rx: number;
  tx: number;
};

export type GpuInfo = {
  id: string;
  name: string;
  dedicatedTotal: number;
  sharedTotal: number;
  engines: string[];
  temperatureMax: number | null;
};

export type GpuUtilSource = "windows" | "process" | "nvml";
export type GpuPowerSource = "nvml" | "adlBoard" | "adlChip" | "igcl";

export type GpuStats = {
  info: GpuInfo;
  util: number;
  utilSource: GpuUtilSource;
  /** Aligned with `info.engines`. */
  engines: number[];
  dedicatedUsed: number;
  sharedUsed: number;
  temperature: number | null;
  fanRpm: number | null;
  /** Percent of the board's power budget. */
  power: number | null;
  /** Power and limit in W; the source identifies the measurement scope. */
  boardPower: number | null;
  boardPowerLimit: number | null;
  powerSource: GpuPowerSource | null;
  clockMhz: number | null;
  clockMaxMhz: number | null;
  voltageMv: number | null;
  memoryClockMhz: number | null;
};

export type BatteryInfo = {
  id: string;
  name: string;
  manufacturer: string;
  serial: string;
  /** Four-letter code, e.g. `LION`, `LiP`. */
  chemistry: string;
  /** mWh; null when the battery reports relative units only. */
  designedCapacity: number | null;
  fullCapacity: number | null;
  cycleCount: number | null;
  /** `YYYY-MM-DD`. */
  manufactured: string | null;
};

export type BatteryState = "charging" | "discharging" | "full" | "idle";

export type BatteryStats = {
  info: BatteryInfo;
  /** 0–100. */
  percent: number;
  /** mWh remaining. */
  capacity: number | null;
  /** mW into the battery; negative while discharging. */
  rate: number | null;
  /** mV. */
  voltage: number | null;
  state: BatteryState;
  pluggedIn: boolean;
  critical: boolean;
  /** Seconds until empty, while discharging. */
  remaining: number | null;
  /** °C. */
  temperature: number | null;
};

/**
 * Device-level telemetry for the performance tab.
 *
 * The thermal, power and kernel-sensor sources are deliberately absent here
 * as well as in the Rust struct.
 */
export type Hardware = {
  cpu: CpuInfo;
  cpuMhz: number | null;
  /** Per logical processor, MHz; empty when unknown. */
  coreMhz: number[];
  memory: MemoryInfo;
  disks: DiskStats[];
  nics: NicStats[];
  gpus: GpuStats[];
  batteries: BatteryStats[];
};

export type Snapshot = {
  seq: number;
  timestamp: number;
  system: SystemStats;
  hardware: Hardware;
  processes: ProcessRow[];
  /** Per-process network traffic is measured locally or by the privileged service. */
  processNetwork: boolean;
};

export type ServiceStatus = {
  state: string;
  authorized: boolean;
  version: string | null;
  error: string | null;
  incompatible: boolean;
};
