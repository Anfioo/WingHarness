import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  isPortsError,
  MAX_PINNED_PORTS,
  portsErrorCode,
  portsKill,
  portsKillElevated,
  portsList,
  portsPinnedScan,
  portsSettingsGet,
  portsSettingsSet,
  type PortEntry,
  type PortGrouping,
  type PortsError,
  type PortsSettings,
  type PortStatus,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { portsErrorKey } from "@/lib/ports/error-key";
import { PORTS_SETTINGS_CHANGED } from "@/lib/ports/settings-event";
import { usePageActive } from "@/lib/page-active";

export type PortCounts = { free: number; occupied: number; system: number };

export type PortsPageState = {
  settings: PortsSettings | null;
  /** Pinned ports after the status filter and search, ascending. */
  pinned: PortEntry[];
  /** Other ports after the filter and search; empty when `settings.pinnedOnly`. */
  others: PortEntry[];
  /** Counts over the visible ports. */
  counts: PortCounts;
  query: string;
  setQuery: (query: string) => void;
  statuses: Set<PortStatus>;
  toggleStatus: (status: PortStatus) => void;
  groupBy: PortGrouping;
  setGrouping: (grouping: PortGrouping) => Promise<void>;
  loading: boolean;
  refreshing: boolean;
  paused: boolean;
  updatedAt: number;
  error: PortsError | null;
  refresh: () => void;
  kill: (pid: number) => Promise<void>;
  togglePin: (port: number) => Promise<void>;
  detailPort: number | null;
  openDetail: (port: number) => void;
  closeDetail: () => void;
};

const ALL_PORTS_INTERVAL_MS = 3000;
const PINNED_PORTS_INTERVAL_MS = 2000;
const ALL_STATUSES: PortStatus[] = ["free", "occupied", "system"];

function toPortsError(value: unknown): PortsError {
  if (isPortsError(value)) return value;
  return {
    code: "internal",
    message: value instanceof Error ? value.message : String(value),
    detail: null,
  };
}

function matches(entry: PortEntry, statuses: Set<PortStatus>, query: string): boolean {
  if (!statuses.has(entry.status)) return false;
  if (query.length === 0) return true;
  if (String(entry.port).includes(query)) return true;
  if (entry.status === "free") return false;
  return entry.process?.name.toLowerCase().includes(query) ?? false;
}

/**
 * The ports page's state: settings, two polling loops, the derived lists and
 * the end-process flow. Polling runs only while the page is on screen.
 */
