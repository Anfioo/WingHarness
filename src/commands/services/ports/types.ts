// DTOs and error discrimination for the ports page.
//
// Mirrors `ports-core/src/models.rs` and `ports-core/src/error.rs`. Every field
// is camelCase on the wire; status and protocol stay lowercase.

export type PortStatus = "free" | "occupied" | "system";

export type Protocol = "tcp";

/** Persisted settings: the pinned port numbers and the "pinned only" view. */
export type PortsSettings = {
  /** Pinned port numbers, ascending, at most 50. */
  pinnedPorts: number[];
  pinnedOnly: boolean;
};

export type ProcessBrief = {
  pid: number;
  name: string;
};

export type PortEntry = {
  port: number;
  status: PortStatus;
  protocol: Protocol;
  /** The local listen address, or null for a pinned port nothing listens on. */
  address: string | null;
  process: ProcessBrief | null;
};

export type ProcessDetail = {
  pid: number;
  name: string;
  path: string | null;
  command: string | null;
  workingDir: string | null;
  memoryBytes: number | null;
  /** Unix seconds. */
  startedAt: number | null;
  user: string | null;
};

export type PortDetail = {
  port: number;
  status: PortStatus;
  protocol: Protocol;
  address: string | null;
  process: ProcessDetail | null;
};

/** Stable error codes returned by every `ports_*` command. */
export type PortsErrorCode =
  | "not-found"
  | "invalid-input"
  | "access-denied"
  | "elevation-cancelled"
  | "elevation-failed"
  | "not-implemented"
  | "internal";

/** Shape of a rejected `ports_*` command. */
export type PortsError = {
  code: PortsErrorCode;
  message: string;
  detail: Record<string, unknown> | null;
};

const PORTS_ERROR_CODES = new Set<string>([
  "not-found",
  "invalid-input",
  "access-denied",
  "elevation-cancelled",
  "elevation-failed",
  "not-implemented",
  "internal",
]);

/** Narrow a rejected command to the engine's error type. */
export function isPortsError(value: unknown): value is PortsError {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && PORTS_ERROR_CODES.has(code);
}

/** `code` of a rejected command, or `"unknown"` when it came from somewhere else. */
export function portsErrorCode(error: unknown): PortsErrorCode | "unknown" {
  return isPortsError(error) ? error.code : "unknown";
}

export const DEFAULT_PINNED_PORTS: number[] = [3000, 5173, 8080, 5432, 27017];

export const MAX_PINNED_PORTS = 50;
