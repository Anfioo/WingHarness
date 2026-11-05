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
import { useAppTranslation } from "@/hooks/use-app-translation";
import { refreshGitViews, errorText } from "../actions";
import { fullMessage } from "../rebase-plan";

const ACTIONS: RebaseTodoAction[] = ["pick", "reword", "squash", "fixup", "drop"];

export interface RebaseRequest {
  /** The commit the rewrite starts after; the plan covers everything above it. */
  base: string;
  presets?: Record<string, RebaseTodoAction>;
  messages?: Record<string, string>;
}

interface PlanRow {
  commit: CommitInfo;
  action: RebaseTodoAction;
  message: string;
}

/** The project page's interactive rebase plan: edit the todo the standalone window also edits. */
export function RebaseTodoDialog({
  repo,
  request,
  onClose,
}: {
  repo: string | null;
  request: RebaseRequest | null;
  onClose: () => void;
}) {
  if (!repo || !request) return null;
  return (
    <RebaseTodoBody
      key={`${repo}:${request.base}`}
      repo={repo}
      request={request}
      onClose={onClose}
    />
  );
}

function RebaseTodoBody({
  repo,
  request,
  onClose,
}: {
  repo: string;
  request: RebaseRequest;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [draggingOid, setDraggingOid] = useState<string | null>(null);
  const [dropOid, setDropOid] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void rebaseCommits(repo, request.base)
      .then((commits) => {
        if (!active) return;
        setRows(
          [...commits].reverse().map((commit) => {
            const action = request.presets?.[commit.oid] ?? "pick";
            return {
              commit,
              action,
              message:
                action === "reword" ? (request.messages?.[commit.oid] ?? fullMessage(commit)) : "",
            };
          })
        );
      })
      .catch((cause) => {
        if (!active) return;
        toast.error(
          t("gitRepo.sidebar.rebase.failed", {
            error: errorText(cause),
          })
        );
        onClose();
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [repo, request, t, onClose]);

  const setAction = (oid: string, action: RebaseTodoAction) => {
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
  };

  const setMessage = (oid: string, message: string) => {
    setRows((current) =>
      current.map((row) => (row.commit.oid === oid ? { ...row, message } : row))
    );
  };

  const move = (fromOid: string, toOid: string) => {
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
  };

  const firstKept = rows.find((row) => row.action !== "drop");
  const invalidCombine = firstKept?.action === "squash" || firstKept?.action === "fixup";

  const execute = async () => {
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
      await rebaseInteractive(repo, request.base, todo);
      toast.success(t("gitRepo.sidebar.rebase.done"));
      await refreshGitViews();
      onClose();
    } catch (cause) {
      toast.error(
        t("gitRepo.sidebar.rebase.failed", {
          error: errorText(cause),
        })
      );
    } finally {
      setExecuting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !executing && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("gitRepo.sidebar.rebase.title")}</DialogTitle>
          <DialogDescription>
            {t("gitRepo.sidebar.rebase.description", { base: request.base.slice(0, 8) })}
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
          <Button variant="ghost" disabled={executing} onClick={onClose}>
            {t("gitRepo.sidebar.rebase.cancel")}
          </Button>
          <Button
            disabled={loading || executing || invalidCombine || rows.length === 0}
            className={cn(executing && "gap-2")}
            onClick={() => void execute()}
          >
            {executing ? <Loader2 className="animate-spin" /> : null}
            {t("gitRepo.sidebar.rebase.rebase")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
