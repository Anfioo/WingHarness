import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import type { PluginView } from "@/commands";
import { createWindow } from "@/lib/window";
import { decodeLabelId, encodeLabelId } from "@/lib/plugin-label";

/**
 * Plugin pages that are open in their own window, and how to open one.
 *
 * This is runtime state, not stored state: an independent window is a thing the
 * user has open right now, so it does not survive a restart and is not written
 * to `plugins.json`. The plugins page shows a tab for such a plugin as greyed
 * out and unclickable while its window is up, and restores it when the window
 * closes.
 *
 * **Closing is learned from the backend, not from the window itself.** A window
 * torn down natively does not reliably finish its own `pagehide` work before it
 * goes, so the frontend cannot announce the close on its way out. The backend
 * emits `plugin-window-closed` on the window's destruction, which is the one
 * signal that always arrives.
 */

/** Emitted by the backend when a plugin's own window is destroyed. */
export const PLUGIN_WINDOW_CLOSED = "plugin-window-closed";

/** Label prefix of a plugin's own window; the plugin id follows. */
export const PLUGIN_WINDOW_PREFIX = "plugin-window-";

/**
 * The window label for one plugin's own window.
 *
 * The id is encoded: it may contain `.`, which a window label may not (see
 * {@link encodeLabelId}).
 */
export function pluginWindowLabel(id: string): string {
  return `${PLUGIN_WINDOW_PREFIX}${encodeLabelId(id)}`;
}

/** Ids of the plugin windows already open, so a fresh page finds its bearings. */
async function scanOpenIds(): Promise<string[]> {
  try {
    const windows = await getAllWebviewWindows();
    return windows
      .map((window) => window.label)
      .filter((label) => label.startsWith(PLUGIN_WINDOW_PREFIX))
      .map((label) => decodeLabelId(label.slice(PLUGIN_WINDOW_PREFIX.length)));
  } catch (error) {
    console.error("Failed to list open plugin windows:", error);
    return [];
  }
}

export function usePluginWindows(): {
  /** Plugin ids whose page is open in its own window. */
  openIds: Set<string>;
  /** Opens one plugin's page in its own window, reusing it if already open. */
  openWindow: (plugin: PluginView) => Promise<void>;
} {
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let alive = true;
    // The windows already open before this page mounted: a change of language or
    // a reload must not lose track of them.
    void scanOpenIds().then((ids) => {
      if (alive) setOpenIds(new Set(ids));
    });

    const unlisten = listen<{ id: string }>(PLUGIN_WINDOW_CLOSED, (event) => {
      setOpenIds((current) => {
        const next = new Set(current);
        next.delete(event.payload.id);
        return next;
      });
    });

    return () => {
      alive = false;
      unlisten.then((fn) => fn());
    };
  }, []);

  const openWindow = useCallback(async (plugin: PluginView) => {
    await createWindow(pluginWindowLabel(plugin.id), {
      title: plugin.name,
      url: `/plugin-window?id=${encodeURIComponent(plugin.id)}`,
      width: 1024,
      height: 720,
      resizable: true,
      maximizable: true,
      minimizable: true,
      decorations: false,
      transparent: true,
      shadow: false,
    });

    // `createWindow` reuses an existing window, so this covers both "opened it"
    // and "it was already open" — either way the tab is greyed out now. The tab
    // is cleared by the backend's close event, not here.
    setOpenIds((current) => new Set(current).add(plugin.id));
  }, []);

  return { openIds, openWindow };
}
