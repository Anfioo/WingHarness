import { invokeCommand } from "../../base";
import type { AppConfig, ConfigView, ProxyStatus } from "./types";

/**
 * Emitted after a save, so other windows re-read the parts of the config they
 * draw — the sidebar's account menu follows the networked mode.
 */
export const CONFIG_CHANGED_EVENT = "config-changed";

export function getConfig(): Promise<ConfigView> {
  return invokeCommand("get_config", {});
}

/** The proxy in effect, including the system address in `system` mode. */
export function proxyStatus(): Promise<ProxyStatus> {
  return invokeCommand("proxy_status", {});
}

/** Saves the configuration and returns the reloaded view. */
export function saveConfig(config: AppConfig): Promise<ConfigView> {
  return invokeCommand("save_config", { config });
}

/**
 * Points the data directory at `dir`, or clears it when `null`.
 *
 * Takes effect on the next launch: the running app keeps the directory it
 * resolved at startup, so the change never splits data across two roots.
 */
export function setDataDir(dir: string | null): Promise<ConfigView> {
  return invokeCommand("set_data_dir", { dir });
}
