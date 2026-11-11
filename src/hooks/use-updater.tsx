import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { cancelUpdateDownload, downloadAndInstallUpdate, isUpdateDownloadActive } from "@/commands";
import type { UpdateInstallResult, UpdateProgress } from "@/commands";
import { checkForUpdates, updateErrorMessage } from "@/lib/updater";
import type { UpdateCheckResult, UpdateInfo } from "@/lib/updater";
import { createWindow } from "@/lib/window";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import i18n from "@/i18n";

const AVAILABLE_VERSION_STORAGE_KEY = "wingharness-updater-available-version";
const SKIPPED_VERSION_STORAGE_KEY = "wingharness-updater-skipped-version";
const DOWNLOAD_ACTIVE_STORAGE_KEY = "wingharness-updater-download-active";
const DOWNLOAD_PROGRESS_STORAGE_KEY = "wingharness-updater-download-progress";

export const UPDATE_WINDOW_LABEL = "update";

function readStoredProgress(): UpdateProgress | null {
  const value = localStorage.getItem(DOWNLOAD_PROGRESS_STORAGE_KEY);
  if (!value) return null;

  try {
    return JSON.parse(value) as UpdateProgress;
  } catch {
    localStorage.removeItem(DOWNLOAD_PROGRESS_STORAGE_KEY);
    return null;
  }
}

/**
 * The standalone window the update prompt lives in. Opening is idempotent — an
 * existing (possibly hidden) window is shown and focused instead.
 */
function openUpdateWindow() {
  void createWindow(UPDATE_WINDOW_LABEL, {
    title: i18n.t("updater.windowTitle"),
    url: "/update",
    width: 480,
    height: 600,
    minWidth: 420,
    minHeight: 460,
    resizable: true,
    maximizable: false,
    decorations: false,
    transparent: true,
    shadow: false,
    parent: "main",
  });
}

export interface CheckUpdateOptions {
  /** Prompt even when this exact version was skipped (used by manual checks). */
  force?: boolean;
  /** Open the update window when the check finds a version worth prompting for. */
  openWindow?: boolean;
}

interface UpdaterContextValue {
  update: UpdateInfo | null;
  availableVersion: string | null;
  skippedVersion: string | null;
  hasUpdate: boolean;
  checking: boolean;
  /** The mirror the running check is talking to, `null` outside a check. */
  checkingEndpoint: string | null;
  downloading: boolean;
  cancelling: boolean;
  progress: UpdateProgress | null;
  checkUpdate: (options?: CheckUpdateOptions) => Promise<UpdateCheckResult>;
  installUpdate: () => Promise<UpdateInstallResult | null>;
  cancelDownload: () => Promise<boolean>;
  skipUpdate: () => void;
  openUpdateWindow: () => void;
}

