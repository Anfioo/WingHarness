import { invokeCommand } from "../../base";
import type { TrayMenuLayout, UpdateTrayMenuParams, UpdateTrayMenuResult } from "./types";

export function updateTrayMenu(params: UpdateTrayMenuParams): Promise<UpdateTrayMenuResult> {
  return invokeCommand("update_tray_menu", params);
}

export function setTrayMenuExpanded(expanded: boolean): Promise<TrayMenuLayout> {
  return invokeCommand<{ expanded: boolean }, TrayMenuLayout>("tray_menu_set_expanded", {
    expanded,
  });
}

/** Quits the app, from the tray menu's own window. */
export function quitApp(): Promise<void> {
  return invokeCommand("quit_app", {});
}
