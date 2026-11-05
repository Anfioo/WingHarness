import { invokeCommand } from "../../base";
import type { SidebarConfig, SidebarCustomIcon } from "./types";

/** The saved layout, or `null` before it has ever been written. */
export function sidebarGet(): Promise<SidebarConfig | null> {
  return invokeCommand("sidebar_get", {});
}

/** Replaces the whole layout. */
export function sidebarSet(config: SidebarConfig): Promise<void> {
  return invokeCommand("sidebar_set", { config });
}

/** Every SVG in the icons folder; the folder is created when missing. */
export function sidebarIconsList(): Promise<SidebarCustomIcon[]> {
  return invokeCommand("sidebar_icons_list", {});
}

/** Where the SVG files are read from. */
export function sidebarIconsDir(): Promise<string> {
  return invokeCommand("sidebar_icons_dir", {});
}

/** Opens the icons folder in Explorer. */
export function sidebarIconsOpenDir(): Promise<void> {
  return invokeCommand("sidebar_icons_open_dir", {});
}
