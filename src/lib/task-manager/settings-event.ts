// Cross-window task manager settings events.
//
// The backend broadcasts every persisted change so the page, the settings
// window and the tray row stay in step without polling. The settings window
// additionally accepts a section deep link from the main window.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ArgusSettings } from "@/commands";

/** Backend → every window: the persisted task manager settings changed. */
export const TASK_MANAGER_SETTINGS_EVENT = "argus-settings-changed";

/** Any window → settings window: switch to the named section. */
export const SETTINGS_SECTION_EVENT = "settings-section";

export type SettingsSectionPayload = { section: string };

/** Subscribes to settings changes; resolves with the unlisten function. */
export function subscribeTaskManagerSettings(
  listener: (settings: ArgusSettings) => void
): Promise<UnlistenFn> {
  return listen<ArgusSettings>(TASK_MANAGER_SETTINGS_EVENT, (event) => {
    listener(event.payload);
  });
}