export function usePortsPage(): PortsPageState {
  const { t } = useAppTranslation();
  const pageActive = usePageActive();

  const [settings, setSettings] = useState<PortsSettings | null>(null);
  const [allPorts, setAllPorts] = useState<PortEntry[]>([]);
  const [pinnedPorts, setPinnedPorts] = useState<PortEntry[]>([]);
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<Set<PortStatus>>(() => new Set(ALL_STATUSES));
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [error, setError] = useState<PortsError | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState !== "hidden"
  );
  const [detailPort, setDetailPort] = useState<number | null>(null);

  // The polling callbacks outlive a settings change, so they read the latest
  // pinned list through a ref instead of a stale closure.
  const settingsRef = useRef<PortsSettings | null>(null);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const loadAll = useCallback(async () => {
    try {
      const entries = await portsList();
      setAllPorts(entries);
      setUpdatedAt(Date.now());
      setError(null);
    } catch (failure) {
      setError(toPortsError(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPinned = useCallback(async () => {
    const pinned = settingsRef.current?.pinnedPorts ?? [];
    if (pinned.length === 0) {
      setPinnedPorts([]);
      return;
    }
    try {
      setPinnedPorts(await portsPinnedScan(pinned));
    } catch (failure) {
      setError(toPortsError(failure));
    }
  }, []);

  const reloadSettings = useCallback(() => {
    portsSettingsGet()
      .then((next) => setSettings(next))
      .catch((failure) => {
        setSettings(null);
        setError(toPortsError(failure));
      });
  }, []);

  // The Settings window owns the pinned list; it emits after every save so this
  // page applies the change without waiting for a reload.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    reloadSettings();
    listen(PORTS_SETTINGS_CHANGED, () => reloadSettings()).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [reloadSettings]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let cancelled = false;

    const sync = async () => {
      const value = await appWindow.isMinimized();
      if (!cancelled) setMinimized(value);
    };

    void sync();
    const unlistenResized = appWindow.onResized(() => void sync());
    const unlistenFocus = appWindow.onFocusChanged(() => void sync());

    return () => {
      cancelled = true;
      unlistenResized.then((fn) => fn());
      unlistenFocus.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const sync = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  const paused = !pageActive || !documentVisible || minimized;
  const pinnedKey = settings?.pinnedPorts.join(",") ?? "";

  // Paused at mount (a cached page or a minimized window) means nothing is
  // fetched; the effect re-runs and fetches immediately when it resumes.
  useEffect(() => {
    if (paused) return;

    void loadAll();
    void loadPinned();
    const allTimer = setInterval(() => void loadAll(), ALL_PORTS_INTERVAL_MS);
    const pinnedTimer = setInterval(() => void loadPinned(), PINNED_PORTS_INTERVAL_MS);

    return () => {
      clearInterval(allTimer);
      clearInterval(pinnedTimer);
    };
  }, [paused, pinnedKey, loadAll, loadPinned]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([loadAll(), loadPinned()]).finally(() => setRefreshing(false));
  }, [loadAll, loadPinned]);

  // Surface the outcome to the caller: `togglePin` and `setGrouping` toast a
  // failure. The other window renders the same settings, so it is told too.
  const persist = useCallback(async (next: PortsSettings) => {
    setSettings(await portsSettingsSet(next));
    setError(null);
    void emit(PORTS_SETTINGS_CHANGED);
  }, []);

  const togglePin = useCallback(
    async (port: number) => {
      const current = settingsRef.current;
      if (!current) return;

      const pinned = current.pinnedPorts;
      if (!pinned.includes(port) && pinned.length >= MAX_PINNED_PORTS) {
        toast.error(t("ports.settings.full"));
        return;
      }

      const nextPinned = pinned.includes(port)
        ? pinned.filter((value) => value !== port)
        : [...pinned, port].sort((left, right) => left - right);
      try {
        await persist({ ...current, pinnedPorts: nextPinned });
      } catch (failure) {
        toast.error(t(portsErrorKey(portsErrorCode(failure))));
      }
    },
    [persist, t]
  );

  const setGrouping = useCallback(
    async (groupBy: PortGrouping) => {
      const current = settingsRef.current;
      if (!current || current.groupBy === groupBy) return;
      try {
        await persist({ ...current, groupBy });
      } catch (failure) {
        toast.error(t(portsErrorKey(portsErrorCode(failure))));
      }
    },
    [persist, t]
  );

  const kill = useCallback(
    async (pid: number) => {
      try {
        await portsKill(pid);
        toast.success(t("ports.kill.success"));
      } catch (failure) {
        if (portsErrorCode(failure) !== "access-denied") {
          toast.error(t(portsErrorKey(portsErrorCode(failure))));
        } else {
          try {
            await portsKillElevated(pid);
            toast.success(t("ports.kill.success"));
          } catch (elevatedFailure) {
            const code = portsErrorCode(elevatedFailure);
            if (code === "elevation-cancelled") toast.info(t("ports.kill.cancelled"));
            else toast.error(t(portsErrorKey(code)));
          }
        }
      }
      refresh();
    },
    [refresh, t]
  );

  const toggleStatus = useCallback((status: PortStatus) => {
    setStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const normalizedQuery = query.trim().toLowerCase();

  const pinned = useMemo(() => {
    const order = settings?.pinnedPorts ?? [];
    if (order.length === 0) return [];

    const byPort = new Map(pinnedPorts.map((entry) => [entry.port, entry]));
    const entries: PortEntry[] = [];
    for (const port of order) {
      const entry = byPort.get(port);
      if (entry && matches(entry, statuses, normalizedQuery)) entries.push(entry);
    }
    return entries.sort((left, right) => left.port - right.port);
  }, [pinnedPorts, settings, statuses, normalizedQuery]);

  const others = useMemo(() => {
    if (settings?.pinnedOnly) return [];

    const pinnedSet = new Set(settings?.pinnedPorts ?? []);
    return allPorts
      .filter((entry) => !pinnedSet.has(entry.port))
      .filter((entry) => matches(entry, statuses, normalizedQuery))
      .sort((left, right) => left.port - right.port);
  }, [allPorts, settings, statuses, normalizedQuery]);

  const counts = useMemo<PortCounts>(() => {
    const result: PortCounts = { free: 0, occupied: 0, system: 0 };
    for (const entry of [...pinned, ...others]) result[entry.status] += 1;
    return result;
  }, [pinned, others]);

  const openDetail = useCallback((port: number) => setDetailPort(port), []);
  const closeDetail = useCallback(() => setDetailPort(null), []);

  return {
    settings,
    pinned,
    others,
    counts,
    query,
    setQuery,
    statuses,
    toggleStatus,
    groupBy: settings?.groupBy ?? "port",
    setGrouping,
    loading,
    refreshing,
    paused,
    updatedAt,
    error,
    refresh,
    kill,
    togglePin,
    detailPort,
    openDetail,
    closeDetail,
  };
}
