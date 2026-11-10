// Ports command service.
//
// Thin, one-to-one wrappers over the `ports-core` Rust commands. Argument keys
// are camelCase here; Tauri maps them onto the snake_case Rust parameters. This
// module is frozen: the component lanes use it as-is.
//
// Rejected calls throw the engine's `{ code, message, detail }` object; use
// `isPortsError` / `portsErrorCode` from `./types` to branch on `code`.

import { invokeCommand } from "../../base";
import type { PortDetail, PortEntry, PortsSettings } from "./types";

export async function portsSettingsGet(): Promise<PortsSettings> {
  return await invokeCommand<Record<string, never>, PortsSettings>("ports_settings_get", {});
}

/** Returns the normalized settings the engine persisted. */
export async function portsSettingsSet(settings: PortsSettings): Promise<PortsSettings> {
  return await invokeCommand<{ settings: PortsSettings }, PortsSettings>("ports_settings_set", {
    settings,
  });
}

export async function portsList(): Promise<PortEntry[]> {
  return await invokeCommand<Record<string, never>, PortEntry[]>("ports_list", {});
}

/** Pinned ports; ones nothing listens on come back as `free` placeholders. */
export async function portsPinnedScan(ports: number[]): Promise<PortEntry[]> {
  return await invokeCommand<{ ports: number[] }, PortEntry[]>("ports_pinned_scan", { ports });
}

export async function portsDetail(port: number): Promise<PortDetail | null> {
  return await invokeCommand<{ port: number }, PortDetail | null>("ports_detail", { port });
}

export async function portsKill(pid: number): Promise<void> {
  return await invokeCommand<{ pid: number }, void>("ports_kill", { pid });
}

/** Ends the process through one UAC prompt; the caller passes a PID only. */
export async function portsKillElevated(pid: number): Promise<void> {
  return await invokeCommand<{ pid: number }, void>("ports_kill_elevated", { pid });
}
