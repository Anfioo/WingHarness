// DTOs and error discrimination for the FRP console.
//
// Mirrors `frp-core/src/models.rs` and `frp-core/src/error.rs`. Every field is
// camelCase on the wire. `token` and a tunnel's `secretKey` are plain text by
// explicit user decision: the engine stores them in `frp.json`, and the UI
// masks them unless the user reveals them.

/** Stable error codes returned by every `frp_*` command. */
export type FrpErrorCode =
  | "not-found"
  | "invalid-input"
  | "conflict"
  | "runtime-missing"
  | "runtime-in-use"
  | "config-invalid"
  | "spawn-failed"
  | "not-implemented"
  | "internal";

/** Shape of a rejected `frp_*` command. */
export type FrpError = {
  code: FrpErrorCode;
  message: string;
  detail: Record<string, unknown> | null;
};

const FRP_ERROR_CODES = new Set<string>([
  "not-found",
  "invalid-input",
  "conflict",
  "runtime-missing",
  "runtime-in-use",
  "config-invalid",
  "spawn-failed",
  "not-implemented",
  "internal",
]);

/** Narrow a rejected command to the engine's error type. */
export function isFrpError(value: unknown): value is FrpError {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && FRP_ERROR_CODES.has(code);
}

/** `code` of a rejected command, or `null` when it came from somewhere else. */
export function frpErrorCode(value: unknown): FrpErrorCode | null {
  return isFrpError(value) ? value.code : null;
}

/** How a profile picks the `frpc` binary to run. */
export type RuntimePolicy = "recommended" | "pinned";

