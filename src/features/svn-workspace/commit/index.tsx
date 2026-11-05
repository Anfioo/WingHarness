import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCheck,
  ChevronDown,
  Diff,
  GitMerge,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  SearchX,
  Trash2,
  Upload,
  User,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  deleteUnversioned,
  readUnversionedFiles,
  restoreUnversionedFiles,
  svnAdd,
  svnCommit,
  svnCurrentUser,
  svnResolve,
} from "@/commands";
import type { StashUnversionedEntry } from "@/lib/svn-core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmDialog } from "@/components/confirm";
import { EmptyPane } from "@/components/svn-workspace/empty-pane";
import {
  FileTree,
  type ChangeTreeRow,
  type FileTreeHandle,
} from "@/components/svn-workspace/file-tree";
import { useSvnWorkspaceStore } from "@/features/svn-workspace/store";
import { useSvnWorkspace } from "@/features/svn-workspace/use-workspace";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { useCommitDraft } from "./draft-store";
import {
  applyToggle,
  committableEntries,
  conflictedEntries,
  countMode,
  defaultSelection,
  filterCommitEntries,
  flattenCommitRows,
  isUnversioned,
  rowChecked,
  unversionedSelection,
  type CommitFilterMode,
} from "./model";

const MESSAGE_LIMIT = 500;

/** The resolve strategies the engine's `svn_resolve` accepts. */
const RESOLVE_STRATEGIES = ["working", "mine-full", "theirs-full"] as const;

function resolveStrategyKey(strategy: string): string {
  switch (strategy) {
    case "mine-full":
      return "svnWorkspace.commit.resolve.mine";
    case "theirs-full":
      return "svnWorkspace.commit.resolve.theirs";
    default:
      return "svnWorkspace.commit.resolve.working";
  }
}

/**
 * The commit panel: pick which changed paths to record, write the message, and
 * run `svn commit`. The reference's commit "scope" (a route query) maps onto the
 * shared store `selection`, which the changes panel also drives, so a partial
 * commit needs no round-trip through storage.
 *
 * Flow notes carried over from the reference `CommitView.vue`:
 *  - the selection defaults to every changed file;
 *  - a selected unversioned file is `svn add`-ed first and the panel asks the
 *    user to review and commit again (`addAndReview`), rather than committing in
 *    the same click;
 *  - conflicted paths are listed but blocked (resolve first);
 *  - `CommandResult.output` is shown once the command returns.
 *
 * The reference also captured unversioned content for a stash-like safety net;
 * here the same idea guards the commit itself — the selected unversioned files
 * are read first, and restored if the operation throws.
 */
