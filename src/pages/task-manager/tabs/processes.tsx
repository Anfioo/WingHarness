// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The processes tab: the three views over one snapshot subscription, the
// detail sheet, and the confirmations behind the destructive actions.

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getName } from "@tauri-apps/api/app";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { argusErrorKey, type ArgusError, type Priority, type ProcessRow } from "@/commands";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager } from "@/hooks/use-task-manager";
import { procKey, processLabel } from "@/lib/task-manager/process-identity";
import {
  buildProcessRows,
  countDescendants,
  DEFAULT_PROCESS_SORT,
  type ProcessSort,
  type ProcessTableRow,
  type ProcessView,
} from "@/lib/task-manager/process-sections";
import { ProcessDetail } from "@/components/task-manager/process-detail";
import { ProcessTable } from "@/components/task-manager/process-table";
import { ProcessToolbar } from "@/components/task-manager/process-toolbar";
import type { ProcessActions } from "@/components/task-manager/process-context-menu";

type PendingAction =
  | { kind: "kill"; process: ProcessRow }
  | { kind: "killTree"; process: ProcessRow; count: number }
  | { kind: "realtime"; process: ProcessRow };

const SKELETON_ROWS = 10;

function toggleInSet(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function ProcessSkeleton() {
  return (
    <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
      <div className="bg-muted/40 h-8 shrink-0 border-b" />
      <div className="flex flex-col">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <div key={index} className="border-border/50 flex h-8 items-center gap-3 border-b px-3">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="ml-auto h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ProcessEmpty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-border bg-card flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-xl border px-6 py-12 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground max-w-md text-xs">{body}</p>
      {action}
    </div>
  );
}

export function ProcessesTab() {
  const { t } = useAppTranslation();
  const page = useTaskManager();
  const snapshot = page.snapshot;
  const processes = useMemo(() => snapshot?.processes ?? [], [snapshot]);

  const [view, setView] = useState<ProcessView>("apps");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<ProcessSort>(DEFAULT_PROCESS_SORT);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedNodes, setCollapsedNodes] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [selfNames, setSelfNames] = useState<ReadonlySet<string>>(
    () => new Set(["wingharness", "wingharness.exe"])
  );
  // Kept in a ref so the row actions keep one identity across snapshots.
  const processesRef = useRef(processes);
  useLayoutEffect(() => {
    processesRef.current = processes;
  }, [processes]);

  // The hook reports a failed action through `error` rather than rejecting, so
  // the toast helper reads the newest value after the state update lands.
  const errorRef = useRef<ArgusError | null>(null);
  useLayoutEffect(() => {
    errorRef.current = page.error;
  }, [page.error]);

  // This app's own executable, so its process is never ended from here.
  useEffect(() => {
    let cancelled = false;
    void getName()
      .then((name) => {
        if (!cancelled) setSelfNames(new Set([name, `${name}.exe`]));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(
    () =>
      buildProcessRows(processes, {
        view,
        sort,
        query: deferredQuery,
        expandedGroups,
        collapsedNodes,
      }),
    [processes, view, sort, deferredQuery, expandedGroups, collapsedNodes]
  );

  const selectedProcess = useMemo(
    () =>
      selectedKey ? (processes.find((process) => procKey(process) === selectedKey) ?? null) : null,
    [processes, selectedKey]
  );

  // A snapshot no longer contains the selected process: it exited.
  useEffect(() => {
    if (selectedKey !== null && selectedProcess === null) {
      setSelectedKey(null);
      setDetailOpen(false);
    }
  }, [selectedKey, selectedProcess]);

  const runAction = useCallback(
    async (action: () => Promise<void>, success: string) => {
      await action();
      // Let the hook's setError (or setError(null)) commit before reading it.
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
      const failure = errorRef.current;
      if (failure) toast.error(t(argusErrorKey(failure.code)));
      else toast.success(success);
    },
    [t]
  );

  const { killProcess, killTree, setPriority, setEfficiency, refresh, setPaused, paused } = page;

  const requestKill = useCallback((process: ProcessRow) => {
    setPending({ kind: "kill", process });
  }, []);

  const requestKillTree = useCallback((process: ProcessRow) => {
    setPending({
      kind: "killTree",
      process,
      count: countDescendants(processesRef.current, process),
    });
  }, []);

  const requestRealtime = useCallback((process: ProcessRow) => {
    setPending({ kind: "realtime", process });
  }, []);

  const applyPriority = useCallback(
    (process: ProcessRow, priority: Priority) => {
      const name = processLabel(process);
      void runAction(
        () => setPriority(process.pid, process.createTime, priority),
        t("taskManager.toast.priorityDone", {
          name,
          priority: t(`taskManager.details.priority.${priority}`),
        })
      );
    },
    [runAction, setPriority, t]
  );

  const applyEfficiency = useCallback(
    (process: ProcessRow, on: boolean) => {
      const name = processLabel(process);
      void runAction(
        () => setEfficiency(process.pid, process.createTime, on),
        t(on ? "taskManager.toast.efficiencyOn" : "taskManager.toast.efficiencyOff", { name })
      );
    },
    [runAction, setEfficiency, t]
  );

  const serviceReady = page.service?.state === "running";

  const actions = useMemo<ProcessActions>(
    () => ({
      serviceReady,
      selfNames,
      onRequestKill: requestKill,
      onRequestKillTree: requestKillTree,
      onSetPriority: applyPriority,
      onRequestRealtime: requestRealtime,
      onSetEfficiency: applyEfficiency,
    }),
    [
      serviceReady,
      selfNames,
      requestKill,
      requestKillTree,
      applyPriority,
      requestRealtime,
      applyEfficiency,
    ]
  );

  const toggleRow = useCallback((row: ProcessTableRow) => {
    if (row.kind === "group") setExpandedGroups((current) => toggleInSet(current, row.key));
    else setCollapsedNodes((current) => toggleInSet(current, row.key));
  }, []);

  const selectRow = useCallback((row: ProcessTableRow, openDetail: boolean) => {
    if (row.kind !== "process") return;
    setSelectedKey(row.key);
    if (openDetail) setDetailOpen(true);
  }, []);

  const confirmPending = () => {
    const target = pending;
    setPending(null);
    if (!target) return;
    const process = target.process;
    const name = processLabel(process);
    if (target.kind === "kill") {
      void runAction(
        () => killProcess(process.pid, process.createTime),
        t("taskManager.toast.killDone", { name })
      );
      return;
    }
    if (target.kind === "killTree") {
      void runAction(
        () => killTree(process.pid, process.createTime),
        t("taskManager.toast.killTreeDone", { name, count: target.count })
      );
      return;
    }
    void runAction(
      () => setPriority(process.pid, process.createTime, "realtime"),
      t("taskManager.toast.priorityDone", {
        name,
        priority: t("taskManager.details.priority.realtime"),
      })
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <ProcessToolbar
        query={query}
        onQueryChange={setQuery}
        view={view}
        onViewChange={setView}
        sort={sort}
        onSortChange={setSort}
        paused={paused}
        onTogglePaused={() => setPaused(!paused)}
        onRefresh={() => void refresh()}
        processCount={processes.length}
        serviceReady={serviceReady}
      />

      {!snapshot && page.loading ? (
        <ProcessSkeleton />
      ) : !snapshot && page.error ? (
        <ProcessEmpty
          icon={<AlertCircle className="size-6" />}
          title={t("taskManager.process.error.title")}
          body={t(argusErrorKey(page.error.code))}
          action={
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              {t("taskManager.actions.refresh")}
            </Button>
          }
        />
      ) : snapshot && processes.length === 0 ? (
        <ProcessEmpty
          icon={<AlertCircle className="size-6" />}
          title={t("taskManager.process.empty.title")}
          body={t("taskManager.empty.processes")}
        />
      ) : rows.length === 0 ? (
        <ProcessEmpty
          icon={<AlertCircle className="size-6" />}
          title={t("taskManager.process.noMatch.title")}
          body={t("taskManager.process.noMatch.body", { query: deferredQuery.trim() })}
          action={
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>
              {t("taskManager.process.search.clear")}
            </Button>
          }
        />
      ) : (
        <ProcessTable
          rows={rows}
          selectedKey={selectedKey}
          showNetwork={snapshot?.processNetwork ?? false}
          sort={sort}
          actions={actions}
          onSortChange={setSort}
          onSelect={selectRow}
          onToggle={toggleRow}
        />
      )}

      <ProcessDetail
        process={selectedProcess}
        open={detailOpen}
        processNetwork={snapshot?.processNetwork ?? false}
        actions={actions}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) setSelectedKey(null);
        }}
      />

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "killTree"
                ? t("taskManager.confirm.treeTitle")
                : pending?.kind === "realtime"
                  ? t("taskManager.confirm.priorityTitle")
                  : t("taskManager.confirm.killTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "killTree"
                ? t("taskManager.confirm.treeBody", {
                    name: processLabel(pending.process),
                    pid: pending.process.pid,
                    count: pending.count,
                  })
                : pending?.kind === "realtime"
                  ? t("taskManager.confirm.priorityBody", {
                      name: processLabel(pending.process),
                    })
                  : pending
                    ? t("taskManager.confirm.killBody", {
                        name: processLabel(pending.process),
                        pid: pending.process.pid,
                      })
                    : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("taskManager.actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={confirmPending}
            >
              {pending?.kind === "killTree"
                ? t("taskManager.actions.killTree")
                : pending?.kind === "realtime"
                  ? t("taskManager.confirm.priorityConfirm")
                  : t("taskManager.actions.kill")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
