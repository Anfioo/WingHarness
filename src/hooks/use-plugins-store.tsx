import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { pluginsList, type PluginView } from "@/commands";

/**
 * The installed plugins, shared by every window.
 *
 * Plugins are shown in several places — the plugins page's tabs, the sidebar,
 * and the settings page — and a change made in one (installing, uninstalling,
 * enabling) has to show up in the others. Each window is its own document, so
 * React state cannot cross between them: this provider keeps one copy per
 * window and the windows tell each other to re-read through the
 * {@link STATE_CHANGED_EVENT} event.
 */

/** Emitted after any change to plugin state, so every other window re-reads. */
export const STATE_CHANGED_EVENT = "plugins-state-changed";

interface PluginsStoreValue {
  /** Every installed plugin, including broken ones. Empty until the first load. */
  plugins: PluginView[];
  /** False until the first load settles; the UI shows a skeleton until then. */
  loaded: boolean;
  /** Re-reads the plugin list from disk. */
  refresh: () => Promise<void>;
  /**
   * Re-reads locally **and** tells the other windows to re-read.
   *
   * Call this after a mutation that goes through the backend directly, so the
   * sidebar and any open settings window catch up without a manual reload.
   */
  refreshAll: () => Promise<void>;
}

const PluginsContext = createContext<PluginsStoreValue | null>(null);

export function PluginsProvider({ children }: { children: ReactNode }) {
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setPlugins(await pluginsList());
    } catch (error) {
      console.error("Failed to load plugins:", error);
      setPlugins([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await refresh();
    // Every window, including this one — its own refresh above already ran, and
    // a duplicate is harmless.
    await emit(STATE_CHANGED_EVENT);
  }, [refresh]);

  useEffect(() => {
    void refresh();

    const unlisten = listen(STATE_CHANGED_EVENT, () => void refresh());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  return (
    <PluginsContext.Provider value={{ plugins, loaded, refresh, refreshAll }}>
      {children}
    </PluginsContext.Provider>
  );
}

export function usePluginsStore(): PluginsStoreValue {
  const context = useContext(PluginsContext);
  if (!context) {
    throw new Error("usePluginsStore must be used within a PluginsProvider.");
  }
  return context;
}
