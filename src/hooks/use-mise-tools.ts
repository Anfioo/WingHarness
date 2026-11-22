// The tools tab's data and action orchestration.
//
// The list loads once on mount; a tool's detail loads only when it is selected,
// with a request sequence so a slow response for the previous tool is dropped.
// Actions always open the preview first, then run through `miseActionRun` while
// the `mise:action-progress` event feeds the progress dialog.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  miseActionRun,
  miseErrorCode,
  miseHistoryRecordCanceled,
  miseToolDetail,
  miseToolDetailCancel,
  miseToolsList,
  type MiseActionProgress,
  type MiseErrorCode,
  type MiseHealthLevel,
  type MiseTool,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { miseErrorKey } from "@/lib/mise/error-key";

/** Event name, mirroring `mise-core/src/actions.rs`. */
export const MISE_ACTION_PROGRESS_EVENT = "mise:action-progress";

/** Everything an action preview dialog needs, already localized. */
export type MiseActionRequest = {
  title: string;
  summary: string;
  command: string;
  level: MiseHealthLevel;
  affectedFiles?: string[];
  impactScope?: string[];
  riskNotes?: string[];
  confirmLabel: string;
};

export type MiseToolProgressStatus = "running" | "success" | "failure";

export type MiseToolProgressState = {
  title: string;
  totalCommands: number;
  completedCommands: number;
  currentCommand: string;
  /** One-based index of the command currently running; 0 before it starts. */
  commandIndex: number;
  logs: string[];
  status: MiseToolProgressStatus;
  errorCode: MiseErrorCode | null;
};

export type MiseToolsState = {
  tools: MiseTool[];
  loading: boolean;
  error: MiseErrorCode | null;
  reload: () => Promise<void>;
  selectedId: string | null;
  selectedTool: MiseTool | null;
  detail: MiseTool | null;
  detailLoading: boolean;
  detailError: MiseErrorCode | null;
  select: (id: string) => void;
  cancelDetail: () => void;
  retryDetail: () => void;
  action: MiseActionRequest | null;
  previewAction: (request: MiseActionRequest) => void;
  closePreview: () => void;
  confirmAction: () => void;
  progress: MiseToolProgressState | null;
  closeProgress: () => void;
  busy: boolean;
};

/** Keep the log buffer bounded; mise can print a lot during an install. */
const MAX_LOG_LINES = 200;

