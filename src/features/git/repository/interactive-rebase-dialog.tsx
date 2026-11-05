import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GitCommitHorizontal, GripVertical, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { HelpTip } from "@/components/ui/help-tip";
import { cn } from "@/lib/utils";
import { rebaseCommits, rebaseInteractive } from "@/commands";
import type { CommitInfo, RebaseTodoAction, RebaseTodoEntry } from "@/lib/git-core/types";
import { useRepo } from "@/features/git/repository-store";
import { useUi } from "@/features/git/ui-store";
import { useUndo } from "@/features/git/history/undoStore";
import { useAppTranslation } from "@/hooks/use-app-translation";

const ACTIONS: RebaseTodoAction[] = ["pick", "reword", "squash", "fixup", "drop"];

interface PlanRow {
  commit: CommitInfo;
  action: RebaseTodoAction;
  message: string;
}

function fullMessage(commit: CommitInfo): string {
  return commit.body ? `${commit.summary}\n\n${commit.body}` : commit.summary;
}

function contextBaseOid(context: unknown): string {
  if (!context || typeof context !== "object") return "";
  const value = context as { baseOid?: string };
  return typeof value.baseOid === "string" ? value.baseOid : "";
}

function stillOpenFor(baseOid: string): boolean {
  const { dialog, dialogContext } = useUi.getState();
  return dialog === "interactiveRebase" && contextBaseOid(dialogContext) === baseOid;
}

function presetAction(
  commit: CommitInfo,
  squashOids: Set<string>,
  dropOids: Set<string>,
  seenSquash: Set<boolean>
): RebaseTodoAction {
  if (squashOids.has(commit.oid)) {
    if (seenSquash.size === 0) {
      seenSquash.add(true);
      return "pick";
    }
    return "squash";
  }
  if (dropOids.has(commit.oid)) return "drop";
  return "pick";
}

