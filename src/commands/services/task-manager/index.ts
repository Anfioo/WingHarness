// Task manager command service.
//
// Thin, one-to-one wrappers over the `argus_*` Rust commands. Argument keys are
// camelCase here; Tauri maps them onto the snake_case Rust parameters. This
// module is frozen for W1: components and the page hook use it as-is.
//
// Rejected calls throw the engine's `{ code, message, detail? }` object; use
// `isArgusError` and `argusErrorKey` to translate it.

import { Channel } from "@tauri-apps/api/core";
import { invokeCommand } from "../../base";
import type {
  ArgusError,
  ArgusErrorCode,
  ArgusSettings,
  Connection,
  HistoryMoment,
  HistoryPoint,
  HistoryUsage,
  Priority,
  ProcessDetails,
  ServiceAction,
  ServiceInfo,
  ServiceStartType,
  ServiceStatus,
  Snapshot,
  StartupItem,
  TreeKillReport,
} from "./types";

/**
 * Subscribe to snapshots and start sampling. The caller owns the channel, so
 * it also decides when frames stop being consumed.
 */
export function argusSnapshotStart(channel: Channel<Snapshot>, intervalMs: number): Promise<void> {
  return invokeCommand<{ channel: Channel<Snapshot>; intervalMs: number }, void>(
    "argus_snapshot_start",
    { channel, intervalMs }
  );
}

export function argusSnapshotStop(): Promise<void> {
  return invokeCommand<Record<string, never>, void>("argus_snapshot_stop", {});
}

/** Change the sampling interval; returns the normalized settings. */
export function argusSetInterval(intervalMs: number): Promise<ArgusSettings> {
  return invokeCommand<{ intervalMs: number }, ArgusSettings>("argus_set_interval", { intervalMs });
}

/** Ask for an immediate frame instead of waiting for the next tick. */
export function argusRefresh(): Promise<void> {
  return invokeCommand<Record<string, never>, void>("argus_refresh", {});
}

export function argusSettingsGet(): Promise<ArgusSettings> {
  return invokeCommand<Record<string, never>, ArgusSettings>("argus_settings_get", {});
}

/** Returns the normalized settings that were persisted. */
export function argusSettingsSet(settings: ArgusSettings): Promise<ArgusSettings> {
  return invokeCommand<{ settings: ArgusSettings }, ArgusSettings>("argus_settings_set", {
    settings,
  });
}

export function argusStartupList(): Promise<StartupItem[]> {
  return invokeCommand<Record<string, never>, StartupItem[]>("argus_startup_list", {});
}

export function argusStartupSetEnabled(id: string, enabled: boolean): Promise<void> {
  return invokeCommand<{ id: string; enabled: boolean }, void>("argus_startup_set_enabled", {
    id,
    enabled,
  });
}

export function argusConnectionsList(): Promise<Connection[]> {
  return invokeCommand<Record<string, never>, Connection[]>("argus_connections_list", {});
}

/** Resets an established IPv4 TCP connection. */
export function argusConnectionsClose(
  localAddress: string,
  localPort: number,
  remoteAddress: string,
  remotePort: number
): Promise<void> {
  return invokeCommand<
    {
      localAddress: string;
      localPort: number;
      remoteAddress: string;
      remotePort: number;
    },
    void
  >("argus_connections_close", { localAddress, localPort, remoteAddress, remotePort });
}

export function argusHistoryRange(): Promise<[number, number] | null> {
  return invokeCommand<Record<string, never>, [number, number] | null>("argus_history_range", {});
}

export function argusHistorySeries(
  from: number,
  to: number,
  buckets: number
): Promise<HistoryPoint[]> {
  return invokeCommand<{ from: number; to: number; buckets: number }, HistoryPoint[]>(
    "argus_history_series",
    { from, to, buckets }
  );
}

export function argusHistoryMoment(ts: number): Promise<HistoryMoment | null> {
  return invokeCommand<{ ts: number }, HistoryMoment | null>("argus_history_moment", { ts });
}

export function argusHistoryUsage(): Promise<HistoryUsage> {
  return invokeCommand<Record<string, never>, HistoryUsage>("argus_history_usage", {});
}

export function argusHistoryClear(): Promise<void> {
  return invokeCommand<Record<string, never>, void>("argus_history_clear", {});
}

