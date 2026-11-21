// The connections tab: TCP/UDP endpoints with their owning process, the
// filter and search bar, and the reset behind "Close connection".

import { useLayoutEffect, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { argusErrorKey, isArgusError, type Connection, type ProcessRow } from "@/commands";
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
import { useTaskManagerConnections } from "@/hooks/use-task-manager-connections";
import { processLabel } from "@/lib/task-manager/process-identity";
import { ConnectionsTable } from "@/components/task-manager/connections-table";
import { ConnectionsToolbar } from "@/components/task-manager/connections-toolbar";

type PendingKill = { pid: number; createTime: number; name: string };

export function ConnectionsTab() {
  const { t } = useAppTranslation();
  const page = useTaskManager();
  const manager = useTaskManagerConnections(page.activeTab === "connections");
  const [pendingKill, setPendingKill] = useState<PendingKill | null>(null);

  // The page hook reports a failed kill through `error` rather than rejecting,
  // so the toast helper reads the newest value after the state update lands.
  const errorRef = useRef(page.error);
  useLayoutEffect(() => {
    errorRef.current = page.error;
  }, [page.error]);

  const reveal = (connection: Connection) => {
    if (!manager.processes.has(connection.pid)) {
      toast.error(t("taskManager.connections.hints.processExited"));
      return;
    }
    page.revealProcess(connection.pid);
  };

  const requestKill = (connection: Connection, process: ProcessRow) => {
    setPendingKill({
      pid: connection.pid,
      createTime: process.createTime,
      name: processLabel(process),
    });
  };

  const confirmKill = () => {
    const target = pendingKill;
    setPendingKill(null);
    if (!target) return;
    void (async () => {
      await page.killProcess(target.pid, target.createTime);
      // Let the hook's setError (or setError(null)) commit before reading it.
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
      const failure = errorRef.current;
      if (failure) toast.error(t(argusErrorKey(failure.code)));
      else toast.success(t("taskManager.toast.killDone", { name: target.name }));
      await manager.load();
    })();
  };

  const errorMessage = manager.error
    ? isArgusError(manager.error)
      ? t(argusErrorKey(manager.error.code))
      : t("taskManager.error.internal")
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <ConnectionsToolbar
        query={manager.query}
        onQueryChange={manager.setQuery}
        filter={manager.filter}
        onFilterChange={manager.setFilter}
        onRefresh={() => void manager.load()}
        loading={manager.loading}
        stats={manager.stats}
      />

      {errorMessage && manager.connections.length > 0 && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {errorMessage}
        </div>
      )}

      {manager.loading && manager.connections.length === 0 ? (
        <div
          role="status"
          className="border-border bg-card flex min-h-0 flex-1 flex-col gap-3 rounded-xl border p-4"
        >
          <span className="sr-only">{t("taskManager.connections.empty.loading")}</span>
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-7 w-full" />
          ))}
        </div>
      ) : errorMessage && manager.connections.length === 0 ? (
        <div className="border-border bg-card flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border text-center">
          <AlertCircle className="text-destructive size-6" />
          <p className="text-sm font-medium">{errorMessage}</p>
          <Button variant="outline" size="sm" onClick={() => void manager.load()}>
            {t("taskManager.actions.refresh")}
          </Button>
        </div>
      ) : manager.rows.length === 0 ? (
        <div className="border-border bg-card flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border text-center">
          <p className="text-sm font-medium">
            {manager.connections.length === 0
              ? t("taskManager.connections.empty.none")
              : t("taskManager.connections.empty.noMatch")}
          </p>
          {manager.connections.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                manager.setQuery("");
                manager.setFilter("all");
              }}
            >
              {t("taskManager.connections.empty.clear")}
            </Button>
          )}
        </div>
      ) : (
        <ConnectionsTable
          rows={manager.rows}
          processes={manager.processes}
          serviceReady={manager.serviceReady}
          onReveal={reveal}
          onKill={requestKill}
          onClose={(connection) => void manager.close(connection)}
        />
      )}

      <AlertDialog
        open={pendingKill !== null}
        onOpenChange={(open) => {
          if (!open) setPendingKill(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("taskManager.confirm.killTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingKill
                ? t("taskManager.confirm.killBody", {
                    name: pendingKill.name,
                    pid: pendingKill.pid,
                  })
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("taskManager.actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={confirmKill}
            >
              {t("taskManager.actions.kill")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