function commandLines(script: string): string[] {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function initialProgress(request: MiseActionRequest): MiseToolProgressState {
  const commands = commandLines(request.command);
  return {
    title: request.title,
    totalCommands: commands.length,
    completedCommands: 0,
    currentCommand: commands[0] ?? request.command.trim(),
    commandIndex: 0,
    logs: [],
    status: "running",
    errorCode: null,
  };
}

function appendLogs(current: string[], text: string | null | undefined): string[] {
  if (!text) return current;

  const lines = text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return current;

  const next = [...current, ...lines];
  return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
}

type Translate = ReturnType<typeof useAppTranslation>["t"];

function applyProgress(
  state: MiseToolProgressState,
  event: MiseActionProgress,
  t: Translate
): MiseToolProgressState {
  switch (event.kind) {
    case "command-started":
      return {
        ...state,
        commandIndex: event.commandIndex,
        currentCommand: event.command,
        status: "running",
        logs: appendLogs(state.logs, `$ ${event.command}`),
      };
    case "output":
      return {
        ...state,
        commandIndex: event.commandIndex,
        currentCommand: event.command,
        status: "running",
        logs: appendLogs(state.logs, event.output),
      };
    case "command-finished":
      return {
        ...state,
        commandIndex: event.commandIndex,
        currentCommand: event.command,
        completedCommands: event.exitCode === 0 ? event.commandIndex : state.completedCommands,
        status: "running",
        logs: appendLogs(state.logs, `exit ${event.exitCode ?? -1}`),
      };
    case "lockfile-cleanup": {
      const report = event.lockfileCleanup;
      let logs = appendLogs(state.logs, t("mise.tools.progress.lockfileCleanup"));
      if (report) {
        if (report.removedPaths.length > 0) {
          logs = appendLogs(
            logs,
            t("mise.tools.progress.lockfileRemoved", { count: report.removedPaths.length })
          );
        }
        if (report.failedPaths.length > 0) {
          logs = appendLogs(
            logs,
            t("mise.tools.progress.lockfileFailed", { count: report.failedPaths.length })
          );
        }
      }
      return { ...state, logs };
    }
  }
}

export function useMiseTools(): MiseToolsState {
  const { t } = useAppTranslation();
  const [tools, setTools] = useState<MiseTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<MiseErrorCode | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MiseTool | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<MiseErrorCode | null>(null);
  const [action, setAction] = useState<MiseActionRequest | null>(null);
  const [progress, setProgress] = useState<MiseToolProgressState | null>(null);
  const [busy, setBusy] = useState(false);

  const aliveRef = useRef(true);
  const detailSeqRef = useRef(0);
  const detailIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const actionRef = useRef<MiseActionRequest | null>(null);
  const runningRef = useRef(false);
  const tRef = useRef(t);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const loadDetail = useCallback(async (id: string) => {
    const seq = detailSeqRef.current + 1;
    detailSeqRef.current = seq;
    detailIdRef.current = id;

    setDetailLoading(true);
    setDetailError(null);

    try {
      const next = await miseToolDetail(id);
      if (seq !== detailSeqRef.current || !aliveRef.current) return;
      setDetail(next);
    } catch (failure) {
      if (seq !== detailSeqRef.current || !aliveRef.current) return;
      const code = miseErrorCode(failure) ?? "internal";
      // A cancellation is a user choice, not an error row.
      if (code !== "cancelled") setDetailError(code);
    } finally {
      if (seq === detailSeqRef.current && aliveRef.current) setDetailLoading(false);
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    let loaded = false;

    try {
      const next = await miseToolsList();
      if (!aliveRef.current) return;
      setTools(next);
      setError(null);
      loaded = true;

      // The selected tool can disappear after an uninstall; drop the selection
      // instead of requesting a detail that no longer exists.
      const selected = selectedIdRef.current;
      if (selected && !next.some((tool) => tool.id === selected)) {
        selectedIdRef.current = null;
        detailIdRef.current = null;
        detailSeqRef.current += 1;
        setSelectedId(null);
        setDetail(null);
        setDetailError(null);
        setDetailLoading(false);
        return;
      }
    } catch (failure) {
      if (aliveRef.current) setError(miseErrorCode(failure) ?? "internal");
    } finally {
      if (aliveRef.current) setLoading(false);
    }

    // Refreshing the list also refreshes the selected tool's versions.
    const id = selectedIdRef.current;
    if (loaded && id && aliveRef.current) await loadDetail(id);
  }, [loadDetail]);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    return () => {
      aliveRef.current = false;
    };
  }, [reload]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void listen<MiseActionProgress>(MISE_ACTION_PROGRESS_EVENT, (event) => {
      if (!runningRef.current) return;
      setProgress((current) =>
        current ? applyProgress(current, event.payload, tRef.current) : current
      );
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const select = useCallback(
    (id: string) => {
      selectedIdRef.current = id;
      setSelectedId(id);
      if (detailIdRef.current === id) return;

      setDetail(null);
      setDetailError(null);
      void loadDetail(id);
    },
    [loadDetail]
  );

  const cancelDetail = useCallback(() => {
    const id = detailIdRef.current;
    if (!id) return;

    // Bump the sequence so the response already in flight is discarded, and
    // forget the loaded id so selecting the tool again requests it anew.
    detailSeqRef.current += 1;
    detailIdRef.current = null;
    setDetailLoading(false);
    setDetailError(null);
    void miseToolDetailCancel(id).catch(() => {
      // Cancelling is best effort; a missing request is already cancelled.
    });
  }, []);

  const retryDetail = useCallback(() => {
    const id = selectedIdRef.current;
    if (!id) return;
    void loadDetail(id);
  }, [loadDetail]);

  const previewAction = useCallback((request: MiseActionRequest) => {
    if (runningRef.current) {
      toast.error(tRef.current("mise.error.busy"));
      return;
    }
    actionRef.current = request;
    setAction(request);
  }, []);

  const closePreview = useCallback(() => {
    const request = actionRef.current;
    if (!request || runningRef.current) return;

    actionRef.current = null;
    setAction(null);
    void miseHistoryRecordCanceled(request.command)
      .then(() => toast.success(tRef.current("mise.history.recordCanceled")))
      .catch(() => {
        // The action was not run either way; a failed history write is not fatal.
      });
  }, []);

  const confirmAction = useCallback(() => {
    const request = actionRef.current;
    if (!request) return;
    if (runningRef.current) {
      toast.error(tRef.current("mise.error.busy"));
      return;
    }

    actionRef.current = null;
    setAction(null);
    runningRef.current = true;
    setBusy(true);
    setProgress(initialProgress(request));

    void (async () => {
      try {
        const result = await miseActionRun(request.command);
        if (!aliveRef.current) return;

        const failed = result.commands.some((command) => command.exitCode !== 0);
        if (failed) {
          // Keep the progress dialog open so the captured output stays readable.
          setProgress((current) => current && { ...current, status: "failure" });
          toast.error(tRef.current("mise.tools.progress.failure"));
          return;
        }

        setProgress(
          (current) =>
            current && { ...current, status: "success", completedCommands: current.totalCommands }
        );
        toast.success(tRef.current("mise.tools.progress.success"));
        await reload();
        if (aliveRef.current) setProgress(null);
      } catch (failure) {
        if (!aliveRef.current) return;
        const code = miseErrorCode(failure) ?? "internal";
        if (code === "busy") {
          // Another window or action holds the gate; nothing was started.
          setProgress(null);
          toast.error(tRef.current("mise.error.busy"));
        } else {
          setProgress((current) => current && { ...current, status: "failure", errorCode: code });
          toast.error(tRef.current(miseErrorKey(code)));
        }
      } finally {
        runningRef.current = false;
        if (aliveRef.current) setBusy(false);
      }
    })();
  }, [reload]);

  const closeProgress = useCallback(() => {
    if (runningRef.current) return;
    setProgress(null);
  }, []);

  const selectedTool = tools.find((tool) => tool.id === selectedId) ?? null;

  return {
    tools,
    loading,
    error,
    reload,
    selectedId,
    selectedTool,
    detail,
    detailLoading,
    detailError,
    select,
    cancelDetail,
    retryDetail,
    action,
    previewAction,
    closePreview,
    confirmAction,
    progress,
    closeProgress,
    busy,
  };
}
