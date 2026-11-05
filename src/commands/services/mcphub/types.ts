/**
 * Shared view types for the MCP Hub frontend, mirroring the Rust command
 * contract. The backend serializes every view struct with
 * `#[serde(rename_all = "camelCase")]`, so field names here are camelCase to
 * match what actually comes over the wire.
 */

export type McpHubMode = "discover" | "passthrough";

export interface McpHubStatus {
  running: boolean;
  /** Bound SSE port, or null while the gateway is stopped. */
  port: number | null;
  mode: McpHubMode;
  serverCount: number;
  toolCount: number;
  uptimeMs: number;
}

export interface ServerView {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  running: boolean;
  toolCount: number;
  healthy: boolean;
  lastLatencyMs?: number | null;
  lastCallAt?: number | null;
}

/** Payload for add/update_server commands. */
export interface ServerConfigInput {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  pool: number;
}

export interface ToolView {
  server: string;
  name: string;
  description: string;
  enabled: boolean;
}

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  server?: string | null;
  message: string;
}

export interface TokenView {
  token: string;
  name: string;
  allowedServers?: string[] | null;
  createdAt: number;
}

export interface EndpointInfo {
  sseUrl: string;
  stdioAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Metrics / settings / JSON import
// ---------------------------------------------------------------------------

export interface ServerMetricView {
  name: string;
  requests: number;
  errors: number;
  avgLatencyMs?: number | null;
  lastCallAt?: number | null;
  healthy: boolean;
  running: boolean;
}

export interface MetricsView {
  totalRequests: number;
  activeSessions: number;
  uptimeSecs: number;
  servers: ServerMetricView[];
}

export interface SettingsView {
  mode: McpHubMode;
  idleTimeout: number;
  cacheTools: number;
  cacheServers: number;
}

export interface ImportServersResult {
  ok: number;
  failed: number;
  tools: number;
}
