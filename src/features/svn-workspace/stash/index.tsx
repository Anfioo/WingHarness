import { useCallback, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Archive,
  Copy,
  Download,
  FileText,
  List,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { restoreUnversionedFiles, svnApplyPatch, svnStashExport } from "@/commands";
import { writeClipboardText } from "@/lib/svn-core/clipboard";
import type { StashEntry } from "@/lib/svn-core/types";
import { confirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyPane } from "@/components/svn-workspace/empty-pane";
import { useSvnWorkspaceStore } from "@/features/svn-workspace/store";
import { useSvnWorkspace } from "@/features/svn-workspace/use-workspace";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { StashCreateDialog } from "./create-dialog";
import {
  changedFiles,
  exportFileName,
  stashableFiles,
  unversionedRootCount,
  unversionedRoots,
} from "./model";
import { stashesForWorkspace, useStashStore } from "./store";

/**
 * The stash panel: SVN has no `git stash`, so the reference builds one from the
 * working copy's own diff — capture the selected hunks and unversioned files,
 * store them, then revert those paths. Applying writes the patch back with
 * `svnApplyPatch` and restores any captured unversioned files.
 *
 * The panel keeps the reference's shape: a header with refresh/create, a hint
 * about what is stashable, the list of saved stashes, and the create dialog
 * ({@link StashCreateDialog}). Destructive actions — applying over local
 * changes, discarding unversioned files, deleting a stash — confirm first.
 */
export function StashPanel() {
  const { t, language } = useAppTranslation();
  const workspacePath = useSvnWorkspaceStore((s) => s.workspacePath);
  const statusList = useSvnWorkspaceStore((s) => s.statusList);
  const statusIsStale = useSvnWorkspaceStore((s) => s.statusIsStale);
  const isLoading = useSvnWorkspaceStore((s) => s.isLoading);
  const entries = useStashStore((s) => s.entries);
  const removeEntry = useStashStore((s) => s.removeEntry);
  const clearWorkspace = useStashStore((s) => s.clearWorkspace);
  const { refreshStatus, refreshStatusAfterMutation } = useSvnWorkspace();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyingMode, setApplyingMode] = useState<"apply" | "pop" | null>(null);

  const stashes = useMemo(
    () => stashesForWorkspace(entries, workspacePath),
    [entries, workspacePath]
  );

  const stashable = useMemo(() => stashableFiles(statusList), [statusList]);
  const unversioned = useMemo(() => unversionedRoots(statusList), [statusList]);
  const hasStashableChanges = stashable.length > 0 || unversioned.length > 0;
  const hasChanges = useMemo(() => changedFiles(statusList).length > 0, [statusList]);

  const formatDate = useCallback(
    (iso: string) => new Date(iso).toLocaleString(language),
    [language]
  );

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshStatus();
    } finally {
      setRefreshing(false);
    }
  };

  const applyEntry = async (entry: StashEntry, removeAfterApply: boolean) => {
    if (!workspacePath || workspacePath !== entry.workspacePath || applyingId) return;
    const confirmed = await confirmDialog({
      title: removeAfterApply
        ? t("svnWorkspace.stash.confirm.popTitle")
        : t("svnWorkspace.stash.confirm.applyTitle"),
      description: t(
        removeAfterApply
          ? "svnWorkspace.stash.confirm.popDescription"
          : "svnWorkspace.stash.confirm.applyDescription",
        { name: entry.name }
      ),
      confirmLabel: removeAfterApply
        ? t("svnWorkspace.stash.actions.pop")
        : t("svnWorkspace.stash.actions.apply"),
      destructive: removeAfterApply,
    });
    if (!confirmed) return;

    setApplyingId(entry.id);
    setApplyingMode(removeAfterApply ? "pop" : "apply");
    try {
      if (entry.unversionedFiles?.length) {
        await restoreUnversionedFiles(workspacePath, entry.unversionedFiles, true);
      }
      if (entry.patch) {
        const result = await svnApplyPatch(workspacePath, entry.patch);
        if (!result.success) throw new Error(result.error || result.output);
      }
      if (entry.unversionedFiles?.length) {
        await restoreUnversionedFiles(workspacePath, entry.unversionedFiles, false);
      }
      if (removeAfterApply) removeEntry(entry.id);
      await refreshStatusAfterMutation();
      toast.success(
        removeAfterApply
          ? t("svnWorkspace.stash.toast.popped")
          : t("svnWorkspace.stash.toast.applied")
      );
    } catch (error) {
      toast.error(`${t("svnWorkspace.stash.toast.applyFailed")}: ${String(error)}`);
    } finally {
      setApplyingId(null);
      setApplyingMode(null);
    }
  };

  const copyEntry = async (entry: StashEntry) => {
    try {
      await writeClipboardText(entry.patch);
      toast.success(t("svnWorkspace.stash.toast.copied"));
    } catch {
      toast.error(t("svnWorkspace.stash.toast.copyFailed"));
    }
  };

  const exportEntry = async (entry: StashEntry) => {
    const path = await save({
      defaultPath: exportFileName(entry.name),
      filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
    });
    if (!path) return;
    try {
      await svnStashExport(path, entry.patch);
      toast.success(t("svnWorkspace.stash.toast.exported"));
    } catch (error) {
      toast.error(`${t("svnWorkspace.stash.toast.exportFailed")}: ${String(error)}`);
    }
  };

  const deleteEntry = async (entry: StashEntry) => {
    const confirmed = await confirmDialog({
      title: t("svnWorkspace.stash.confirm.deleteTitle"),
      description: t("svnWorkspace.stash.confirm.deleteDescription", { name: entry.name }),
      confirmLabel: t("svnWorkspace.stash.actions.delete"),
      destructive: true,
    });
    if (!confirmed) return;
    removeEntry(entry.id);
  };

  const clearList = async () => {
    if (!workspacePath || stashes.length === 0) return;
    const confirmed = await confirmDialog({
      title: t("svnWorkspace.stash.confirm.clearTitle"),
      description: t("svnWorkspace.stash.confirm.clearDescription"),
      confirmLabel: t("svnWorkspace.stash.actions.clear"),
      destructive: true,
    });
    if (!confirmed) return;
    clearWorkspace(workspacePath);
    toast.success(t("svnWorkspace.stash.toast.cleared"));
  };

  const busy = applyingId !== null;
  const createDisabled = !hasStashableChanges || statusIsStale || isLoading;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Archive className="text-muted-foreground size-4" />
          {t("svnWorkspace.stash.title")}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {t("svnWorkspace.stash.subtitle")}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {stashes.length > 0 ? (
            <Button variant="ghost" size="xs" onClick={() => void clearList()}>
              <Trash2 className="size-3" />
              {t("svnWorkspace.stash.actions.clear")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("svnWorkspace.common.refresh")}
            disabled={refreshing || isLoading}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn("size-3.5", (refreshing || isLoading) && "animate-spin")} />
          </Button>
          <Button size="sm" disabled={createDisabled} onClick={() => setDialogOpen(true)}>
            <Plus className="size-3.5" />
            {t("svnWorkspace.stash.create")}
          </Button>
        </div>
      </div>

      {!workspacePath ? (
        <EmptyPane icon={Archive} title={t("svnWorkspace.stash.openWorkspaceFirst")} />
      ) : (
        <>
          {statusIsStale ? (
            <div className="border-border bg-muted/40 text-muted-foreground flex items-center gap-1.5 border-b px-3 py-1 text-xs">
              {t("svnWorkspace.stash.cachedStatus")}
            </div>
          ) : null}
          {hasStashableChanges ? (
            <div className="border-border bg-muted/30 text-muted-foreground flex items-center gap-1.5 border-b px-3 py-1 text-xs">
              {t("svnWorkspace.stash.workingCopyHint", {
                count: stashable.length + unversioned.length,
              })}
            </div>
          ) : hasChanges ? (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-1.5 border-b px-3 py-1 text-xs">
              <AlertTriangle className="size-3.5 shrink-0" />
              {t("svnWorkspace.stash.unsupportedChanges")}
            </div>
          ) : null}

          {stashes.length === 0 ? (
            <EmptyPane
              icon={Archive}
              title={t("svnWorkspace.stash.empty")}
              description={t("svnWorkspace.stash.emptyHint")}
            >
              <Button size="sm" disabled={createDisabled} onClick={() => setDialogOpen(true)}>
                <Plus className="size-3.5" />
                {t("svnWorkspace.stash.create")}
              </Button>
            </EmptyPane>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
              {stashes.map((entry, index) => {
                const unversionedCount = unversionedRootCount(entry);
                return (
                  <article
                    key={entry.id}
                    className="border-border grid grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-3 rounded-md border p-3"
                  >
                    <span className="bg-primary/15 text-primary grid size-8 place-items-center rounded-full text-sm font-bold">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <strong className="truncate text-sm">{entry.name}</strong>
                        <span className="border-border text-muted-foreground shrink-0 rounded border px-1.5 py-0.5 text-[10px]">
                          {formatDate(entry.createdAt)}
                        </span>
                      </div>
                      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="flex items-center gap-1">
                          <FileText className="size-3" />
                          {t("svnWorkspace.stash.files", { count: entry.files.length })}
                        </span>
                        <span className="flex items-center gap-1">
                          <List className="size-3" />
                          {t("svnWorkspace.stash.hunks", { count: entry.hunkCount })}
                        </span>
                        {unversionedCount > 0 ? (
                          <span className="flex items-center gap-1">
                            <Plus className="size-3" />
                            {t("svnWorkspace.stash.unversionedFiles", { count: unversionedCount })}
                          </span>
                        ) : null}
                        <span className="min-w-0 truncate font-mono" title={entry.workspacePath}>
                          {entry.workspacePath}
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void applyEntry(entry, false)}
                      >
                        {applyingId === entry.id && applyingMode === "apply" ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : null}
                        {t("svnWorkspace.stash.actions.apply")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void applyEntry(entry, true)}
                      >
                        {applyingId === entry.id && applyingMode === "pop" ? (
                          <RefreshCw className="size-3.5 animate-spin" />
                        ) : null}
                        {t("svnWorkspace.stash.actions.pop")}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={busy}
                            aria-label={t("svnWorkspace.stash.actions.more")}
                          >
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>
                            {t("svnWorkspace.stash.actions.more")}
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={!entry.patch}
                            onSelect={() => void copyEntry(entry)}
                          >
                            <Copy className="size-3.5" />
                            {t("svnWorkspace.stash.actions.copy")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!entry.patch}
                            onSelect={() => void exportEntry(entry)}
                          >
                            <Download className="size-3.5" />
                            {t("svnWorkspace.stash.actions.export")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => void deleteEntry(entry)}
                          >
                            <Trash2 className="size-3.5" />
                            {t("svnWorkspace.stash.actions.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}

      {workspacePath ? (
        <StashCreateDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          workspacePath={workspacePath}
          statusIsStale={statusIsStale}
        />
      ) : null}
    </div>
  );
}

export default StashPanel;
