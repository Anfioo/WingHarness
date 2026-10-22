import { invokeCommand } from "../../base";
import type { AppConfig, ConfigView } from "./types";

export function getConfig(): Promise<ConfigView> {
  return invokeCommand("get_config", {});
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
