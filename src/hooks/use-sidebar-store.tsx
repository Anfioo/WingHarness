import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { sidebarGet, sidebarSet, type SidebarConfig } from "@/commands";
import { appRoutes } from "@/lib/app-routes";
import { buildDefaultConfig } from "@/lib/sidebar-config";

/**
 * The main window's sidebar layout, shared by every window.
 *
 * The manager window edits it and the main window draws it, but they are
 * separate documents, so neither can see the other's React state. Each keeps
 * one copy and a save tells the others to re-read through
 * {@link SIDEBAR_CHANGED_EVENT}.
 */

/** Emitted after a save, so every other window re-reads the layout. */
export const SIDEBAR_CHANGED_EVENT = "sidebar-state-changed";

interface SidebarStoreValue {
  /** `null` until the first load settles. */
  config: SidebarConfig | null;
  /**
   * Replaces the layout and tells the other windows.
   *
   * The manager always sends the whole document, so a drag that moved one row
   * cannot leave two windows holding different halves of the change.
   */
  save: (config: SidebarConfig) => Promise<void>;
  /** Re-reads the layout from disk. */
  refresh: () => Promise<void>;
}

const SidebarContext = createContext<SidebarStoreValue | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SidebarConfig | null>(null);

  const load = useCallback(async () => {
    try {
      const stored = await sidebarGet();
      if (stored) {
        setConfig(stored);
        return;
      }

      // First run of the new sidebar: the layout starts out as the built-in
      // pages in their groups. Plugins are placed from the manager.
      const initial = buildDefaultConfig(appRoutes);
      await sidebarSet(initial);
      setConfig(initial);
    } catch (error) {
      console.error("Failed to load the sidebar layout:", error);
    }
  }, []);

  const save = useCallback(async (next: SidebarConfig) => {
    await sidebarSet(next);
    setConfig(next);
    await emit(SIDEBAR_CHANGED_EVENT);
  }, []);

  useEffect(() => {
    void load();

    const unlisten = listen(SIDEBAR_CHANGED_EVENT, () => void load());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [load]);

  return (
    <SidebarContext.Provider value={{ config, save, refresh: load }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebarStore(): SidebarStoreValue {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebarStore must be used within a SidebarProvider.");
  }
  return context;
}
