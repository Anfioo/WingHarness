import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import {
  argusKillProcess,
  argusKillProcessTree,
  argusRefresh,
  argusServiceManage,
  argusServiceStatus,
  argusSetEfficiency,
  argusSetInterval,
  argusSetPriority,
  argusSettingsGet,
  argusSnapshotStart,
  argusSnapshotStop,
  isArgusError,
  type ArgusError,
  type ArgusSettings,
  type Priority,
  type ServiceStatus,
  type Snapshot,
} from "@/commands";

export type TaskManagerTab = "processes" | "performance";

export type TaskManagerState = {
  snapshot: Snapshot | null;
  loading: boolean;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  error: ArgusError | null;
  settings: ArgusSettings;
  service: ServiceStatus | null;
  activeTab: TaskManagerTab;
  setActiveTab: (tab: TaskManagerTab) => void;
  setInterval: (ms: number) => Promise<void>;
  refresh: () => Promise<void>;
  reloadService: () => Promise<void>;
  installService: () => Promise<void>;
  uninstallService: () => Promise<void>;
  updateService: () => Promise<void>;
  killProcess: (pid: number, createTime: number, force?: boolean) => Promise<void>;
  killTree: (pid: number, createTime: number) => Promise<void>;
  setPriority: (pid: number, createTime: number, priority: Priority) => Promise<void>;
  setEfficiency: (pid: number, createTime: number, on: boolean) => Promise<void>;
};

const DEFAULT_SETTINGS: ArgusSettings = { intervalMs: 1000 };

function toArgusError(value: unknown): ArgusError {
  if (isArgusError(value)) return value;
  return {
    code: "internal",
    message: value instanceof Error ? value.message : String(value),
  };
}

/**
 * The task manager page's state: one snapshot subscription, the persisted
 * settings, the service status and the process operations.
 *
 * Sampling starts when the page mounts and stops when it unmounts. Pausing only
 * makes the page drop incoming frames; the backend keeps sampling so resuming
 * is immediate.
 */
export function useTaskManager(): TaskManagerState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [paused, setPausedState] = useState(false);
  const [error, setError] = useState<ArgusError | null>(null);
  const [settings, setSettings] = useState<ArgusSettings>(DEFAULT_SETTINGS);
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [activeTab, setActiveTab] = useState<TaskManagerTab>("processes");

  // The channel callback outlives a render, so it reads the pause flag through
  // a ref instead of a stale closure.
  const pausedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const channel = new Channel<Snapshot>();
    channel.onmessage = (frame) => {
      if (pausedRef.current) return;
      setSnapshot(frame);
      setLoading(false);
    };

    void (async () => {
      try {
        const loaded = await argusSettingsGet();
        if (cancelled) return;
        setSettings(loaded);
        await argusSnapshotStart(channel, loaded.intervalMs);
      } catch (failure) {
        if (cancelled) return;
        setError(toArgusError(failure));
        setLoading(false);
      }
    })();

    // The service is optional: a failure here must not stop read-only sampling.
    void argusServiceStatus()
      .then((next) => {
        if (!cancelled) setService(next);
      })
      .catch((failure) => {
        if (!cancelled) setError(toArgusError(failure));
      });

    return () => {
      cancelled = true;
      void argusSnapshotStop().catch(() => undefined);
    };
  }, []);

  const setPaused = useCallback((next: boolean) => {
    pausedRef.current = next;
    setPausedState(next);
  }, []);

  const changeInterval = useCallback(async (ms: number) => {
    try {
      setSettings(await argusSetInterval(ms));
      setError(null);
    } catch (failure) {
      setError(toArgusError(failure));
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      await argusRefresh();
    } catch (failure) {
      setError(toArgusError(failure));
    }
  }, []);

  const reloadService = useCallback(async () => {
    try {
      setService(await argusServiceStatus());
    } catch (failure) {
      setError(toArgusError(failure));
    }
  }, []);

  const manageService = useCallback(async (action: "install" | "uninstall" | "update") => {
    try {
      setService(await argusServiceManage(action));
      setError(null);
    } catch (failure) {
      setError(toArgusError(failure));
    }
  }, []);

  const installService = useCallback(() => manageService("install"), [manageService]);
  const uninstallService = useCallback(() => manageService("uninstall"), [manageService]);
  const updateService = useCallback(() => manageService("update"), [manageService]);

  const killProcess = useCallback(async (pid: number, createTime: number, force = false) => {
    try {
      await argusKillProcess(pid, createTime, force);
      setError(null);
    } catch (failure) {
      setError(toArgusError(failure));
    }
  }, []);

  const killTree = useCallback(async (pid: number, createTime: number) => {
    try {
      await argusKillProcessTree(pid, createTime);
      setError(null);
    } catch (failure) {
      setError(toArgusError(failure));
    }
  }, []);

  const setPriority = useCallback(async (pid: number, createTime: number, priority: Priority) => {
    try {
      await argusSetPriority(pid, createTime, priority);
      setError(null);
    } catch (failure) {
      setError(toArgusError(failure));
    }
  }, []);

  const setEfficiency = useCallback(async (pid: number, createTime: number, on: boolean) => {
    try {
      await argusSetEfficiency(pid, createTime, on);
      setError(null);
    } catch (failure) {
      setError(toArgusError(failure));
    }
  }, []);

  return {
    snapshot,
    loading,
    paused,
    setPaused,
    error,
    settings,
    service,
    activeTab,
    setActiveTab,
    setInterval: changeInterval,
    refresh,
    reloadService,
    installService,
    uninstallService,
    updateService,
    killProcess,
    killTree,
    setPriority,
    setEfficiency,
  };
}
