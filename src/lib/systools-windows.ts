import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { SYSTOOLS_WINDOW_PATH, type SystoolsTab } from "@/lib/systools-routes";
import { createWindow, showWindow } from "@/lib/window";

/**
 * A single reusable window. Unlike the Git and SVN windows there is only ever
 * one systools window, so its label is fixed rather than derived from a path.
 */
const SYSTOOLS_WINDOW_LABEL = "systools";

/**
 * Tells an already-open systools window which tab to show. The frontend has no
 * cross-window navigation API, so the tab travels as an event the window's page
 * listens for instead of reloading its document.
 */
export const SYSTOOLS_TAB_EVENT = "systools-select-tab";

/**
 * Show the systools window, creating it the first time. Opening it again focuses
 * the window that is already on screen, and switches it to the requested tab
 * rather than stacking a second window.
 */
export async function openSystoolsWindow(tab: SystoolsTab = "startup"): Promise<void> {
  const existing = await WebviewWindow.getByLabel(SYSTOOLS_WINDOW_LABEL);
  if (existing) {
    await showWindow(SYSTOOLS_WINDOW_LABEL);
    await emitTo(SYSTOOLS_WINDOW_LABEL, SYSTOOLS_TAB_EVENT, tab);
    return;
  }

  await createWindow(SYSTOOLS_WINDOW_LABEL, {
    title: "System tools",
    url: `${SYSTOOLS_WINDOW_PATH}?tab=${tab}`,
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    resizable: true,
    minimizable: true,
    maximizable: true,
    // Every window of this app draws its own frame (`WindowFrame` + `TitleBar`),
    // so the native one has to stay off or the bars would stack.
    decorations: false,
    transparent: true,
    shadow: false,
  });
}