export function InteractiveRebaseDialog() {
  const { t } = useAppTranslation();
  const repo = useRepo((s) => s.repo);
  const { dialog, dialogContext } = useUi();
  const open = dialog === "interactiveRebase" && Boolean(dialogContext);
  const baseOid = open ? contextBaseOid(dialogContext) : "";
  const path = repo?.path ?? "";

  const [rows, setRows] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [draggingOid, setDraggingOid] = useState<string | null>(null);
  const [dropOid, setDropOid] = useState<string | null>(null);

  useEffect(() => {
    if (!baseOid || !path) return;
    setRows([]);
    setLoading(true);
    let active = true;
    (async () => {
      try {
        const commits = await rebaseCommits(path, baseOid);
        if (!active || !stillOpenFor(baseOid)) return;
        const context = dialogContext as { squashOids?: string[]; dropOids?: string[] } | null;
        const squashOids = new Set(context?.squashOids ?? []);
        const dropOids = new Set(context?.dropOids ?? []);
        const seenSquash = new Set<boolean>();
        setRows(
          [...commits].reverse().map((commit) => ({
            commit,
            action: presetAction(commit, squashOids, dropOids, seenSquash),
            message: "",
          }))
        );
        setLoading(false);
      } catch (error) {
        if (!active || !stillOpenFor(baseOid)) return;
        toast.error(
          t("gitRepo.sidebar.rebase.failed", {
            error: (error as { message?: string })?.message ?? String(error),
          })
        );
        useUi.getState().closeDialog();
      }
    })();
    return () => {
      active = false;
    };
  }, [baseOid, path, dialogContext, t]);

  function setAction(oid: string, action: RebaseTodoAction) {
    setRows((current) =>
      current.map((row) =>
        row.commit.oid === oid
          ? {
              ...row,
              action,
              message: action === "reword" ? fullMessage(row.commit) : "",
            }
          : row
      )
    );
  }

  function setMessage(oid: string, message: string) {
    setRows((current) =>
      current.map((row) => (row.commit.oid === oid ? { ...row, message } : row))
    );
  }

  function move(fromOid: string, toOid: string) {
    if (fromOid === toOid) return;
    setRows((current) => {
      const from = current.findIndex((row) => row.commit.oid === fromOid);
      const to = current.findIndex((row) => row.commit.oid === toOid);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  const firstKept = rows.find((row) => row.action !== "drop");
  const invalidCombine = firstKept?.action === "squash" || firstKept?.action === "fixup";

  async function execute() {
    if (executing) return;
    const todo: RebaseTodoEntry[] = rows.map((row) => {
      const entry: RebaseTodoEntry = { oid: row.commit.oid, action: row.action };
      if ((row.action === "reword" || row.action === "squash") && row.message.trim()) {
        entry.message = row.message;
      }
      return entry;
    });
    setExecuting(true);
    try {
      await useUndo.getState().tracked({
        path,
        kind: "rebase",
        label: t("gitRepo.sidebar.rebase.label"),
        action: () => rebaseInteractive(path, baseOid, todo),
      });
      toast.success(t("gitRepo.sidebar.rebase.done"));
      useUi.getState().closeDialog();
      await useRepo.getState().refresh();
    } catch (error) {
      toast.error(
        t("gitRepo.sidebar.rebase.failed", {
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
    } finally {
      setExecuting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && useUi.getState().closeDialog()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("gitRepo.sidebar.rebase.title")}</DialogTitle>
          <DialogDescription>
            {t("gitRepo.sidebar.rebase.description", { base: baseOid.slice(0, 8) })}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : (
          <div
            role="list"
            aria-label={t("gitRepo.sidebar.rebase.planLabel")}
            className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto pr-1"
          >
            {rows.length === 0 ? (
              <div className="border-border flex min-h-40 flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 text-center">
                <GitCommitHorizontal className="text-muted-foreground/70 size-6" />
                <p className="text-sm font-medium">{t("gitRepo.sidebar.rebase.emptyTitle")}</p>
                <p className="text-muted-foreground/70 text-xs">
                  {t("gitRepo.sidebar.rebase.emptyDescription")}
                </p>
              </div>
            ) : (
              rows.map((row) => (
                <div
                  key={row.commit.oid}
                  role="listitem"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/angkorgit-rebase-row", row.commit.oid);
                    event.dataTransfer.effectAllowed = "move";
                    setDraggingOid(row.commit.oid);
                  }}
                  onDragEnd={() => {
                    setDraggingOid(null);
                    setDropOid(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDropOid(row.commit.oid);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const fromOid = event.dataTransfer.getData("text/angkorgit-rebase-row");
                    if (fromOid) move(fromOid, row.commit.oid);
                    setDraggingOid(null);
                    setDropOid(null);
                  }}
                  className={cn(
                    "border-border bg-card flex flex-col gap-2 rounded-md border px-2 py-1.5",
                    row.action === "drop" && "opacity-40",
                    draggingOid === row.commit.oid && "opacity-40",
                    dropOid === row.commit.oid && "ring-primary/60 ring-1 ring-inset"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <HelpTip title={t("gitRepo.sidebar.rebase.dragHint")}>
                      <span className="text-muted-foreground/70 shrink-0 cursor-grab">
                        <GripVertical className="size-3.5" />
                      </span>
                    </HelpTip>
                    <Badge className="shrink-0 font-mono">{row.commit.shortOid.slice(0, 7)}</Badge>
                    <span className="min-w-0 flex-1 truncate text-sm">{row.commit.summary}</span>
                    <span className="text-muted-foreground/70 shrink-0 text-xs">
                      {row.commit.author.name}
                    </span>
                    <Select
                      value={row.action}
                      onValueChange={(value) =>
                        setAction(row.commit.oid, value as RebaseTodoAction)
                      }
                    >
                      <SelectTrigger
                        className="h-7 w-28 text-xs"
                        aria-label={t("gitRepo.sidebar.rebase.actionLabel", {
                          oid: row.commit.shortOid.slice(0, 7),
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACTIONS.map((action) => (
                          <SelectItem key={action} value={action} className="text-xs">
                            {t(`gitRepo.sidebar.rebase.action.${action}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {row.action === "reword" && (
                    <Textarea
                      rows={3}
                      className="text-xs"
                      value={row.message}
                      onChange={(event) => setMessage(row.commit.oid, event.target.value)}
                    />
                  )}
                  {row.action === "squash" && (
                    <Textarea
                      rows={2}
                      className="text-xs"
                      placeholder={t("gitRepo.sidebar.rebase.combinedMessagePlaceholder")}
                      value={row.message}
                      onChange={(event) => setMessage(row.commit.oid, event.target.value)}
                    />
                  )}
                </div>
              ))
            )}
            {invalidCombine && (
              <p className="text-destructive mt-2 text-xs">
                {t("gitRepo.sidebar.rebase.invalidCombine")}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={executing}
            onClick={() => useUi.getState().closeDialog()}
          >
            {t("gitRepo.sidebar.rebase.cancel")}
          </Button>
          <Button
            disabled={loading || executing || invalidCombine || rows.length === 0}
            className={cn(executing && "gap-2")}
            onClick={execute}
          >
            {executing ? <Loader2 className="animate-spin" /> : null}
            {t("gitRepo.sidebar.rebase.rebase")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
