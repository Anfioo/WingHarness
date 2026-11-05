// Collapsible transfer queue shown under the two file panes.

import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Pause, Play, X } from "lucide-react";
import type { TransferSnapshot, TransferState } from "@/commands/services/servers/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatBytes } from "@/lib/servers/format";
import { cn } from "@/lib/utils";
import { basename } from "./paths";

const FINISHED_STATES: ReadonlySet<TransferState> = new Set(["done", "failed", "cancelled"]);
const ACTIVE_STATES: ReadonlySet<TransferState> = new Set(["pending", "running", "paused"]);

export type TransferQueueProps = {
  tasks: TransferSnapshot[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPause: (transferId: string) => void;
  onResume: (transferId: string) => void;
  onCancel: (transferId: string) => void;
  onClearFinished: () => void;
};

function percentOf(task: TransferSnapshot): number {
  if (task.total > 0)
    return Math.max(0, Math.min(100, Math.round((task.transferred / task.total) * 100)));
  return task.state === "done" ? 100 : 0;
}

export function TransferQueue({
  tasks,
  open,
  onOpenChange,
  onPause,
  onResume,
  onCancel,
  onClearFinished,
}: TransferQueueProps) {
  const { t, language } = useAppTranslation();

  const active = tasks.filter((task) => ACTIVE_STATES.has(task.state)).length;
  const finished = tasks.filter((task) => FINISHED_STATES.has(task.state)).length;
  const totalBytes = tasks.reduce((sum, task) => sum + (task.total > 0 ? task.total : 0), 0);
  const doneBytes = tasks.reduce(
    (sum, task) => sum + (task.total > 0 ? Math.min(task.transferred, task.total) : 0),
    0
  );
  const overall = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0;

  return (
    <div className="border-border bg-background rounded-md border">
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          type="button"
          className="hover:text-foreground text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs"
          onClick={() => onOpenChange(!open)}
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronUp className="size-3.5 shrink-0" />
          )}
          <span className="text-foreground shrink-0 font-medium">
            {t("servers.transfer.title", { defaultValue: "Transfers" })}
          </span>
          <span className="shrink-0 tabular-nums">
            {t("servers.transfer.summary", {
              active,
              finished,
              defaultValue: "{{active}} active · {{finished}} finished",
            })}
          </span>
          {totalBytes > 0 && (
            <span className="ml-1 w-24 shrink-0">
              <Progress value={overall} className="h-1" />
            </span>
          )}
        </button>
        {finished > 0 && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-muted-foreground shrink-0"
            onClick={onClearFinished}
          >
            {t("servers.transfer.clearFinished")}
          </Button>
        )}
      </div>

      {open && (
        <div className="border-border max-h-48 overflow-auto border-t">
          {tasks.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-center text-xs">
              {t("servers.transfer.empty", { defaultValue: "No transfers yet." })}
            </p>
          ) : (
            tasks.map((task) => {
              const percent = percentOf(task);
              const working = task.state === "running" || task.state === "pending";
              return (
                <div
                  key={task.transferId}
                  className={cn(
                    "border-border/60 flex items-center gap-2 border-b px-2 py-1.5 text-xs last:border-b-0",
                    task.state === "failed" && "bg-destructive/5"
                  )}
                >
                  <span
                    className="text-muted-foreground shrink-0"
                    title={
                      task.direction === "upload"
                        ? t("servers.sftp.upload")
                        : t("servers.sftp.download")
                    }
                  >
                    {task.direction === "upload" ? (
                      <ArrowUp className="size-3.5" />
                    ) : (
                      <ArrowDown className="size-3.5" />
                    )}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate" title={task.source}>
                        {basename(task.source)}
                      </span>
                      <span className="text-muted-foreground shrink-0">
                        {t(`servers.transfer.${task.state}`)}
                      </span>
                    </div>
                    <Progress value={percent} className="mt-1 h-1" />
                    <div className="text-muted-foreground mt-0.5 flex items-center justify-between gap-2 tabular-nums">
                      <span>
                        {task.total > 0
                          ? `${formatBytes(task.transferred, language)} / ${formatBytes(task.total, language)}`
                          : formatBytes(task.transferred, language)}
                      </span>
                      <span>
                        {task.bytesPerSec > 0 ? `${formatBytes(task.bytesPerSec, language)}/s` : ""}
                      </span>
                    </div>
                    {task.error && (
                      <p className="text-destructive truncate" title={task.error}>
                        {task.error}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-0.5">
                    {working && (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        title={t("servers.transfer.pause", { defaultValue: "Pause" })}
                        aria-label={t("servers.transfer.pause", { defaultValue: "Pause" })}
                        onClick={() => onPause(task.transferId)}
                      >
                        <Pause />
                      </Button>
                    )}
                    {task.state === "paused" && (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        title={t("servers.transfer.resume", { defaultValue: "Resume" })}
                        aria-label={t("servers.transfer.resume", { defaultValue: "Resume" })}
                        onClick={() => onResume(task.transferId)}
                      >
                        <Play />
                      </Button>
                    )}
                    {ACTIVE_STATES.has(task.state) && (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        title={t("servers.transfer.cancel", { defaultValue: "Cancel" })}
                        aria-label={t("servers.transfer.cancel", { defaultValue: "Cancel" })}
                        onClick={() => onCancel(task.transferId)}
                      >
                        <X />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
