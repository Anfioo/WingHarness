import { useCallback, useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import type { ScoopPlan, ScoopRunRequest, ScoopStatus } from "@/commands";
import {
  scoopApplyLocation,
  scoopInstalled,
  scoopPlanRun,
  scoopPrepareInstall,
  scoopStatus,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  envRecord,
  loadScoopPrefs,
  saveScoopPrefs,
  type ScoopPrefs,
  type ScoopRun,
} from "@/lib/scoop/page";

export type ScoopRunKind =
  | "install"
  | "app"
  | "search"
  | "bucket"
  | "update"
  | "apps-update"
  | "app-update"
  | "hold"
  | "uninstall"
  | "config";
export type ScoopLogTone = "info" | "error" | "done";

export interface ScoopLogEntry {
  id: number;
  text: string;
  tone: ScoopLogTone;
}

export interface ScoopPageController {
  status: ScoopStatus | null;
  /** Whether the install folder is there, known before `status` is. */
  quickInstalled: boolean | null;
  loading: boolean;
  statusError: string | null;
  prefs: ScoopPrefs;
  setPrefs: (patch: Partial<ScoopPrefs>) => void;
  plan: ScoopPlan | null;
  run: ScoopRun | null;
  running: ScoopRunKind | null;
  /** A backend call is preparing the run (folders, links, script). */
  preparing: boolean;
  lastExit: number | null;
  logs: ScoopLogEntry[];
  restartNeeded: boolean;
  refresh: () => Promise<void>;
  onRunExit: (code: number | null) => void;
  prepareInstall: () => Promise<void>;
  /** Points both links at an existing install: the `SCOOP` folder found and
   * the default global folder. Nothing is reinstalled. */
  adopt: () => Promise<void>;
  installApp: (spec: string) => Promise<void>;
  /** Clones a bucket with the given name and repository address. */
  addBucket: (name: string, url: string) => Promise<void>;
  /** Runs `scoop update`: Scoop itself and every cloned bucket. */
  updateBuckets: () => Promise<void>;
  /** Runs `scoop update *`: every app, with the held ones skipped by Scoop. */
  updateApps: () => Promise<void>;
  /** Updates one app (`scoop update <app>`), global apps included. */
  updateApp: (app: { name: string; global: boolean }) => Promise<void>;
  /** Pins an app at its version (`scoop hold`), or releases it. */
  setAppHold: (app: { name: string; global: boolean }, hold: boolean) => Promise<void>;
  /** Uninstalls one app (`scoop uninstall [-g] [-p] <app>`). */
  uninstallApp: (app: { name: string; global: boolean }, purge: boolean) => Promise<void>;
  searchOnline: (spec: string) => Promise<void>;
  syncProxy: () => Promise<void>;
  clearRun: () => void;
  relaunchApp: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Page state and the actions that start a terminal run.
 *
 * A run is deliberately one at a time: the backend writes a single `run.cmd`
 * and the page shows a single terminal, so a second click while one is running
 * would race for the same file.
 */
export function useScoopPage(): ScoopPageController {
  const { t } = useAppTranslation();
  const [status, setStatus] = useState<ScoopStatus | null>(null);
  const [quickInstalled, setQuickInstalled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [prefs, setPrefsState] = useState<ScoopPrefs>(loadScoopPrefs);
  const [plan, setPlan] = useState<ScoopPlan | null>(null);
  const [run, setRun] = useState<ScoopRun | null>(null);
  const [running, setRunning] = useState<ScoopRunKind | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [lastExit, setLastExit] = useState<number | null>(null);
  const [logs, setLogs] = useState<ScoopLogEntry[]>([]);
  const [restartNeeded, setRestartNeeded] = useState(false);

  const logIdRef = useRef(0);
  const runIdRef = useRef(0);
  const runKindRef = useRef<ScoopRunKind | null>(null);
  const pendingRef = useRef(false);

  const beginPreparation = useCallback(() => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPreparing(true);
    return true;
  }, []);

  const endPreparation = useCallback(() => {
    pendingRef.current = false;
    setPreparing(false);
  }, []);

  const appendLog = useCallback((text: string, tone: ScoopLogTone = "info") => {
    const id = (logIdRef.current += 1);
    setLogs((current) => [...current, { id, text, tone }]);
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await scoopStatus();
      setStatus(next);
      setStatusError(null);
    } catch (error) {
      setStatusError(messageOf(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The install folder answers "installed" in a few milliseconds; the full
  // status walks the catalog and asks the CLI for its version, so the page
  // starts from this and corrects itself when `status` lands.
  useEffect(() => {
    void scoopInstalled().then(setQuickInstalled, () => setQuickInstalled(null));
  }, []);

  const setPrefs = useCallback((patch: Partial<ScoopPrefs>) => {
    setPrefsState((current) => {
      const next = { ...current, ...patch };
      saveScoopPrefs(next);
      return next;
    });
  }, []);

  const startPlan = useCallback(
    (next: ScoopPlan, kind: ScoopRunKind) => {
      next.log.forEach((line) => appendLog(line));
      appendLog(t("scoop.run.launching", { command: next.command }));
      setPlan(next);
      setLastExit(null);
      setRunning(kind);
      runKindRef.current = kind;
      setRun({
        id: (runIdRef.current += 1),
        command: next.command,
        cwd: next.workDir,
        env: envRecord(next.env),
      });
    },
    [appendLog, t]
  );

  const onRunExit = useCallback(
    (code: number | null) => {
      const kind = runKindRef.current;
      runKindRef.current = null;
      setRunning(null);
      setLastExit(code);
      if (code === 0) {
        appendLog(t("scoop.run.exitedOk"), "done");
      } else {
        appendLog(t("scoop.run.exitedFail", { code: code ?? "?" }), "error");
      }
      if (code === 0 && kind !== "search" && kind !== "config") {
        if (kind === "install") setRestartNeeded(true);
        void refresh(true);
      }
    },
    [appendLog, refresh, t]
  );

  const prepareInstall = useCallback(async () => {
    if (running || !beginPreparation()) return;
    try {
      const next = await scoopPrepareInstall({
        scoop: prefs.scoop,
        scoopGlobal: prefs.global,
        proxyMode: prefs.proxyMode,
        proxyUrl: prefs.proxyUrl,
      });
      startPlan(next, "install");
    } catch (error) {
      appendLog(t("scoop.run.prepareFailed", { message: messageOf(error) }), "error");
    } finally {
      endPreparation();
    }
  }, [appendLog, beginPreparation, endPreparation, prefs, running, startPlan, t]);

  const adopt = useCallback(async () => {
    if (running || !beginPreparation()) return;
    const found = status?.otherInstall;
    if (!found) {
      endPreparation();
      return;
    }
    try {
      const next = await scoopApplyLocation({
        scoop: { location: "custom", customPath: found },
        scoopGlobal: { location: "data", customPath: "" },
      });
      setStatus(next);
      appendLog(t("scoop.run.adopted", { path: next.target }), "done");
      setRestartNeeded(true);
    } catch (error) {
      appendLog(t("scoop.run.prepareFailed", { message: messageOf(error) }), "error");
    } finally {
      endPreparation();
    }
  }, [appendLog, beginPreparation, endPreparation, running, status, t]);

  const runPlan = useCallback(
    async (
      request: Pick<ScoopRunRequest, "kind" | "spec" | "global" | "purge">,
      kind: ScoopRunKind
    ) => {
      if (running || !beginPreparation()) return;
      try {
        const next = await scoopPlanRun({
          ...request,
          proxyMode: prefs.proxyMode,
          proxyUrl: prefs.proxyUrl,
        });
        startPlan(next, kind);
      } catch (error) {
        appendLog(t("scoop.run.prepareFailed", { message: messageOf(error) }), "error");
      } finally {
        endPreparation();
      }
    },
    [appendLog, beginPreparation, endPreparation, prefs, running, startPlan, t]
  );

  const installApp = useCallback(
    (spec: string) => runPlan({ kind: "install", spec }, "app"),
    [runPlan]
  );
  const searchOnline = useCallback(
    (spec: string) => runPlan({ kind: "search", spec }, "search"),
    [runPlan]
  );

  /** `scoop bucket add <name> <url>`; the bucket list refreshes on success. */
  const addBucket = useCallback(
    (name: string, url: string) => runPlan({ kind: "bucket", spec: `${name} ${url}` }, "bucket"),
    [runPlan]
  );

  /** `scoop update`: Scoop itself and every cloned bucket. */
  const updateBuckets = useCallback(
    () => runPlan({ kind: "update", spec: "" }, "update"),
    [runPlan]
  );

  /** `scoop update *`: Scoop skips the held apps itself, which is what a pin
   * is for. Global apps follow in the same script when there are any. */
  const updateApps = useCallback(
    () => runPlan({ kind: "apps-update", spec: "" }, "apps-update"),
    [runPlan]
  );

  /** `scoop update [-g] <app>`; a held app is refused by Scoop, so the row
   * asks for an unhold first instead of offering this. */
  const updateApp = useCallback(
    (app: { name: string; global: boolean }) =>
      runPlan({ kind: "app-update", spec: app.name, global: app.global }, "app-update"),
    [runPlan]
  );

  /** `scoop hold` / `scoop unhold`: Scoop records the pin in the app's own
   * install info, which is the same flag `scoop update *` reads. */
  const setAppHold = useCallback(
    (app: { name: string; global: boolean }, hold: boolean) =>
      runPlan({ kind: hold ? "hold" : "unhold", spec: app.name, global: app.global }, "hold"),
    [runPlan]
  );

  /** `scoop uninstall [-g] [-p] <app>`: Scoop keeps the app's persist folder
   * unless `-p` is passed, which is the choice the confirmation offers. */
  const uninstallApp = useCallback(
    (app: { name: string; global: boolean }, purge: boolean) =>
      runPlan({ kind: "uninstall", spec: app.name, global: app.global, purge }, "uninstall"),
    [runPlan]
  );

  const syncProxy = useCallback(() => runPlan({ kind: "config", spec: "" }, "config"), [runPlan]);

  const clearRun = useCallback(() => {
    setPlan(null);
    setRun(null);
    setLastExit(null);
    setLogs([]);
  }, []);

  const relaunchApp = useCallback(() => {
    void relaunch();
  }, []);

  return {
    status,
    quickInstalled,
    loading,
    statusError,
    prefs,
    setPrefs,
    plan,
    run,
    running,
    preparing,
    lastExit,
    logs,
    restartNeeded,
    refresh: () => refresh(),
    onRunExit,
    prepareInstall,
    adopt,
    installApp,
    addBucket,
    updateBuckets,
    updateApps,
    updateApp,
    setAppHold,
    uninstallApp,
    searchOnline,
    syncProxy,
    clearRun,
    relaunchApp,
  };
}
