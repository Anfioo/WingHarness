import { Channel } from "@tauri-apps/api/core";
import { invokeCommand } from "../../base";
import type { PluginOutputEvent, PluginView } from "./types";

/** Every installed plugin, including folders whose manifest will not parse. */
export function pluginsList(): Promise<PluginView[]> {
  return invokeCommand("plugins_list", {});
}

/**
 * Installs a plugin from the added Scoop buckets.
 *
 * The install is Scoop's `scoop install <app>`, and its output streams on
 * `onEvent` into the same panel a run uses. The plugin arrives disabled, so
 * installing cannot run anything.
 */
export function pluginsInstall(
  app: string,
  onEvent: (event: PluginOutputEvent) => void
): Promise<PluginView> {
  const channel = new Channel<PluginOutputEvent>();
  channel.onmessage = onEvent;
  return invokeCommand("plugins_install", { app, onEvent: channel });
}

/** Updates a plugin to the version its bucket now names. */
export function pluginsUpdate(
  id: string,
  onEvent: (event: PluginOutputEvent) => void
): Promise<void> {
  const channel = new Channel<PluginOutputEvent>();
  channel.onmessage = onEvent;
  return invokeCommand("plugins_update", { id, onEvent: channel });
}

/**
 * Uninstalls a plugin through Scoop.
 *
 * Its persist folder — the user's settings — is kept, so reinstalling the same
 * app brings them back.
 */
export function pluginsUninstall(
  id: string,
  onEvent: (event: PluginOutputEvent) => void
): Promise<void> {
  const channel = new Channel<PluginOutputEvent>();
  channel.onmessage = onEvent;
  return invokeCommand("plugins_uninstall", { id, onEvent: channel });
}

export function pluginsSetEnabled(id: string, enabled: boolean): Promise<void> {
  return invokeCommand("plugins_set_enabled", { id, enabled });
}

/**
 * Writes the user's edits into one of a plugin's config files.
 *
 * Only keys the manifest declares are touched; comments and undeclared content
 * in the file survive.
 */
export function pluginsSaveFileConfig(
  id: string,
  path: string,
  values: Record<string, unknown>
): Promise<void> {
  return invokeCommand("plugins_save_file_config", { id, path, values });
}

/** Opens one of a plugin's config files in its default editor. */
export function pluginsOpenFile(id: string, path: string): Promise<void> {
  return invokeCommand("plugins_open_file", { id, path });
}

/** Opens a plugin's folder, or the plugins folder itself when `id` is omitted. */
export function pluginsOpenDir(id?: string): Promise<void> {
  return invokeCommand("plugins_open_dir", { id: id ?? null });
}

/**
 * Opens the durable log the app keeps of a plugin's runs.
 *
 * The file is created when it does not exist yet, so this always opens
 * something.
 */
export function pluginsOpenLog(id: string): Promise<void> {
  return invokeCommand("plugins_open_log", { id });
}

/** Runs one plugin, streaming its output. */
export function pluginsRun(id: string, onEvent: (event: PluginOutputEvent) => void): Promise<void> {
  const channel = new Channel<PluginOutputEvent>();
  channel.onmessage = onEvent;
  return invokeCommand("plugins_run", { id, onEvent: channel });
}

/** Runs every enabled plugin in turn, streaming their combined output. */
export function pluginsRunAll(onEvent: (event: PluginOutputEvent) => void): Promise<void> {
  const channel = new Channel<PluginOutputEvent>();
  channel.onmessage = onEvent;
  return invokeCommand("plugins_run_all", { onEvent: channel });
}

/**
 * Starts a plugin in the background so it can serve its page.
 *
 * Resolves to `false` when a copy was already running, which is the normal
 * answer on a second visit and not a failure.
 */
export function pluginsStart(id: string): Promise<boolean> {
  return invokeCommand("plugins_start", { id });
}

/** Stops a plugin started with {@link pluginsStart}. Resolves to whether one was running. */
export function pluginsStop(id: string): Promise<boolean> {
  return invokeCommand("plugins_stop", { id });
}

/** Ids of the plugins the app currently has running. */
export function pluginsRunning(): Promise<string[]> {
  return invokeCommand("plugins_running", {});
}

/** Whether a plugin's page is accepting connections yet. */
export function pluginsProbe(url: string): Promise<boolean> {
  return invokeCommand("plugins_probe", { url });
}
