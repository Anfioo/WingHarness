import { invokeCommand } from "../../base";
import type {
  TrayAppsView,
  TrayMenuLayout,
  UpdateTrayMenuParams,
  UpdateTrayMenuResult,
} from "./types";

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

/** The apps the tray's second-level menu offers, with their curation lists. */
export function trayAppsList(): Promise<TrayAppsView> {
  return invokeCommand<Record<string, never>, TrayAppsView>("tray_apps_list", {});
}

/** Replaces the pin, hide and order lists; the tray reads them on its next open. */
export function trayAppsSave(pinned: string[], hidden: string[], order: string[]): Promise<void> {
  return invokeCommand<{ pinned: string[]; hidden: string[]; order: string[] }, void>(
    "tray_apps_save",
    { pinned, hidden, order }
  );
}
