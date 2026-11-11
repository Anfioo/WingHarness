// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

/**
 * Mirrors `src-tauri/moin-core/src/models.rs` field for field.
 *
 * The Rust side serialises structs as-is (snake_case), so these names must not
 * be camelCased. Adding, renaming or dropping a field here without the same
 * change in `models.rs` breaks the contract every other moin track relies on.
 */

export type MoinTaskKind = "http" | "media";

export type MoinTaskStatus =
  | "queued"
  | "connecting"
  | "downloading"
  | "paused"
  | "moving"
  | "completed"
  | "failed"
  | "stalled"
  | "canceled";

export interface MoinTask {
  id: string;
  kind: MoinTaskKind;
  url: string;
  filename: string;
  dest: string;
  status: MoinTaskStatus;
  total: number | null;
  received: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  archived: boolean;
  active_ms: number;
  backend: string | null;
  category: string | null;
  final_dir: string | null;
  headers: Record<string, string>;
}

export interface MoinTaskProgress {
  id: string;
  received: number;
  total: number | null;
  speed: number;
  status: MoinTaskStatus;
}

export interface MoinSettings {
  max_concurrent: number;
  connections: number;
  min_split_size: number;
  hide_part_files: boolean;
  stall_timeout_secs: number;
  connect_timeout_secs: number;
  download_dir: string | null;
  aria2_path: string | null;
  rpc_enabled: boolean;
  rpc_port: number;
  rpc_token: string;
  notify_on_complete: boolean;
  add_paused: boolean;
  progress_flush_ms: number;
}

export interface MoinCategory {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  hidden_from_all: boolean;
  save_dir: string | null;
  incomplete_dir: string | null;
  sources: MoinAddMethod[];
  triggers: MoinTrigger[];
  order: number;
  /** Unknown keys (a future BitTorrent port) round-trip untouched. */
  [legacyField: string]: unknown;
}

export type MoinTrigger =
  | { type: "extension"; exts: string[] }
  | { type: "size"; min: number | null; max: number | null }
  | { type: "url-pattern"; patterns: string[] }
  | { type: "name-pattern"; patterns: string[] };

export type MoinAddMethod = "manual-link" | "browser-capture";

export interface MoinBackendInfo {
  id: string;
  label: string;
  http: boolean;
  available: boolean;
}

export interface MoinToolStatus {
  id: string;
  present: boolean;
  path: string | null;
  version: string | null;
  source: MoinToolSource;
}

export type MoinToolSource = "override" | "env" | "path" | null;

export interface MoinRpcStatus {
  enabled: boolean;
  port: number;
  bound: boolean;
  address: string | null;
}

export type MoinErrorCode =
  | "not-found"
  | "invalid-input"
  | "conflict"
  | "io"
  | "backend-unavailable"
  | "not-implemented"
  | "internal";

export interface MoinError {
  code: MoinErrorCode;
  message: string;
  detail?: unknown;
}

const MOIN_ERROR_CODES: MoinErrorCode[] = [
  "not-found",
  "invalid-input",
  "conflict",
  "io",
  "backend-unavailable",
  "not-implemented",
  "internal",
];

/** A rejected invoke carries the serialised `MoinError` as its payload. */
export function isMoinError(value: unknown): value is MoinError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.message === "string" &&
    typeof candidate.code === "string" &&
    MOIN_ERROR_CODES.includes(candidate.code as MoinErrorCode)
  );
}

/** i18n key for a code; unknown codes fall back to `internal`. */
export function moinErrorKey(code: MoinErrorCode | undefined): string {
  return `moin.error.${code ?? "internal"}`;
}