export type FrpProfile = {
  id: string;
  name: string;
  serverAddr: string;
  serverPort: number;
  /** Plain text as stored in `frp.json`; mask it in the UI by default. */
  token: string | null;
  runtimePolicy: RuntimePolicy;
  runtimeId: string | null;
  reconnectEnabled: boolean;
  note: string;
  /** Bumped whenever the generated config changes. */
  configRevision: number;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

/** The editable half of a profile, as the create/update form sends it. */
export type FrpProfileInput = {
  name: string;
  serverAddr: string;
  serverPort: number;
  token: string | null;
  runtimePolicy: RuntimePolicy;
  runtimeId: string | null;
  reconnectEnabled: boolean;
  note: string;
};

export type TunnelType = "tcp" | "udp" | "http" | "https" | "stcp" | "xtcp";

export type SecretRole = "server" | "visitor";

/** Type-specific tunnel options, tagged by `kind`. */
export type TunnelOptions =
  | { kind: "port"; remotePort: number }
  | {
      kind: "domain";
      customDomains: string[];
      subdomain: string | null;
      locations: string[];
    }
  | { kind: "secret"; secretKey: string; role: SecretRole; serverName: string | null };

export type Tunnel = {
  id: string;
  profileId: string;
  name: string;
  type: TunnelType;
  enabled: boolean;
  localIp: string;
  localPort: number;
  options: TunnelOptions;
  createdAt: number;
  updatedAt: number;
};

/** The editable half of a tunnel, as the create/update form sends it. */
export type TunnelInput = {
  profileId: string;
  name: string;
  type: TunnelType;
  enabled: boolean;
  localIp: string;
  localPort: number;
  options: TunnelOptions;
};

/** A tunnel plus the name of its profile, for the all-profiles table. */
export type TunnelView = Tunnel & { profileName: string };

export type RuntimeRecord = {
  id: string;
  path: string;
  version: string;
  platform: string;
  architecture: string;
  sha256: string;
  sizeBytes: number;
  rawVersionOutput: string;
  addedAt: number;
  lastCheckedAt: number | null;
};

/** A runtime record plus how many profiles reference it. */
export type RuntimeView = RuntimeRecord & { profileCount: number; inUse: boolean };

/** Result of probing one path, before anything is persisted. */
export type RuntimeProbe = {
  path: string;
  valid: boolean;
  version: string | null;
  platform: string | null;
  architecture: string | null;
  rawOutput: string | null;
  error: string | null;
};

/** One candidate found by the local discovery scan. */
export type DiscoveredRuntime = {
  path: string;
  version: string | null;
  platform: string | null;
  architecture: string | null;
  /** Where the scan found it: `path`, `common` or `deep`. */
  source: string;
  alreadyImported: boolean;
  runtimeId: string | null;
};

export type FrpPrefs = {
  activeTab: string;
  logRetentionDays: number;
  logMaxFileSizeMb: number;
  logMaxFilesPerProfile: number;
};

/** `frp.json` as the engine persists it. */
export type Workspace = {
  version: number;
  profiles: FrpProfile[];
  tunnels: Tunnel[];
  runtimes: RuntimeRecord[];
  prefs: FrpPrefs;
};

export type ProcessState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "reconnecting"
  | "failed";

export type TunnelState = "unknown" | "online" | "offline" | "error";

/** One tunnel's inferred state, as carried by snapshots and metrics events. */
export type TunnelRuntimeState = {
  name: string;
  state: TunnelState;
  message: string | null;
};

/** Everything the overview needs to describe one profile's connection. */
export type ConnectionSnapshot = {
  profileId: string;
  state: ProcessState;
  pid: number | null;
  runtimeId: string | null;
  runtimeVersion: string | null;
  startedAt: number | null;
  lastError: string | null;
  tunnelStates: TunnelRuntimeState[];
  latencyMs: number | null;
  configRevision: number;
};

/** What `frp_profiles_list` returns. */
export type FrpProfilesView = {
  profiles: FrpProfile[];
  prefs: FrpPrefs;
  logDir: string;
};

/** One profile a batch action could not complete. */
export type BatchFailure = { profileId: string; error: FrpError };

/** What the start-all / stop-all commands return. */
export type BatchResult = { succeeded: string[]; failed: BatchFailure[] };

/** The redacted TOML preview for one profile. */
export type ConfigPreview = {
  profileId: string;
  content: string;
  redacted: boolean;
  tunnelCount: number;
};

/** What `frp_config_verify` returns after running `frpc verify`. */
export type ConfigVerifyResult = {
  valid: boolean;
  message: string;
  rawOutput: string;
  configPath: string;
  sha256: string;
};

/** Where an imported frpc configuration comes from. */
export type FrpImportSource = { kind: "text"; content: string } | { kind: "file"; path: string };

/**
 * One proxy an import would create, shaped like the tunnel form's data. The
 * public address is derived in the UI, since a preview has no saved profile.
 */
export type FrpImportTunnel = {
  name: string;
  type: TunnelType;
  enabled: boolean;
  localIp: string;
  localPort: number;
  options: TunnelOptions;
};

/** What `frp_config_import_preview` reports before anything is written. */
export type FrpImportPreview = {
  serverAddr: string;
  serverPort: number;
  /** Whether the config carries a token; the value itself is never returned. */
  tokenPresent: boolean;
  tunnels: FrpImportTunnel[];
  warnings: string[];
};

/** Arguments for the one-shot import that creates a profile and its tunnels. */
export type FrpImportInput = {
  source: FrpImportSource;
  name?: string;
  applyToken: boolean;
  runtimePolicy: RuntimePolicy;
  runtimeId?: string | null;
};

/** What `frp_config_import` returns after the profile and tunnels are saved. */
export type FrpImportResult = {
  profile: FrpProfile;
  tunnelCount: number;
  warnings: string[];
  tokenApplied: boolean;
};

export type LogStream = "stdout" | "stderr";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** One log line, as pushed by `frp:log` and returned by `frp_logs_recent`. */
export type LogEntry = {
  profileId: string;
  stream: LogStream;
  level: LogLevel;
  message: string;
  /** Unix milliseconds. */
  timestamp: number;
};

/** `frp:metrics` payload: latency and tunnel states only. */
export type MetricsEvent = {
  profileId: string;
  latencyMs: number | null;
  tunnelStates: TunnelRuntimeState[];
};
