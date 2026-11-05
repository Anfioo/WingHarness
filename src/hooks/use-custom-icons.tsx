import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { sidebarIconsDir, sidebarIconsList, type SidebarCustomIcon } from "@/commands";
import type { AppRouteIcon } from "@/lib/app-routes";
import { cn } from "@/lib/utils";

/**
 * The SVGs in the sidebar's icons folder, shared by every window.
 *
 * Users add an icon by dropping a file into the folder, so the list can change
 * while the app is running. Each window keeps its own copy; the manager's
 * reload tells the others through {@link ICONS_CHANGED_EVENT} so a newly chosen
 * icon also draws in the main window's sidebar.
 */

/** Emitted after a reload, so every other window re-reads the folder. */
export const ICONS_CHANGED_EVENT = "sidebar-icons-changed";

/** A folder file, ready to draw. */
export interface CustomIconEntry {
  /** File stem; the layout stores it as `custom:<name>`. */
  name: string;
  /** The document as a data URL, so an `<img>` can draw it. */
  src: string;
  icon: AppRouteIcon;
}

interface CustomIconsStoreValue {
  icons: CustomIconEntry[];
  /** Component by file stem, for resolving a stored `custom:<name>` value. */
  byName: Map<string, AppRouteIcon>;
  /** Folder the files are read from, shown in the picker. */
  dir: string;
  /** False until the first load settles. */
  loaded: boolean;
  /** Re-reads the folder in this window. */
  refresh: () => Promise<void>;
  /** Re-reads locally and tells the other windows to re-read too. */
  refreshAll: () => Promise<void>;
}

const CustomIconsContext = createContext<CustomIconsStoreValue | null>(null);

function toEntry(raw: SidebarCustomIcon): CustomIconEntry {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw.svg)}`;

  // Drawn through an `<img>` rather than inlined: a data-URL image cannot run a
  // script even if the file carries one, and the browser keeps its own cache.
  function Icon(props: { className?: string; style?: CSSProperties }) {
    return createElement("img", {
      src,
      alt: "",
      className: cn("object-contain", props.className),
      style: props.style,
      draggable: false,
    });
  }

  return { name: raw.name, src, icon: Icon };
}

export function CustomIconsProvider({ children }: { children: ReactNode }) {
  const [raw, setRaw] = useState<SidebarCustomIcon[]>([]);
  const [dir, setDir] = useState("");
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [icons, directory] = await Promise.all([sidebarIconsList(), sidebarIconsDir()]);
      setRaw(icons);
      setDir(directory);
    } catch (error) {
      console.error("Failed to load custom sidebar icons:", error);
      setRaw([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await refresh();
    await emit(ICONS_CHANGED_EVENT);
  }, [refresh]);

  useEffect(() => {
    void refresh();

    const unlisten = listen(ICONS_CHANGED_EVENT, () => void refresh());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const icons = useMemo(() => raw.map(toEntry), [raw]);
  const byName = useMemo(() => new Map(icons.map((entry) => [entry.name, entry.icon])), [icons]);

  const value = useMemo<CustomIconsStoreValue>(
    () => ({ icons, byName, dir, loaded, refresh, refreshAll }),
    [icons, byName, dir, loaded, refresh, refreshAll]
  );

  return <CustomIconsContext.Provider value={value}>{children}</CustomIconsContext.Provider>;
}

export function useCustomIcons(): CustomIconsStoreValue {
  const context = useContext(CustomIconsContext);
  if (!context) {
    throw new Error("useCustomIcons must be used within a CustomIconsProvider.");
  }
  return context;
}
