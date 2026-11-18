import { useMemo, useSyncExternalStore } from "react";
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

/** The data half of the page state; the actions are stable module-level functions. */
type TaskManagerView = {
  snapshot: Snapshot | null;
  loading: boolean;
  paused: boolean;
  error: ArgusError | null;
  settings: ArgusSettings;
  service: ServiceStatus | null;
  activeTab: TaskManagerTab;
};

const DEFAULT_SETTINGS: ArgusSettings = { intervalMs: 1000 };

const INITIAL_VIEW: TaskManagerView = {
  snapshot: null,
  loading: true,
  paused: false,
  error: null,
  settings: DEFAULT_SETTINGS,
  service: null,
  activeTab: "processes",
};

function toArgusError(value: unknown): ArgusError {
  if (isArgusError(value)) return value;
  return {
    code: "internal",
    message: value instanceof Error ? value.message : String(value),
  };
}

/**
 * One page, one subscription.
 *
 * The page shell and both tabs call `useTaskManager()`, so the state cannot
 * live in a single component: the sampler accepts one channel per page and
 * `argus_snapshot_stop` tears the thread down. The store below keeps the one
 * channel alive while at least one caller is mounted, and every caller renders
 * from the same state.
 */
class TaskManagerStore {
  private listeners = new Set<() => void>();
  private view: TaskManagerView = INITIAL_VIEW;
  private channel: Channel<Snapshot> | null = null;
  private paused = false;

  getView = (): TaskManagerView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    const first = this.listeners.size === 0;
    this.listeners.add(listener);
    if (first) void this.start();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  setPaused = (paused: boolean): void => {
    this.paused = paused;
    this.update({ paused });
  };

  setActiveTab = (activeTab: TaskManagerTab): void => {
    this.update({ activeTab });
  };

  setInterval = async (ms: number): Promise<void> => {
    try {
      this.update({ settings: await argusSetInterval(ms), error: null });
    } catch (failure) {
      this.update({ error: toArgusError(failure) });
    }
  };

  refresh = async (): Promise<void> => {
    try {
      await argusRefresh();
    } catch (failure) {
      this.update({ error: toArgusError(failure) });
    }
  };

  reloadService = async (): Promise<void> => {
    try {
      this.update({ service: await argusServiceStatus() });
    } catch (failure) {
      this.update({ error: toArgusError(failure) });
    }
  };

  installService = (): Promise<void> => this.manageService("install");
  uninstallService = (): Promise<void> => this.manageService("uninstall");
  updateService = (): Promise<void> => this.manageService("update");

  killProcess = async (pid: number, createTime: number, force = false): Promise<void> => {
    try {
      await argusKillProcess(pid, createTime, force);
      this.update({ error: null });
    } catch (failure) {
      this.update({ error: toArgusError(failure) });
    }
  };

  killTree = async (pid: number, createTime: number): Promise<void> => {
    try {
      await argusKillProcessTree(pid, createTime);
      this.update({ error: null });
    } catch (failure) {
      this.update({ error: toArgusError(failure) });
    }
  };

  setPriority = async (pid: number, createTime: number, priority: Priority): Promise<void> => {
    try {
      await argusSetPriority(pid, createTime, priority);
      this.update({ error: null });
    } catch (failure) {
      this.update({ error: toArgusError(failure) });
    }
  };

  setEfficiency = async (pid: number, createTime: number, on: boolean): Promise<void> => {
    try {
      await argusSetEfficiency(pid, createTime, on);
      this.update({ error: null });
    } catch (failure) {
      this.update({ error: toArgusError(failure) });
    }
  };

  private manageService = async (action: "install" | "uninstall" | "update"): Promise<void> => {
    try {
      this.update({ service: await argusServiceManage(action), error: null });
    } catch (failure) {
      this.update({ error: toArgusError(failure) });
    }
  };

  private update(patch: Partial<TaskManagerView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async start(): Promise<void> {
    const channel = new Channel<Snapshot>();
    channel.onmessage = (frame) => {
      // A frame can arrive after the last caller unmounted; never write it into
      // the state a later mount will start from.
      if (this.channel !== channel || this.paused) return;
      this.update({ snapshot: frame, loading: false });
    };
    this.channel = channel;
    this.paused = false;

    try {
      const settings = await argusSettingsGet();
      // A tab may unmount before the settings arrive; a newer start owns the
      // subscription in that case, and this one must not overwrite it.
      if (this.channel !== channel) return;
      this.update({ settings });
      await argusSnapshotStart(channel, settings.intervalMs);
    } catch (failure) {
      if (this.channel !== channel) return;
      this.update({ error: toArgusError(failure), loading: false });
    }

    // The service is optional: a failure here must not stop read-only sampling.
    void argusServiceStatus()
      .then((service) => {
        if (this.channel === channel) this.update({ service });
      })
      .catch((failure) => {
        if (this.channel === channel) this.update({ error: toArgusError(failure) });
      });
  }

  private stop(): void {
    this.channel = null;
    this.paused = false;
    this.view = { ...INITIAL_VIEW };
    this.notify();
    void argusSnapshotStop().catch(() => undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

const store = new TaskManagerStore();

const actions = {
  setPaused: (paused: boolean) => store.setPaused(paused),
  setActiveTab: (tab: TaskManagerTab) => store.setActiveTab(tab),
  setInterval: (ms: number) => store.setInterval(ms),
  refresh: () => store.refresh(),
  reloadService: () => store.reloadService(),
  installService: () => store.installService(),
  uninstallService: () => store.uninstallService(),
  updateService: () => store.updateService(),
  killProcess: (pid: number, createTime: number, force?: boolean) =>
    store.killProcess(pid, createTime, force),
  killTree: (pid: number, createTime: number) => store.killTree(pid, createTime),
  setPriority: (pid: number, createTime: number, priority: Priority) =>
    store.setPriority(pid, createTime, priority),
  setEfficiency: (pid: number, createTime: number, on: boolean) =>
    store.setEfficiency(pid, createTime, on),
};

/**
 * The task manager page's state: one snapshot subscription shared by every
 * caller on the page, the persisted settings, the service status and the
 * process operations.
 *
 * Sampling starts when the first caller mounts and stops when the last one
 * unmounts. Pausing only makes the store drop incoming frames; the backend
 * keeps sampling so resuming is immediate.
 */
export function useTaskManager(): TaskManagerState {
  const view = useSyncExternalStore(store.subscribe, store.getView, store.getView);
  return useMemo(() => ({ ...view, ...actions }), [view]);
}