/** Toggles background monitoring; returns the normalized settings. */
export function argusSetBackgroundMonitoring(enabled: boolean): Promise<ArgusSettings> {
  return invokeCommand<{ enabled: boolean }, ArgusSettings>("argus_set_background_monitoring", {
    enabled,
  });
}

export function argusProcessDetails(pid: number): Promise<ProcessDetails> {
  return invokeCommand<{ pid: number }, ProcessDetails>("argus_process_details", { pid });
}

/**
 * A resolved process icon as a PNG data URL, or `null` while its metadata is
 * still being resolved. Cache the result by id; the id stays valid for the
 * life of the page.
 */
export function argusIcon(id: number): Promise<string | null> {
  return invokeCommand<{ id: number }, string | null>("argus_icon", { id });
}

export function argusKillProcess(pid: number, createTime: number, force: boolean): Promise<void> {
  return invokeCommand<{ pid: number; createTime: number; force: boolean }, void>(
    "argus_kill_process",
    { pid, createTime, force }
  );
}

export function argusKillProcessTree(pid: number, createTime: number): Promise<TreeKillReport> {
  return invokeCommand<{ pid: number; createTime: number }, TreeKillReport>(
    "argus_kill_process_tree",
    { pid, createTime }
  );
}

/** Returns the priority the process actually ended up with. */
export function argusSetPriority(
  pid: number,
  createTime: number,
  priority: Priority
): Promise<Priority> {
  return invokeCommand<{ pid: number; createTime: number; priority: Priority }, Priority>(
    "argus_set_priority",
    { pid, createTime, priority }
  );
}

export function argusSetEfficiency(pid: number, createTime: number, on: boolean): Promise<void> {
  return invokeCommand<{ pid: number; createTime: number; on: boolean }, void>(
    "argus_set_efficiency",
    { pid, createTime, on }
  );
}

export function argusServiceStatus(): Promise<ServiceStatus> {
  return invokeCommand<Record<string, never>, ServiceStatus>("argus_service_status", {});
}

/** Install, uninstall or update the privileged service through one UAC prompt. */
export function argusServiceManage(
  action: "install" | "uninstall" | "update"
): Promise<ServiceStatus> {
  return invokeCommand<{ action: string }, ServiceStatus>("argus_service_manage", { action });
}

/** Every service the SCM reports, with its cached configuration. */
export function argusServicesList(): Promise<ServiceInfo[]> {
  return invokeCommand<Record<string, never>, ServiceInfo[]>("argus_services_list", {});
}

/** Start, stop or restart one service. Resolves once the SCM accepted it. */
export function argusServiceControl(name: string, action: ServiceAction): Promise<void> {
  return invokeCommand<{ name: string; action: ServiceAction }, void>("argus_service_control", {
    name,
    action,
  });
}

export function argusServiceStartType(name: string, startType: ServiceStartType): Promise<void> {
  return invokeCommand<{ name: string; startType: ServiceStartType }, void>(
    "argus_service_start_type",
    { name, startType }
  );
}

/** Open the Windows Services console in a separate process. */
export function argusServicesConsole(): Promise<void> {
  return invokeCommand<Record<string, never>, void>("argus_services_console", {});
}

const ARGUS_ERROR_CODES = new Set<string>([
  "not-found",
  "invalid-input",
  "access-denied",
  "service-unavailable",
  "internal",
]);

/** Narrow a rejected command to the engine's error type. */
export function isArgusError(value: unknown): value is ArgusError {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && ARGUS_ERROR_CODES.has(code);
}

/** The i18n key for an error code; `message` is only the fallback. */
export function argusErrorKey(code: ArgusErrorCode): string {
  return `taskManager.error.${code}`;
}

export type {
  ArgusError,
  ArgusErrorCode,
  ArgusSettings,
  Connection,
  HistoryMoment,
  HistoryPoint,
  HistoryProcess,
  HistoryUsage,
  Priority,
  ProcessDetails,
  ServiceAction,
  ServiceInfo,
  ServiceStartType,
  ServiceState,
  ServiceStatus,
  Snapshot,
  StartupItem,
  StartupItemLocation,
  TcpState,
  TreeKillReport,
} from "./types";
