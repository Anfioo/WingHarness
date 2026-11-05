import { toast } from "sonner";
import { Copy, Diff, FolderOpen, MessageSquare, UserRoundSearch } from "lucide-react";
import type { SvnInfo, SvnLogEntry, SvnLogPath } from "@/lib/svn-core/types";
import { writeClipboardText } from "@/lib/svn-core/clipboard";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/svn-workspace/status-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { revealWorkspaceFile } from "@/commands";
import { useSvnWorkspaceStore } from "@/features/svn-workspace/store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { openSvnDiffWindow } from "@/lib/svn-windows";
import { cn } from "@/lib/utils";
import { changedPathDiffTarget, formatLogDate, workspaceRelativeForRepoPath } from "./model";

/**
 * The revision detail dialog: author/date, the full commit message and the
 * changed paths, each of which can be diffed, blamed (when it maps into the
 * working copy) or revealed in Explorer. Mirrors the reference's `LogView`
 * detail dialog, plus the copy affordances this project adds to its log rows.
 */
export function LogDetailDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: SvnLogEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, language } = useAppTranslation();
  const workspacePath = useSvnWorkspaceStore((state) => state.workspacePath);
  const svnInfo = useSvnWorkspaceStore((state) => state.svnInfo);
  const openBlame = useSvnWorkspaceStore((state) => state.openBlame);

  if (!entry) return null;

  const copy = async (value: string, key: string) => {
    try {
      await writeClipboardText(value);
      toast.success(t(key));
    } catch {
      toast.error(t("svnWorkspace.log.toast.copyFailed"));
    }
  };

  // A window of its own, not the sidebar's diff panel: handing the diff to the
  // sidebar would switch this window away from the log, losing its page and its
  // filters. The dialog stays open, so several changed paths of the same revision
  // can be opened one after another without losing the revision's context.
  const openChangedDiff = (changed: SvnLogPath, info: SvnInfo | null) => {
    if (!workspacePath) return;
    void openSvnDiffWindow(
      workspacePath,
      changedPathDiffTarget(changed.path, info, entry.revision, changed.action)
    ).catch((error) => console.error("Failed to open the revision diff window:", error));
  };

  const openChangedBlame = (changed: SvnLogPath) => {
    const relative = workspaceRelativeForRepoPath(changed.path, svnInfo);
    if (!relative) return;
    openBlame(relative);
    onOpenChange(false);
  };

  const revealChanged = (changed: SvnLogPath) => {
    if (!workspacePath) return;
    const relative = workspaceRelativeForRepoPath(changed.path, svnInfo);
    if (!relative) return;
    void revealWorkspaceFile(workspacePath, relative).catch((error) =>
      console.error("Failed to reveal the changed path:", error)
    );
  };

  const changedPaths = entry.changedPaths ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-border border-b px-5 py-3">
          <div className="flex items-center gap-2">
            <DialogTitle className="font-mono text-sm">
              {t("svnWorkspace.log.detail.title", { revision: entry.revision })}
            </DialogTitle>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("svnWorkspace.log.detail.copyRevision")}
                title={t("svnWorkspace.log.detail.copyRevision")}
                onClick={() =>
                  void copy(String(entry.revision), "svnWorkspace.log.toast.revisionCopied")
                }
              >
                <Copy className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("svnWorkspace.log.detail.copyMessage")}
                title={t("svnWorkspace.log.detail.copyMessage")}
                onClick={() => void copy(entry.message, "svnWorkspace.log.toast.messageCopied")}
              >
                <MessageSquare className="size-3.5" />
              </Button>
            </div>
          </div>
          <DialogDescription className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="text-faint">{t("svnWorkspace.log.author")}</span>
              <span className="text-foreground">{entry.author || "—"}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-faint">{t("svnWorkspace.log.date")}</span>
              <span className="text-foreground">{formatLogDate(entry.date, language)}</span>
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
          <div>
            <p className="text-faint mb-1.5 text-xs font-medium">{t("svnWorkspace.log.message")}</p>
            <pre className="border-border bg-muted/40 max-h-52 overflow-auto rounded-md border p-2.5 font-sans text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
              {entry.message || "—"}
            </pre>
          </div>

          <div>
            <p className="text-faint mb-1.5 text-xs font-medium">
              {t("svnWorkspace.log.detail.changedPaths")}{" "}
              <span className="tabular-nums">({changedPaths.length})</span>
            </p>
            {changedPaths.length === 0 ? (
              <p className="text-faint text-xs">{t("svnWorkspace.log.detail.noChangedPaths")}</p>
            ) : (
              <ul className="divide-border border-border divide-y rounded-md border">
                {changedPaths.map((changed, index) => {
                  const relative = workspaceRelativeForRepoPath(changed.path, svnInfo);
                  const changedDeleted = changed.action === "D";
                  const revealable = Boolean(relative) && !changedDeleted;
                  return (
                    <li
                      key={`${changed.path}-${index}`}
                      className="hover:bg-muted/40 group flex items-center gap-2 px-2 py-1"
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        openChangedDiff(changed, svnInfo);
                      }}
                    >
                      <StatusBadge code={changed.action} className="shrink-0" />
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:underline"
                        title={changed.path}
                        onClick={() => openChangedDiff(changed, svnInfo)}
                      >
                        {changed.path}
                      </button>
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-0.5 transition-opacity",
                          "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                        )}
                      >
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("svnWorkspace.log.detail.openDiff")}
                          title={t("svnWorkspace.log.detail.openDiff")}
                          onClick={() => openChangedDiff(changed, svnInfo)}
                        >
                          <Diff className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={!relative}
                          aria-label={t("svnWorkspace.log.detail.openBlame")}
                          title={t("svnWorkspace.log.detail.openBlame")}
                          onClick={() => openChangedBlame(changed)}
                        >
                          <UserRoundSearch className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={!revealable}
                          aria-label={t("svnWorkspace.log.detail.reveal")}
                          title={t("svnWorkspace.log.detail.reveal")}
                          onClick={() => revealChanged(changed)}
                        >
                          <FolderOpen className="size-3.5" />
                        </Button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter className="border-border border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("svnWorkspace.log.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default LogDetailDialog;
