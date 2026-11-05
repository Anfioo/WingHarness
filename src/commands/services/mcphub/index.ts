import { invokeCommand } from "../../base";
import type {
  EndpointInfo,
  ImportServersResult,
  LogEntry,
  LogLevel,
  McpHubMode,
  McpHubStatus,
  MetricsView,
  ServerConfigInput,
  ServerView,
  SettingsView,
  TokenView,
  ToolView,
} from "./types";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function mcphubStatus(): Promise<McpHubStatus> {
  return invokeCommand("mcphub_status", {});
}

export function mcphubStart(): Promise<void> {
  return invokeCommand("mcphub_start", {});
}

export function mcphubStop(): Promise<void> {
  return invokeCommand("mcphub_stop", {});
}

export function mcphubSetMode(mode: McpHubMode): Promise<void> {
  return invokeCommand("mcphub_set_mode", { mode });
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export function mcphubListServers(): Promise<ServerView[]> {
  return invokeCommand("mcphub_list_servers", {});
}

export function mcphubAddServer(input: ServerConfigInput): Promise<void> {
  return invokeCommand("mcphub_add_server", input);
}

export function mcphubUpdateServer(input: ServerConfigInput): Promise<void> {
  return invokeCommand("mcphub_update_server", input);
}

export function mcphubRemoveServer(name: string): Promise<void> {
  return invokeCommand("mcphub_remove_server", { name });
}

export function mcphubSetServerEnabled(name: string, enabled: boolean): Promise<void> {
  return invokeCommand("mcphub_set_server_enabled", { name, enabled });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function mcphubListTools(serverName?: string): Promise<ToolView[]> {
  // Tauri maps camelCase JS keys onto the Rust `server_name` parameter.
  return invokeCommand("mcphub_list_tools", { serverName: serverName ?? null });
}

export function mcphubSetToolEnabled(
  server: string,
  tool: string,
  enabled: boolean
): Promise<void> {
  return invokeCommand("mcphub_set_tool_enabled", { server, tool, enabled });
}

// ---------------------------------------------------------------------------
// Logs & cache
// ---------------------------------------------------------------------------

export function mcphubRegenerateCache(): Promise<void> {
  return invokeCommand("mcphub_regenerate_cache", {});
}

export function mcphubRecentLogs(options: {
  server?: string;
  level?: LogLevel;
  limit: number;
}): Promise<LogEntry[]> {
  return invokeCommand("mcphub_recent_logs", {
    server: options.server ?? null,
    level: options.level ?? null,
    limit: options.limit,
  });
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function mcphubListTokens(): Promise<TokenView[]> {
  return invokeCommand("mcphub_list_tokens", {});
}

export function mcphubCreateToken(input: {
  name: string;
  allowedServers?: string[];
}): Promise<{ token: string }> {
  return invokeCommand("mcphub_create_token", {
    name: input.name,
    allowedServers: input.allowedServers ?? null,
  });
}

export function mcphubRevokeToken(token: string): Promise<void> {
  return invokeCommand("mcphub_revoke_token", { token });
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

export function mcphubEndpointInfo(): Promise<EndpointInfo> {
  return invokeCommand("mcphub_endpoint_info", {});
}

// ---------------------------------------------------------------------------
// Metrics / settings / JSON import
// ---------------------------------------------------------------------------

export function mcphubMetrics(): Promise<MetricsView> {
  return invokeCommand("mcphub_metrics", {});
}

export function mcphubGetSettings(): Promise<SettingsView> {
  return invokeCommand("mcphub_get_settings", {});
}

export function mcphubUpdateSettings(input: {
  mode?: McpHubMode;
  idleTimeout?: number;
}): Promise<void> {
  // Tauri maps camelCase JS keys onto the Rust `idle_timeout_secs` parameter.
  return invokeCommand("mcphub_update_settings", {
    mode: input.mode ?? null,
    idleTimeoutSecs: input.idleTimeout ?? null,
  });
}

export function mcphubImportServers(input: { json: string }): Promise<ImportServersResult> {
  return invokeCommand("mcphub_import_servers", input);
}
