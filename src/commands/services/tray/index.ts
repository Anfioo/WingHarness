import { invokeCommand } from "../../base";
import type { UpdateTrayMenuParams, UpdateTrayMenuResult } from "./types";

export function updateTrayMenu(params: UpdateTrayMenuParams): Promise<UpdateTrayMenuResult> {
  return invokeCommand("update_tray_menu", params);
}

/** Quits the app, from the tray menu's own window. */
export function quitApp(): Promise<void> {
  return invokeCommand("quit_app", {});
}
