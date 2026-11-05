// DTOs and error discrimination for the server manager.
//
// Mirrors `server-core/src/models.rs` and `server-core/src/error.rs`. Every field
// is camelCase on the wire. Credentials are plain text in this DTO by explicit
// user request: the engine reads and writes them straight from `servers.json`.

/** Stable error codes returned by every `server_*` command. */
export type ServerErrorCode =
  | "host-key-unknown"
  | "host-key-mismatch"
  | "auth-failed"
  | "connect-timeout"
  | "not-connected"
  | "file-too-large"
  | "path-invalid"
  | "not-found"
  | "permission-denied"
  | "transfer-not-found"
  | "conflict-requires-choice"
  | "not-implemented"
  | "internal";

/** Shape of a rejected `server_*` command. */
export type ServerError = {
  code: ServerErrorCode;
  message: string;
  detail: Record<string, unknown> | null;
};

const SERVER_ERROR_CODES = new Set<string>([
  "host-key-unknown",
  "host-key-mismatch",
  "auth-failed",
  "connect-timeout",
  "not-connected",
  "file-too-large",
  "path-invalid",
  "not-found",
  "permission-denied",
  "transfer-not-found",
  "conflict-requires-choice",
  "not-implemented",
  "internal",
]);

/** Narrow a rejected command to the engine's error type. */
export function isServerError(value: unknown): value is ServerError {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && SERVER_ERROR_CODES.has(code);
}

/** `code` of a rejected command, or `null` when it came from somewhere else. */
export function serverErrorCode(value: unknown): ServerErrorCode | null {
  return isServerError(value) ? value.code : null;
}

export type AuthKind = "password" | "privateKey";

export type SecretKind = "password" | "passphrase";

export type ConflictPolicy = "ask" | "overwrite" | "skip" | "rename";

export type EntryKind = "file" | "dir";

export type TransferDirection = "upload" | "download";

export type TransferState = "pending" | "running" | "paused" | "done" | "failed" | "cancelled";

export type ConnectionState = "idle" | "connecting" | "ready" | "failed";

/** A saved server. `password`, `passphrase` and `privateKey` hold plain text as
 * stored in `servers.json`; the UI masks the password fields by default. */
export type ServerProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: AuthKind;
  privateKey: string | null;
  password: string | null;
  passphrase: string | null;
  terminalType: string;
  note: string;
  color: string;
  createdAt: number;
  updatedAt: number;
  lastConnectedAt: number | null;
};

/** The editable half of a profile, as the create/update form sends it. */
export type ServerProfileInput = {
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: AuthKind;
  privateKey: string | null;
  password: string | null;
  passphrase: string | null;
  terminalType?: string | null;
  note?: string | null;
  color?: string | null;
};

export type ServerPrefs = {
  localPanePath: string | null;
  showHiddenLocal: boolean;
  showHiddenRemote: boolean;
  conflictPolicy: ConflictPolicy;
  maxConcurrentTransfers: number;
};

export type ServerProfilesView = {
  profiles: ServerProfile[];
  prefs: ServerPrefs;
};

export type HostKeyRecord = {
  fingerprint: string;
  algorithm: string;
  host: string;
  port: number;
  trustedAt: number;
};

/** One row of a directory listing, local or remote. */
export type SftpEntry = {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  permissions: string | null;
  modifiedAt: number | null;
  isSymlink: boolean;
};

export type SessionInfo = {
  sessionId: string;
  profileId: string;
  cols: number;
  rows: number;
  startedAt: number;
};

export type ConnectOutcome = {
  sessionId: string;
  connectionId: string;
  reused: boolean;
};

export type TransferSnapshot = {
  transferId: string;
  profileId: string;
  direction: TransferDirection;
  source: string;
  target: string;
  transferred: number;
  total: number;
  bytesPerSec: number;
  state: TransferState;
  error: string | null;
};

/** Payload of `server:output`. `data` is base64 of the raw bytes. */
export type ServerOutputEvent = { sessionId: string; data: string };

/** Payload of `server:exit`. */
export type ServerExitEvent = { sessionId: string; reason: string | null };

/** Payload of `server:transfer-progress` (throttled to 100 ms). */
export type ServerTransferProgressEvent = {
  transferId: string;
  profileId: string;
  transferred: number;
  total: number;
  bytesPerSec: number;
  state: TransferState;
};

/** Payload of `server:transfer-done`. */
export type ServerTransferDoneEvent = {
  transferId: string;
  state: TransferState;
  error: string | null;
};

/** CPU percentages; the first sample of a connection reports zeros. */
export type CpuMetrics = {
  overall: number;
  user: number;
  system: number;
  iowait: number;
  steal: number;
};

/** Memory in bytes; `percent` is `used / total * 100`. */
export type MemoryMetrics = {
  total: number;
  used: number;
  available: number;
  swapTotal: number;
  swapUsed: number;
  percent: number;
};

/** Root filesystem usage and whole-disk I/O in bytes per second. */
export type DiskMetrics = {
  total: number;
  used: number;
  percent: number;
  inodePercent: number;
  readBytesPerSec: number;
  writeBytesPerSec: number;
};

/** Aggregate throughput over every interface except loopback, in bytes/s. */
export type NetworkMetrics = {
  rxBytesPerSec: number;
  txBytesPerSec: number;
};

export type LoadMetrics = {
  one: number;
  five: number;
  fifteen: number;
};

/** One metrics snapshot, taken once per second while connected. */
export type MetricsSample = {
  /** Seconds since the Unix epoch. */
  at: number;
  /** Round-trip time of the metrics script, in milliseconds. */
  latencyMs: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disk: DiskMetrics;
  network: NetworkMetrics;
  load: LoadMetrics;
  uptimeSecs: number;
  processes: number;
  threads: number;
};

/** Payload of `server:metrics`. */
export type ServerMetricsEvent = { profileId: string; sample: MetricsSample };
