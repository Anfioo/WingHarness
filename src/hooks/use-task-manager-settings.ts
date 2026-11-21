// State for the task manager partition of the Settings window.
//
// The partition runs in its own window, so it must not mount `useTaskManager`:
// that hook starts the page's sampling thread. Everything here goes through the
// thin `argus_*` wrappers instead, and the backend's settings event keeps the
// page, the tray row and this window in step without polling.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  argusErrorKey,
  argusHistoryClear,
  argusHistoryUsage,
  argusServiceManage,
  argusServiceStatus,
  argusSetBackgroundMonitoring,
  argusSettingsGet,
  argusSettingsSet,
  isArgusError,
  type ArgusSettings,
  type HistoryUsage,
  type ServiceStatus,
} from "@/commands";
import { subscribeTaskManagerSettings } from "@/lib/task-manager/settings-event";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** A service action, plus the read-only status refresh. */
export type TaskManagerServiceAction = "install" | "uninstall" | "update" | "refresh";

export type TaskManagerSettingsController = {
  /** Null until the first load lands, or when it failed. */
  settings: ArgusSettings | null;
  service: ServiceStatus | null;
  usage: HistoryUsage | null;
  loading: boolean;
  loadFailed: boolean;
  /** A setting is being written; the controls are disabled meanwhile. */
  saving: boolean;
  busyService: TaskManagerServiceAction | null;
  usageLoading: boolean;
  usageFailed: boolean;
  reload: () => void;
  reloadUsage: () => void;
  saveInterval: (intervalMs: number) => Promise<void>;
  setBackgroundMonitoring: (enabled: boolean) => Promise<void>;
  saveBackgroundInterval: (intervalMs: number) => Promise<void>;
  refreshService: () => Promise<void>;
  installService: () => Promise<void>;
  uninstallService: () => Promise<void>;
  updateService: () => Promise<void>;
  clearHistory: () => Promise<void>;
};

/**
 * Loads the settings, the service status and the history usage, and exposes
 * one action per control.
 *
 * Saves are immediate: a failed write only toasts, and the saved value stays
 * in state, so the control falls back to it on the next render.
 */
export function useTaskManagerSettings(): TaskManagerSettingsController {
  const { t } = useAppTranslation();

  const [settings, setSettings] = useState<ArgusSettings | null>(null);
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [usage, setUsage] = useState<HistoryUsage | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyService, setBusyService] = useState<TaskManagerServiceAction | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageFailed, setUsageFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      setSettings(await argusSettingsGet());
    } catch (error) {
      console.error("Failed to load the task manager settings:", error);
      setLoadFailed(true);
      return;
    } finally {
      setLoading(false);
    }

    // A service status that cannot be read is not a reason to hide the rest of
    // the partition; the badge then reads as unknown.
    try {
      setService(await argusServiceStatus());
    } catch (error) {
      console.error("Failed to read the privileged service status:", error);
    }
  }, []);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageFailed(false);
    try {
      setUsage(await argusHistoryUsage());
    } catch (error) {
      console.error("Failed to read the history usage:", error);
      setUsageFailed(true);
    } finally {
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadUsage();
  }, [load, loadUsage]);

  // Another window or the tray row may write the same document.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    subscribeTaskManagerSettings((next) => {
      if (!cancelled) setSettings(next);
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const persist = useCallback(
    async (next: ArgusSettings) => {
      setSaving(true);
      try {
        setSettings(await argusSettingsSet(next));
      } catch (error) {
        console.error("Failed to save the task manager settings:", error);
        toast.error(t("taskManager.settings.saveFailed"));
      } finally {
        setSaving(false);
      }
    },
    [t]
  );

  const saveInterval = useCallback(
    async (intervalMs: number) => {
      if (!settings) return;
      await persist({ ...settings, intervalMs });
    },
    [persist, settings]
  );

  const saveBackgroundInterval = useCallback(
    async (backgroundIntervalMs: number) => {
      if (!settings) return;
      await persist({ ...settings, backgroundIntervalMs });
    },
    [persist, settings]
  );

  const setBackgroundMonitoring = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      try {
        setSettings(await argusSetBackgroundMonitoring(enabled));
      } catch (error) {
        console.error("Failed to toggle background monitoring:", error);
        toast.error(t("taskManager.settings.saveFailed"));
      } finally {
        setSaving(false);
      }
    },
    [t]
  );

  const manageService = useCallback(
    async (action: "install" | "uninstall" | "update") => {
      setBusyService(action);
      try {
        setService(await argusServiceManage(action));
      } catch (error) {
        console.error(`Failed to ${action} the privileged service:`, error);
        toast.error(
          t(isArgusError(error) ? argusErrorKey(error.code) : "taskManager.error.internal")
        );
      } finally {
        setBusyService(null);
      }
    },
    [t]
  );

  const refreshService = useCallback(async () => {
    setBusyService("refresh");
    try {
      setService(await argusServiceStatus());
    } catch (error) {
      console.error("Failed to read the privileged service status:", error);
      toast.error(t("taskManager.error.internal"));
    } finally {
      setBusyService(null);
    }
  }, [t]);

  const installService = useCallback(() => manageService("install"), [manageService]);
  const uninstallService = useCallback(() => manageService("uninstall"), [manageService]);
  const updateService = useCallback(() => manageService("update"), [manageService]);

  const clearHistory = useCallback(async () => {
    try {
      await argusHistoryClear();
      toast.success(t("taskManager.settings.history.cleared"));
      await loadUsage();
    } catch (error) {
      console.error("Failed to clear the task manager history:", error);
      toast.error(t("taskManager.settings.history.clearFailed"));
    }
  }, [loadUsage, t]);

  return {
    settings,
    service,
    usage,
    loading,
    loadFailed,
    saving,
    busyService,
    usageLoading,
    usageFailed,
    reload: () => void load(),
    reloadUsage: () => void loadUsage(),
    saveInterval,
    setBackgroundMonitoring,
    saveBackgroundInterval,
    refreshService,
    installService,
    uninstallService,
    updateService,
    clearHistory,
  };
}