const UpdaterContext = createContext<UpdaterContextValue | null>(null);

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [availableVersion, setAvailableVersion] = useState<string | null>(() =>
    localStorage.getItem(AVAILABLE_VERSION_STORAGE_KEY)
  );
  const [skippedVersion, setSkippedVersion] = useState<string | null>(() =>
    localStorage.getItem(SKIPPED_VERSION_STORAGE_KEY)
  );
  const [checking, setChecking] = useState(false);
  const [checkingEndpoint, setCheckingEndpoint] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(
    () => localStorage.getItem(DOWNLOAD_ACTIVE_STORAGE_KEY) === "true"
  );
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(readStoredProgress);
  const pendingCheck = useRef<Promise<UpdateCheckResult> | null>(null);
  // Download progress arrives as chunk lengths; the cumulative total and the
  // speed are derived here so the window can show more than a percentage.
  const downloadedRef = useRef(0);
  const speedSampleRef = useRef<{ at: number; bytes: number } | null>(null);
  const speedRef = useRef(0);
  // Capturing skippedVersion in the check callback would rebuild it on every
  // skip; reading through the ref keeps one stable callback instead.
  const skippedVersionRef = useRef(skippedVersion);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === AVAILABLE_VERSION_STORAGE_KEY) {
        setAvailableVersion(event.newValue);
      } else if (event.key === SKIPPED_VERSION_STORAGE_KEY) {
        setSkippedVersion(event.newValue);
        skippedVersionRef.current = event.newValue;
      } else if (event.key === DOWNLOAD_ACTIVE_STORAGE_KEY) {
        setDownloading(event.newValue === "true");
      } else if (event.key === DOWNLOAD_PROGRESS_STORAGE_KEY) {
        setProgress(readStoredProgress());
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const storeAvailableVersion = useCallback((version: string | null) => {
    setAvailableVersion(version);
    if (version) {
      localStorage.setItem(AVAILABLE_VERSION_STORAGE_KEY, version);
    } else {
      localStorage.removeItem(AVAILABLE_VERSION_STORAGE_KEY);
    }
  }, []);

  const storeDownloading = useCallback((active: boolean) => {
    setDownloading(active);
    if (active) {
      localStorage.setItem(DOWNLOAD_ACTIVE_STORAGE_KEY, "true");
    } else {
      localStorage.removeItem(DOWNLOAD_ACTIVE_STORAGE_KEY);
    }
  }, []);

  const storeProgress = useCallback((nextProgress: UpdateProgress | null) => {
    setProgress(nextProgress);
    if (nextProgress) {
      localStorage.setItem(DOWNLOAD_PROGRESS_STORAGE_KEY, JSON.stringify(nextProgress));
    } else {
      localStorage.removeItem(DOWNLOAD_PROGRESS_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    void isUpdateDownloadActive()
      .then(storeDownloading)
      .catch((error) => console.error("Failed to read update download status:", error));
  }, [storeDownloading]);

  // The backend announces each endpoint before trying it, so the check spinner
  // can name the mirror it is actually waiting on.
  useEffect(() => {
    const pending = listen<string | null>("updater:checking", ({ payload }) =>
      setCheckingEndpoint(payload)
    );
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  const checkUpdate = useCallback(
    (options?: CheckUpdateOptions): Promise<UpdateCheckResult> => {
      if (pendingCheck.current) {
        return pendingCheck.current;
      }

      const { force = false, openWindow = true } = options ?? {};
      setChecking(true);
      setCheckingEndpoint(null);
      const request = checkForUpdates();
      pendingCheck.current = request;

      void request
        .then((result) => {
          if (result.status === "available") {
            setUpdate(result.update);
            storeAvailableVersion(result.update.version);
            if (openWindow && (force || result.update.version !== skippedVersionRef.current)) {
              openUpdateWindow();
            }
          } else if (result.status === "up-to-date") {
            setUpdate(null);
            storeAvailableVersion(null);
          }
          storeProgress(null);
        })
        .finally(() => {
          pendingCheck.current = null;
          setChecking(false);
          setCheckingEndpoint(null);
        });

      return request;
    },
    [storeAvailableVersion, storeProgress]
  );

  const handleProgress = useCallback((event: UpdateProgress) => {
    const now = performance.now();
    if (event.event === "Started") {
      downloadedRef.current = 0;
      speedRef.current = 0;
      speedSampleRef.current = { at: now, bytes: 0 };
    } else if (event.event === "Progress") {
      downloadedRef.current += event.data?.chunkLength ?? 0;
      const last = speedSampleRef.current;
      if (last && now - last.at >= 250) {
        const instant = ((downloadedRef.current - last.bytes) * 1000) / (now - last.at);
        speedRef.current = speedRef.current > 0 ? speedRef.current * 0.6 + instant * 0.4 : instant;
        speedSampleRef.current = { at: now, bytes: downloadedRef.current };
      }
    }

    setProgress((current) => {
      let next: UpdateProgress;
      if (event.event === "Started") {
        next = { ...event, data: { ...event.data, downloaded: 0, speed: 0 } };
      } else if (event.event === "Progress") {
        next = {
          ...event,
          data: {
            ...event.data,
            contentLength: current?.data?.contentLength,
            downloaded: downloadedRef.current,
            speed: speedRef.current,
          },
        };
      } else {
        next = {
          ...event,
          data: {
            contentLength: current?.data?.contentLength,
            downloaded: current?.data?.downloaded,
            speed: current?.data?.speed,
          },
        };
      }

      localStorage.setItem(DOWNLOAD_PROGRESS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const installUpdate = useCallback(async () => {
    if (!update || downloading) {
      return null;
    }

    storeDownloading(true);
    storeProgress(null);
    downloadedRef.current = 0;
    speedRef.current = 0;
    speedSampleRef.current = null;
    try {
      const result = await downloadAndInstallUpdate(handleProgress);
      if (result === "installed") {
        storeAvailableVersion(null);
        await relaunch();
      } else if (result === "up-to-date") {
        setUpdate(null);
        storeAvailableVersion(null);
      } else {
        storeProgress(null);
      }
      return result;
    } finally {
      storeDownloading(false);
      setCancelling(false);
    }
  }, [downloading, handleProgress, storeAvailableVersion, storeDownloading, storeProgress, update]);

  const cancelDownload = useCallback(async () => {
    if (!downloading || cancelling) {
      return false;
    }

    setCancelling(true);
    try {
      return await cancelUpdateDownload();
    } finally {
      setCancelling(false);
    }
  }, [cancelling, downloading]);

  const skipUpdate = useCallback(() => {
    const version = update?.version ?? availableVersion;
    if (!version) {
      return;
    }

    setSkippedVersion(version);
    skippedVersionRef.current = version;
    localStorage.setItem(SKIPPED_VERSION_STORAGE_KEY, version);
  }, [availableVersion, update]);

  const value = useMemo(
    () => ({
      update,
      availableVersion,
      skippedVersion,
      hasUpdate: availableVersion !== null,
      checking,
      checkingEndpoint,
      downloading,
      cancelling,
      progress,
      checkUpdate,
      installUpdate,
      cancelDownload,
      skipUpdate,
      openUpdateWindow,
    }),
    [
      update,
      availableVersion,
      skippedVersion,
      checking,
      checkingEndpoint,
      downloading,
      cancelling,
      progress,
      checkUpdate,
      installUpdate,
      cancelDownload,
      skipUpdate,
    ]
  );

  return <UpdaterContext.Provider value={value}>{children}</UpdaterContext.Provider>;
}

export function useUpdater() {
  const context = useContext(UpdaterContext);
  if (!context) {
    throw new Error("useUpdater must be used inside UpdaterProvider");
  }

  return context;
}

/**
 * Manual "Check for Updates" (the About window's button). Unlike the startup
 * check it forces the prompt even for a skipped version — the user asked.
 */
export function useManualUpdateCheck() {
  const { checkUpdate, checking, checkingEndpoint, downloading, openUpdateWindow } = useUpdater();
  const [showNoUpdate, setShowNoUpdate] = useState(false);
  const { t } = useAppTranslation();

  const handleCheckUpdate = useCallback(async () => {
    setShowNoUpdate(false);

    if (downloading) {
      openUpdateWindow();
      return;
    }

    const result = await checkUpdate({ force: true });

    if (result.status === "up-to-date") {
      setShowNoUpdate(true);
      return;
    }

    if (result.status === "error") {
      toast.error(t("updater.checkFailed"), { description: updateErrorMessage(result.error) });
    }
  }, [checkUpdate, downloading, openUpdateWindow, t]);

  return {
    checkUpdate: handleCheckUpdate,
    checking,
    checkingEndpoint,
    downloading,
    showNoUpdate,
    dismissNoUpdate: () => setShowNoUpdate(false),
  };
}
