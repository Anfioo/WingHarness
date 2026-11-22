// The action progress dialog: the script running one command at a time, with
// the live output below. It cannot be dismissed while a command is running;
// once the action ends the tab closes it or leaves the failure output open.

import { useEffect, useRef } from "react";

import type { MiseErrorCode, MiseHealthLevel } from "@/commands";
import { StatusBadge } from "@/components/mise/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { MiseToolProgressStatus } from "@/hooks/use-mise-tools";
import { miseErrorKey } from "@/lib/mise/error-key";

export type ActionProgressDialogProps = {
  open: boolean;
  title: string;
  totalCommands: number;
  completedCommands: number;
  currentCommand: string;
  /** One-based index of the running command; 0 before the first one starts. */
  commandIndex: number;
  logs: string[];
  status: MiseToolProgressStatus;
  errorCode: MiseErrorCode | null;
  onOpenChange: (open: boolean) => void;
};

const STATUS_LEVEL: Record<MiseToolProgressStatus, MiseHealthLevel> = {
  running: "info",
  success: "healthy",
  failure: "critical",
};

export function ActionProgressDialog({
  open,
  title,
  totalCommands,
  completedCommands,
  currentCommand,
  commandIndex,
  logs,
  status,
  errorCode,
  onOpenChange,
}: ActionProgressDialogProps) {
  const { t } = useAppTranslation();
  const running = status === "running";
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = logRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [logs]);

  const statusLabel =
    status === "running"
      ? t("mise.tools.progress.running")
      : status === "success"
        ? t("mise.history.status.success")
        : t("mise.history.status.failure");

  const runningFraction = running && commandIndex > completedCommands ? 0.4 : 0;
  const percent =
    totalCommands > 0
      ? Math.min(100, ((completedCommands + runningFraction) / totalCommands) * 100)
      : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && running) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={!running}>
        <DialogHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-2 pr-6">
            <StatusBadge level={STATUS_LEVEL[status]} label={statusLabel} />
            <DialogTitle className="min-w-0 break-words">
              {title || t("mise.tools.progress.title")}
            </DialogTitle>
          </div>
          <DialogDescription>
            {totalCommands > 0
              ? t("mise.tools.progress.command", {
                  index: Math.max(commandIndex, 1),
                  total: totalCommands,
                })
              : t("mise.tools.progress.starting")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Progress value={percent} />

          {currentCommand && (
            <pre className="bg-muted max-h-24 overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-text">
              {currentCommand}
            </pre>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">{t("mise.tools.progress.output")}</span>
            <div
              ref={logRef}
              role="log"
              className="bg-muted/40 h-64 overflow-y-auto rounded-md border p-3 font-mono text-xs leading-relaxed"
            >
              {logs.length === 0 ? (
                <span className="text-muted-foreground">{t("mise.tools.progress.starting")}</span>
              ) : (
                logs.map((line, index) => (
                  <p key={`${index}-${line}`} className="break-all whitespace-pre-wrap select-text">
                    {line}
                  </p>
                ))
              )}
            </div>
          </div>

          {status === "failure" && (
            <div className="text-destructive flex flex-col gap-1 text-xs" role="alert">
              <span>{t("mise.tools.progress.failure")}</span>
              {errorCode && <span className="break-words">{t(miseErrorKey(errorCode))}</span>}
            </div>
          )}
        </div>

        <DialogFooter>
          {running ? (
            <span className="text-muted-foreground text-xs">{t("mise.tools.action.busy")}</span>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("mise.tools.progress.close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