export function CommitPanel() {
  const { t } = useAppTranslation();
  const workspacePath = useSvnWorkspaceStore((s) => s.workspacePath);
  const statusList = useSvnWorkspaceStore((s) => s.statusList);
  const isLoading = useSvnWorkspaceStore((s) => s.isLoading);
  const statusIsStale = useSvnWorkspaceStore((s) => s.statusIsStale);
  const selection = useSvnWorkspaceStore((s) => s.selection);
  const setSelection = useSvnWorkspaceStore((s) => s.setSelection);
  const openDiff = useSvnWorkspaceStore((s) => s.openDiff);
  const { refreshStatus, refreshStatusAfterMutation, openWorkspaceDialog } = useSvnWorkspace();

  const draft = useCommitDraft((s) => (workspacePath ? (s.drafts[workspacePath] ?? "") : ""));
  const setDraft = useCommitDraft((s) => s.setDraft);
  const clearDraft = useCommitDraft((s) => s.clearDraft);

  const [mode, setMode] = useState<CommitFilterMode>("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [partial, setPartial] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [output, setOutput] = useState("");
  const [author, setAuthor] = useState<string | null>(null);

  const treeRef = useRef<FileTreeHandle>(null);
  const capturedRef = useRef<StashUnversionedEntry[] | null>(null);
  const defaultedFor = useRef<string | null>(null);

  const entries = useMemo(() => committableEntries(statusList), [statusList]);
  const conflicts = useMemo(() => conflictedEntries(statusList), [statusList]);

  const visible = useMemo(() => filterCommitEntries(entries, mode, query), [entries, mode, query]);
  const searching = query.trim().length > 0;
  const rows = useMemo(
    () => flattenCommitRows(visible, collapsed, searching),
    [visible, collapsed, searching]
  );
  const visiblePaths = useMemo(() => new Set(visible.map((entry) => entry.path)), [visible]);
  const selectedSet = useMemo(() => new Set(selection), [selection]);

  const selectedCount = selection.length;
  const hiddenCount = useMemo(
    () => selection.reduce((count, path) => count + (visiblePaths.has(path) ? 0 : 1), 0),
    [selection, visiblePaths]
  );
  const allVisibleSelected =
    visible.length > 0 && visible.every((entry) => selectedSet.has(entry.path));
  const unversionedSelected = useMemo(
    () => unversionedSelection(entries, selectedSet),
    [entries, selectedSet]
  );
  const busy = committing || resolving;

  // The author SVN would commit as; shown for confirmation, as the reference did.
  useEffect(() => {
    if (!workspacePath) {
      setAuthor(null);
      return;
    }
    let cancelled = false;
    void svnCurrentUser(workspacePath)
      .then((user) => {
        if (!cancelled) setAuthor(user?.username ?? null);
      })
      .catch(() => {
        if (!cancelled) setAuthor(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  // Default the shared selection to every changed file once per working copy,
  // the first time a non-empty list is available.
  useEffect(() => {
    if (!workspacePath || isLoading || entries.length === 0) return;
    if (defaultedFor.current === workspacePath) return;
    defaultedFor.current = workspacePath;
    setSelection(defaultSelection(entries));
  }, [workspacePath, isLoading, entries, setSelection]);

  // Reset view-local state when the working copy changes; the shared selection
  // is re-defaulted by the effect above.
  const previousWorkspace = useRef(workspacePath);
  useEffect(() => {
    if (previousWorkspace.current === workspacePath) return;
    previousWorkspace.current = workspacePath;
    setMode("all");
    setQuery("");
    setCollapsed(new Set());
    setOutput("");
    capturedRef.current = null;
  }, [workspacePath]);

  const onToggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onToggleSelect = useCallback(
    (row: ChangeTreeRow) => {
      const checked = rowChecked(selectedSet, row.targets);
      setSelection(applyToggle(selection, row.targets, !checked));
    },
    [selectedSet, selection, setSelection]
  );

  const onActivate = useCallback(
    (row: ChangeTreeRow) => {
      if (row.kind !== "file") return;
      openDiff({ path: row.path });
    },
    [openDiff]
  );

  const onSelectAll = useCallback(() => {
    if (allVisibleSelected) setSelection(selection.filter((path) => !visiblePaths.has(path)));
    else setSelection([...new Set([...selection, ...visible.map((entry) => entry.path)])]);
  }, [allVisibleSelected, selection, setSelection, visiblePaths, visible]);

  const resolveConflict = useCallback(
    async (path: string, strategy: string) => {
      if (!workspacePath || resolving) return;
      setResolving(true);
      try {
        await svnResolve(workspacePath, [path], strategy);
        await refreshStatusAfterMutation();
        toast.success(t("svnWorkspace.commit.toast.resolved"));
      } catch (err) {
        toast.error(t("svnWorkspace.commit.toast.failed", { error: String(err) }));
      } finally {
        setResolving(false);
      }
    },
    [workspacePath, resolving, refreshStatusAfterMutation, t]
  );

  const discardUnversioned = useCallback(
    async (path: string) => {
      if (!workspacePath) return;
      const ok = await confirmDialog({
        title: t("svnWorkspace.commit.confirm.discardTitle"),
        description: t("svnWorkspace.commit.confirm.discardDescription"),
        path,
        confirmLabel: t("svnWorkspace.commit.actions.discard"),
        destructive: true,
      });
      if (!ok) return;
      try {
        await deleteUnversioned(workspacePath, [path]);
        await refreshStatusAfterMutation();
        toast.success(t("svnWorkspace.commit.toast.discarded"));
      } catch (err) {
        toast.error(t("svnWorkspace.commit.toast.failed", { error: String(err) }));
      }
    },
    [workspacePath, refreshStatusAfterMutation, t]
  );

  const resetForm = useCallback(() => {
    if (workspacePath) clearDraft(workspacePath);
    setOutput("");
    setSelection([]);
    capturedRef.current = null;
  }, [workspacePath, clearDraft, setSelection]);

  const disabled =
    busy || !workspacePath || statusIsStale || !draft.trim() || (partial && selectedCount === 0);

  const doCommit = useCallback(async () => {
    if (!workspacePath || busy || statusIsStale) return;
    if (!draft.trim()) return;
    if (partial && selectedCount === 0) return;

    const available = new Set(entries.map((entry) => entry.path));
    const files = selection.filter((path) => available.has(path));
    if (partial && files.length === 0) return;

    const unversioned = partial ? unversionedSelection(entries, new Set(files)) : [];

    const confirmed = await confirmDialog({
      title: t("svnWorkspace.commit.confirm.title"),
      description: unversioned.length
        ? t("svnWorkspace.commit.confirm.descriptionAdd", { count: unversioned.length })
        : partial
          ? t("svnWorkspace.commit.confirm.descriptionSelected", { count: files.length })
          : t("svnWorkspace.commit.confirm.descriptionWhole"),
      confirmLabel: unversioned.length
        ? t("svnWorkspace.commit.actions.addAndReview")
        : t("svnWorkspace.commit.actions.commit"),
    });
    if (!confirmed) return;

    setCommitting(true);
    setOutput("");
    try {
      if (unversioned.length > 0) {
        // Capture the unversioned content so a failed operation can put it back.
        try {
          capturedRef.current = await readUnversionedFiles(workspacePath, unversioned);
        } catch {
          capturedRef.current = null;
        }
        await svnAdd(workspacePath, unversioned);
        const target = new Set(files);
        await refreshStatusAfterMutation();
        const nextEntries = useSvnWorkspaceStore.getState().statusList;
        const nextSelection = committableEntries(nextEntries)
          .filter(
            (entry) =>
              target.has(entry.path) ||
              unversioned.some((parent) => entry.path.startsWith(`${parent}/`))
          )
          .map((entry) => entry.path);
        setSelection(nextSelection);
        setOutput(t("svnWorkspace.commit.reviewAdded", { count: unversioned.length }));
        toast.success(t("svnWorkspace.commit.toast.added", { count: unversioned.length }));
        return;
      }

      const result = await svnCommit(workspacePath, draft, partial ? files : undefined);
      setOutput(result.output);
      setSelection([]);
      clearDraft(workspacePath);
      capturedRef.current = null;
      await refreshStatusAfterMutation();
      toast.success(t("svnWorkspace.commit.toast.success"));
    } catch (err) {
      if (capturedRef.current && capturedRef.current.length > 0) {
        try {
          await restoreUnversionedFiles(workspacePath, capturedRef.current, false);
        } catch {
          // Restoring is best effort; the original error is what matters.
        }
      }
      setOutput(`${t("svnWorkspace.common.error")}: ${String(err)}`);
      toast.error(t("svnWorkspace.commit.toast.failed", { error: String(err) }));
    } finally {
      setCommitting(false);
    }
  }, [
    workspacePath,
    busy,
    statusIsStale,
    draft,
    partial,
    selectedCount,
    selection,
    entries,
    clearDraft,
    refreshStatusAfterMutation,
    setSelection,
    t,
  ]);

  if (!workspacePath) {
    return (
      <EmptyPane
        title={t("svnWorkspace.common.noWorkspace")}
        description={t("svnWorkspace.commit.noWorkspaceHint")}
      >
        <Button size="sm" onClick={() => void openWorkspaceDialog()}>
          {t("svnWorkspace.common.open")}
        </Button>
      </EmptyPane>
    );
  }

  const selectedLabel =
    hiddenCount > 0
      ? t("svnWorkspace.commit.selectedWithHidden", { count: selectedCount, hidden: hiddenCount })
      : t("svnWorkspace.commit.selectedCount", { count: selectedCount });

  const commitLabel = !partial
    ? t("svnWorkspace.commit.actions.commitWhole")
    : unversionedSelected.length > 0
      ? t("svnWorkspace.commit.actions.addAndReview")
      : t("svnWorkspace.commit.actions.commitCount", { count: selectedCount });

  const emptyTitle =
    entries.length === 0
      ? t("svnWorkspace.commit.empty.noChanges")
      : t("svnWorkspace.commit.empty.noMatches");
  const emptyHint =
    entries.length === 0
      ? t("svnWorkspace.commit.empty.noChangesHint")
      : t("svnWorkspace.commit.empty.noMatchesHint");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border flex flex-col border-b">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Upload className="text-muted-foreground size-4" />
            {t("svnWorkspace.commit.title")}
          </span>
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {selectedLabel}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="text-faint pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("svnWorkspace.commit.searchPlaceholder")}
                aria-label={t("svnWorkspace.commit.searchPlaceholder")}
                className={cn("h-7 w-52 pl-8 text-xs", query && "pr-7")}
              />
              {query ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("svnWorkspace.commit.clearSearch")}
                  className="absolute top-1/2 right-0.5 size-6 -translate-y-1/2"
                  onClick={() => setQuery("")}
                >
                  <X className="size-3" />
                </Button>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("svnWorkspace.common.refresh")}
              disabled={isLoading}
              onClick={() => void refreshStatus()}
            >
              <RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          {(["all", "committable", "unversioned"] as CommitFilterMode[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition-colors",
                mode === value
                  ? "border-primary bg-primary/10 text-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70 border-transparent"
              )}
            >
              <span className="font-semibold tabular-nums">{countMode(entries, value)}</span>
              <span>{t(`svnWorkspace.commit.filter.${value}`)}</span>
            </button>
          ))}
          <label className="text-muted-foreground ml-auto flex cursor-pointer items-center gap-1.5 text-xs select-none">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              disabled={visible.length === 0}
              onChange={onSelectAll}
              className="accent-primary size-3.5"
            />
            {allVisibleSelected
              ? t("svnWorkspace.commit.deselectAll")
              : t("svnWorkspace.commit.selectAll")}
          </label>
        </div>

        <div className="border-border/60 text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1 text-[11px]">
          <span className="flex min-w-0 items-center gap-1">
            <User className="size-3 shrink-0" />
            {t("svnWorkspace.commit.author")}:
            <span className="text-foreground truncate font-medium">{author ?? "—"}</span>
          </span>
          <span className="min-w-0 truncate" title={workspacePath}>
            {workspacePath}
          </span>
        </div>
      </div>

      {statusIsStale ? (
        <div
          className="border-border bg-muted/40 text-muted-foreground flex items-center gap-1.5 border-b px-3 py-1 text-xs"
          role="status"
        >
          {t("svnWorkspace.common.staleStatus")}
        </div>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="border-destructive/30 bg-destructive/5 border-b px-3 py-2">
          <div className="text-destructive flex items-center gap-1.5 text-xs font-medium">
            <AlertTriangle className="size-3.5 shrink-0" />
            {t("svnWorkspace.commit.conflicts.title", { count: conflicts.length })}
          </div>
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            {t("svnWorkspace.commit.conflicts.hint")}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {conflicts.map((entry) => (
              <DropdownMenu key={entry.path}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="xs" className="max-w-full" disabled={busy}>
                    <span className="truncate font-mono">{entry.path}</span>
                    <ChevronDown className="size-3 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuLabel>{t("svnWorkspace.commit.actions.resolve")}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {RESOLVE_STRATEGIES.map((strategy) => (
                    <DropdownMenuItem
                      key={strategy}
                      onSelect={() => void resolveConflict(entry.path, strategy)}
                    >
                      <GitMerge className="size-3.5" />
                      {t(resolveStrategyKey(strategy))}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ))}
          </div>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col">
        {isLoading && entries.length === 0 ? (
          <EmptyPane loading title={t("svnWorkspace.common.loading")} />
        ) : rows.length > 0 ? (
          <FileTree
            ref={treeRef}
            rows={rows}
            selectedPaths={selectedSet}
            activePath={null}
            collapsedPaths={collapsed}
            resetKey={`${workspacePath}|${mode}|${query}`}
            ariaLabel={t("svnWorkspace.commit.title")}
            onToggleCollapse={onToggleCollapse}
            onToggleSelect={(row) => onToggleSelect(row)}
            onActivate={(row) => onActivate(row)}
            renderActions={(entry) => (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("svnWorkspace.commit.actions.diff")}
                  onClick={(event) => {
                    event.stopPropagation();
                    openDiff({ path: entry.path });
                  }}
                >
                  <Diff className="size-3" />
                </Button>
                {isUnversioned(entry) ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("svnWorkspace.commit.actions.discard")}
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void discardUnversioned(entry.path);
                    }}
                  >
                    <Trash2 className="text-destructive size-3" />
                  </Button>
                ) : null}
              </>
            )}
          />
        ) : (
          <EmptyPane
            icon={entries.length === 0 ? CheckCheck : SearchX}
            title={emptyTitle}
            description={emptyHint}
          />
        )}
      </div>

      <div className="border-border flex shrink-0 flex-col gap-2 border-t p-3">
        <div className="flex items-center gap-2">
          <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-xs select-none">
            <input
              type="checkbox"
              checked={partial}
              onChange={(event) => setPartial(event.target.checked)}
              className="accent-primary size-3.5"
            />
            {t("svnWorkspace.commit.partial")}
          </label>
          <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">
            <span className={cn(draft.length > MESSAGE_LIMIT && "text-destructive")}>
              {draft.length}
            </span>
            {` / ${MESSAGE_LIMIT}`}
          </span>
        </div>

        <Textarea
          value={draft}
          onChange={(event) => workspacePath && setDraft(workspacePath, event.target.value)}
          placeholder={t("svnWorkspace.commit.messagePlaceholder")}
          aria-label={t("svnWorkspace.commit.messageLabel")}
          rows={5}
          spellCheck={false}
          className="min-h-[72px] resize-y font-mono text-xs"
        />

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={resetForm} disabled={busy}>
            <RotateCcw className="size-3.5" />
            {t("svnWorkspace.commit.actions.reset")}
          </Button>
          <Button size="sm" onClick={() => void doCommit()} disabled={disabled}>
            {committing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            {commitLabel}
          </Button>
        </div>

        {output ? (
          <div className="border-border bg-muted/30 rounded-md border">
            <div className="border-border/60 text-muted-foreground border-b px-2 py-1 text-[11px] font-medium">
              {t("svnWorkspace.commit.output")}
            </div>
            <pre className="max-h-40 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {output}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default CommitPanel;
