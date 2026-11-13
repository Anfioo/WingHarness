import { useCallback, useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import type { ScoopPlan, ScoopStatus } from "@/commands";
import { scoopApplyLocation, scoopPlanRun, scoopPrepareInstall, scoopStatus } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  envRecord,
  loadScoopPrefs,
  saveScoopPrefs,
  type ScoopPrefs,
  type ScoopRun,
} from "@/lib/scoop/page";

export type ScoopRunKind = "install" | "app" | "search" | "config";
export type ScoopLogTone = "info" | "error" | "done";

export interface ScoopLogEntry {
  id: number;
  text: string;
  tone: ScoopLogTone;
}

export interface ScoopPageController {
  status: ScoopStatus | null;
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
      if (code === 0 && (kind === "install" || kind === "app")) {
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

  const runScoop = useCallback(
    async (kind: "install" | "search", spec: string) => {
      if (running || !beginPreparation()) return;
      try {
        const next = await scoopPlanRun({
          kind,
          spec,
          proxyMode: prefs.proxyMode,
          proxyUrl: prefs.proxyUrl,
        });
        startPlan(next, kind === "search" ? "search" : "app");
      } catch (error) {
        appendLog(t("scoop.run.prepareFailed", { message: messageOf(error) }), "error");
      } finally {
        endPreparation();
      }
    },
    [appendLog, beginPreparation, endPreparation, prefs, running, startPlan, t]
  );

  const installApp = useCallback((spec: string) => runScoop("install", spec), [runScoop]);
  const searchOnline = useCallback((spec: string) => runScoop("search", spec), [runScoop]);

  const syncProxy = useCallback(async () => {
    if (running || !beginPreparation()) return;
    try {
      const next = await scoopPlanRun({
        kind: "config",
        spec: "",
        proxyMode: prefs.proxyMode,
        proxyUrl: prefs.proxyUrl,
      });
      startPlan(next, "config");
    } catch (error) {
      appendLog(t("scoop.run.prepareFailed", { message: messageOf(error) }), "error");
    } finally {
      endPreparation();
    }
  }, [appendLog, beginPreparation, endPreparation, prefs, running, startPlan, t]);

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
    searchOnline,
    syncProxy,
    clearRun,
    relaunchApp,
  };
}
