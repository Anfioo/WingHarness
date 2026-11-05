// FRP console command service.
//
// Thin, one-to-one wrappers over the `frp-core` Rust commands. Argument keys
// are camelCase here; Tauri maps them onto the snake_case Rust parameters. This
// module is frozen: the lanes use it as-is.
//
// Rejected calls throw the engine's `{ code, message, detail }` object; use
// `isFrpError` / `frpErrorCode` from `./types` to branch on `code`.

import { invokeCommand } from "../../base";
import type {
  BatchResult,
  ConfigPreview,
  ConfigVerifyResult,
  ConnectionSnapshot,
  DiscoveredRuntime,
  FrpImportInput,
  FrpImportPreview,
  FrpImportResult,
  FrpImportSource,
  FrpProfile,
  FrpProfileInput,
  FrpProfilesView,
  LogEntry,
  RuntimeProbe,
  RuntimeRecord,
  RuntimeView,
  Tunnel,
  TunnelInput,
  TunnelView,
} from "./types";

// Profiles.

export async function frpProfilesList(): Promise<FrpProfilesView> {
  return await invokeCommand<Record<string, never>, FrpProfilesView>("frp_profiles_list", {});
}

export async function frpProfileCreate(input: FrpProfileInput): Promise<FrpProfile> {
  return await invokeCommand<{ input: FrpProfileInput }, FrpProfile>("frp_profile_create", {
    input,
  });
}

export async function frpProfileUpdate(id: string, input: FrpProfileInput): Promise<FrpProfile> {
  return await invokeCommand<{ id: string; input: FrpProfileInput }, FrpProfile>(
    "frp_profile_update",
    { id, input }
  );
}

/** Stops the profile's process first, then cascades to tunnels, config and logs. */
export async function frpProfileDelete(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("frp_profile_delete", { id });
}

export async function frpProfileReorder(ids: string[]): Promise<void> {
  return await invokeCommand<{ ids: string[] }, void>("frp_profile_reorder", { ids });
}

// Tunnels.

/** `profileId: null` lists tunnels of every profile. */
export async function frpTunnelsList(profileId: string | null = null): Promise<TunnelView[]> {
  return await invokeCommand<{ profileId: string | null }, TunnelView[]>("frp_tunnels_list", {
    profileId,
  });
}

export async function frpTunnelCreate(input: TunnelInput): Promise<Tunnel> {
  return await invokeCommand<{ input: TunnelInput }, Tunnel>("frp_tunnel_create", { input });
}

export async function frpTunnelUpdate(id: string, input: TunnelInput): Promise<Tunnel> {
  return await invokeCommand<{ id: string; input: TunnelInput }, Tunnel>("frp_tunnel_update", {
    id,
    input,
  });
}

export async function frpTunnelDelete(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("frp_tunnel_delete", { id });
}

// Runtimes.

export async function frpRuntimesList(): Promise<RuntimeView[]> {
  return await invokeCommand<Record<string, never>, RuntimeView[]>("frp_runtimes_list", {});
}

/** Inspects one path without persisting anything. */
export async function frpRuntimeProbe(path: string): Promise<RuntimeProbe> {
  return await invokeCommand<{ path: string }, RuntimeProbe>("frp_runtime_probe", { path });
}

export async function frpRuntimeImport(path: string): Promise<RuntimeRecord> {
  return await invokeCommand<{ path: string }, RuntimeRecord>("frp_runtime_import", { path });
}

export async function frpRuntimeDelete(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("frp_runtime_delete", { id });
}

/** Scans common locations; `deep` also walks the whole disk. */
export async function frpRuntimesDiscover(deep = false): Promise<DiscoveredRuntime[]> {
  return await invokeCommand<{ deep: boolean }, DiscoveredRuntime[]>("frp_runtimes_discover", {
    deep,
  });
}

// Processes.

export async function frpStart(profileId: string): Promise<ConnectionSnapshot> {
  return await invokeCommand<{ profileId: string }, ConnectionSnapshot>("frp_start", {
    profileId,
  });
}

export async function frpStop(profileId: string): Promise<ConnectionSnapshot> {
  return await invokeCommand<{ profileId: string }, ConnectionSnapshot>("frp_stop", {
    profileId,
  });
}

export async function frpRestart(profileId: string): Promise<ConnectionSnapshot> {
  return await invokeCommand<{ profileId: string }, ConnectionSnapshot>("frp_restart", {
    profileId,
  });
}

export async function frpStartAll(): Promise<BatchResult> {
  return await invokeCommand<Record<string, never>, BatchResult>("frp_start_all", {});
}

export async function frpStopAll(): Promise<BatchResult> {
  return await invokeCommand<Record<string, never>, BatchResult>("frp_stop_all", {});
}

export async function frpConnectionsList(): Promise<ConnectionSnapshot[]> {
  return await invokeCommand<Record<string, never>, ConnectionSnapshot[]>(
    "frp_connections_list",
    {}
  );
}

/** Forces an immediate health probe and returns how many processes were probed. */
export async function frpNudgeHealth(): Promise<number> {
  return await invokeCommand<Record<string, never>, number>("frp_nudge_health", {});
}

// Config.

/** The generated TOML with every token and secret key redacted. */
export async function frpConfigPreview(profileId: string): Promise<ConfigPreview> {
  return await invokeCommand<{ profileId: string }, ConfigPreview>("frp_config_preview", {
    profileId,
  });
}

export async function frpConfigVerify(profileId: string): Promise<ConfigVerifyResult> {
  return await invokeCommand<{ profileId: string }, ConfigVerifyResult>("frp_config_verify", {
    profileId,
  });
}

/**
 * Parses an existing frpc config without writing anything. The result reports
 * whether a token was found, never the token itself.
 */
export async function frpConfigImportPreview(source: FrpImportSource): Promise<FrpImportPreview> {
  return await invokeCommand<{ source: FrpImportSource }, FrpImportPreview>(
    "frp_config_import_preview",
    { source }
  );
}

/** Creates one profile and its tunnels from an existing config, in one call. */
export async function frpConfigImport(input: FrpImportInput): Promise<FrpImportResult> {
  return await invokeCommand<FrpImportInput, FrpImportResult>("frp_config_import", input);
}

// Logs.

/** `profileId: null` reads every profile; `limit: null` uses the engine default. */
export async function frpLogsRecent(
  profileId: string | null = null,
  limit: number | null = null
): Promise<LogEntry[]> {
  return await invokeCommand<{ profileId: string | null; limit: number | null }, LogEntry[]>(
    "frp_logs_recent",
    { profileId, limit }
  );
}

/** `profileId: null` clears every profile's log files. */
export async function frpLogsClear(profileId: string | null = null): Promise<void> {
  return await invokeCommand<{ profileId: string | null }, void>("frp_logs_clear", {
    profileId,
  });
}
