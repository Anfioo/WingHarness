import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { AlertTriangle, CheckCheck, FolderTree, RefreshCw, Search, SearchX, X } from "lucide-react";
import { createGitignoreMatcher } from "@/lib/svn-core/gitignore";
import type { SvnStatus } from "@/lib/svn-core/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ChangeActionItems, RowActionButtons, useChangeActions } from "./actions";
import {
  CHANGE_FILTERS,
  allSelected,
  applyToggle,
  countFilter,
  filePathsBetween,
  flattenRows,
  matchesFilter,
  searchEntries,
  unionPaths,
  type ChangeFilter,
} from "./model";

/**
 * The working copy's changes page: the file list with its filter chips,
 * multi-select (with per-directory cascade and a hidden-but-selected count),
 * gitignore-filtered unversioned rows, and virtual scrolling. Every mutation
 * goes through `useChangeActions`, which refreshes the status afterwards.
 */
export function ChangesView() {
  const { t } = useAppTranslation();
  const statusList = useSvnWorkspaceStore((s) => s.statusList);
  const workspacePath = useSvnWorkspaceStore((s) => s.workspacePath);
  const isLoading = useSvnWorkspaceStore((s) => s.isLoading);
  const statusIsStale = useSvnWorkspaceStore((s) => s.statusIsStale);
  const error = useSvnWorkspaceStore((s) => s.error);
  const gitignorePatterns = useSvnWorkspaceStore((s) => s.gitignorePatterns);
  const selection = useSvnWorkspaceStore((s) => s.selection);
  const setSelection = useSvnWorkspaceStore((s) => s.setSelection);
  const toggleSelection = useSvnWorkspaceStore((s) => s.toggleSelection);
  const { refreshStatus } = useSvnWorkspace();
  const actions = useChangeActions();

  const [filter, setFilter] = useState<ChangeFilter>("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SvnStatus } | null>(null);
  const anchorRef = useRef<number | null>(null);
  const treeRef = useRef<FileTreeHandle>(null);

  // gitignore filtering: only unversioned rows can be ignored, and the patterns
  // were parsed from the working copy's .gitignore a layer above.
  const matcher = useMemo(() => createGitignoreMatcher(gitignorePatterns), [gitignorePatterns]);
  const entries = useMemo(
    () => statusList.filter((entry) => entry.statusCode !== "unversioned" || !matcher(entry.path)),
    [statusList, matcher]
  );

  const counts = useMemo(() => {
    const map = {} as Record<ChangeFilter, number>;
    for (const value of CHANGE_FILTERS) map[value] = countFilter(entries, value);
    return map;
  }, [entries]);

  const visible = useMemo(
    () =>
      searchEntries(
        entries.filter((entry) => matchesFilter(entry, filter)),
        query
      ),
    [entries, filter, query]
  );
  const searching = query.trim().length > 0;
  const rows = useMemo(
    () => flattenRows(visible, collapsed, searching),
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

  // Drop selections for entries the working copy no longer reports, so the
  // "selected" count can never include phantom paths. Only prune once a scan
  // has settled, so a transient empty list during a refresh cannot wipe it.
  useEffect(() => {
    if (isLoading) return;
    const existing = new Set(statusList.map((entry) => entry.path));
    const pruned = selection.filter((path) => existing.has(path));
    if (pruned.length !== selection.length) setSelection(pruned);
  }, [statusList, selection, setSelection, isLoading]);

  // Reset only the view-local state when the working copy changes; the shared
  // selection is left alone (the commit page owns its default).
  const previousWorkspace = useRef(workspacePath);
  useEffect(() => {
    if (previousWorkspace.current === workspacePath) return;
    previousWorkspace.current = workspacePath;
    setActivePath(null);
    setFilter("all");
    setQuery("");
    setCollapsed(new Set());
    anchorRef.current = null;
  }, [workspacePath]);

  useEffect(() => {
    if (activePath && !rows.some((row) => row.path === activePath)) setActivePath(null);
  }, [rows, activePath]);

  const onToggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onToggleSelect = useCallback(
    (row: ChangeTreeRow, index: number, event: { shiftKey: boolean }) => {
      if (row.kind === "dir") {
        const checked = allSelected(selectedSet, row.targets);
        setSelection(applyToggle(selection, row.targets, !checked));
        anchorRef.current = index;
        return;
      }
      if (event.shiftKey && anchorRef.current !== null) {
        setSelection(filePathsBetween(rows, anchorRef.current, index));
        return;
      }
      toggleSelection(row.path);
      anchorRef.current = index;
    },
    [selectedSet, selection, setSelection, toggleSelection, rows]
  );

  const onActivate = useCallback(
    (row: ChangeTreeRow, index: number, event: ReactMouseEvent) => {
      if (row.kind !== "file") return;
      if (event.metaKey || event.ctrlKey) {
        toggleSelection(row.path);
        anchorRef.current = index;
        setActivePath(row.path);
        return;
      }
      if (event.shiftKey && anchorRef.current !== null) {
        setSelection(filePathsBetween(rows, anchorRef.current, index));
        return;
      }
      anchorRef.current = index;
      setActivePath(row.path);
      actions.diff(row.path);
    },
    [rows, setSelection, toggleSelection, actions]
  );

  const onRowContextMenu = useCallback(
    (row: ChangeTreeRow, _index: number, event: ReactMouseEvent) => {
      if (!row.entry) return;
      event.preventDefault();
      event.stopPropagation();
      setActivePath(row.path);
      setMenu({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - 240)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - 340)),
        entry: row.entry,
      });
    },
    []
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const onSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      setSelection(selection.filter((path) => !visiblePaths.has(path)));
    } else {
      setSelection(
        unionPaths(
          selection,
          visible.map((entry) => entry.path)
        )
      );
    }
  }, [allVisibleSelected, selection, setSelection, visiblePaths, visible]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return;
      const current = activePath ? rows.findIndex((row) => row.path === activePath) : -1;
      let next = current;

      switch (event.key) {
        case "ArrowDown":
          next = Math.min(rows.length - 1, current + 1);
          break;
        case "ArrowUp":
          next = current <= 0 ? 0 : current - 1;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = rows.length - 1;
          break;
        case "Enter": {
          const row = current >= 0 ? rows[current] : null;
          if (row?.kind === "file" && row.entry) actions.diff(row.path);
          else if (row?.kind === "dir") onToggleCollapse(row.path);
          return;
        }
        case " ": {
          const row = current >= 0 ? rows[current] : null;
          if (row) onToggleSelect(row, current, { shiftKey: false });
          event.preventDefault();
          return;
        }
        default:
          return;
      }

      event.preventDefault();
      if (next < 0) next = 0;
      const row = rows[next];
      if (!row) return;
      anchorRef.current = next;
      setActivePath(row.path);
      treeRef.current?.scrollToIndex(next);
    },
    [rows, activePath, actions, onToggleCollapse, onToggleSelect]
  );

  const emptyTitle =
    statusList.length === 0
      ? t("svnWorkspace.changes.empty.noChanges")
      : t("svnWorkspace.changes.empty.noMatches");
  const emptyHint =
    statusList.length === 0
      ? t("svnWorkspace.changes.empty.noChangesHint")
      : t("svnWorkspace.changes.empty.noMatchesHint");

  const selectedLabel =
    hiddenCount > 0
      ? t("svnWorkspace.changes.selectedWithHidden", {
          count: selectedCount,
          hidden: hiddenCount,
        })
      : t("svnWorkspace.changes.selected", { count: selectedCount });

  const showBlockingLoader = isLoading && statusList.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex flex-col border-b">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <FolderTree className="text-muted-foreground size-4" />
            {t("svnWorkspace.changes.title")}
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
                placeholder={t("svnWorkspace.changes.searchPlaceholder")}
                aria-label={t("svnWorkspace.changes.searchPlaceholder")}
                className={cn("h-7 w-52 pl-8 text-xs", query && "pr-7")}
              />
              {query ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("svnWorkspace.changes.clearSearch")}
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
              aria-label={t("svnWorkspace.changes.refresh")}
              disabled={isLoading}
              onClick={() => void refreshStatus()}
            >
              <RefreshCw className={cn("size-3.5", isLoading && "animate-spin")} />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          {CHANGE_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition-colors",
                filter === value
                  ? "border-primary bg-primary/10 text-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70 border-transparent"
              )}
            >
              <span className="font-semibold tabular-nums">{counts[value]}</span>
              <span>{t(`svnWorkspace.changes.filter.${value}`)}</span>
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
              ? t("svnWorkspace.changes.deselectAll")
              : t("svnWorkspace.changes.selectAll")}
          </label>
        </div>
      </div>

      {statusIsStale ? (
        <div
          className="border-border bg-muted/40 text-muted-foreground flex items-center gap-1.5 border-b px-3 py-1 text-xs"
          role="status"
        >
          {t("svnWorkspace.changes.cached")}
          {isLoading ? " ·" : null}
        </div>
      ) : null}

      {error ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-1.5 border-b px-3 py-1 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="truncate" title={error}>
            {t("svnWorkspace.changes.error")} {error}
          </span>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col" aria-busy={isLoading}>
        {showBlockingLoader ? (
          <EmptyPane loading title={t("svnWorkspace.changes.loading")} />
        ) : rows.length > 0 ? (
          <FileTree
            ref={treeRef}
            rows={rows}
            selectedPaths={selectedSet}
            activePath={activePath}
            collapsedPaths={collapsed}
            resetKey={`${workspacePath ?? ""}|${filter}|${query}`}
            ariaLabel={t("svnWorkspace.changes.title")}
            onToggleCollapse={onToggleCollapse}
            onToggleSelect={onToggleSelect}
            onActivate={onActivate}
            onRowContextMenu={onRowContextMenu}
            onKeyDown={onKeyDown}
            renderActions={(entry) => <RowActionButtons entry={entry} actions={actions} />}
          />
        ) : (
          <EmptyPane
            icon={statusList.length === 0 ? CheckCheck : SearchX}
            title={emptyTitle}
            description={emptyHint}
          />
        )}
      </div>

      {menu ? (
        <div
          className="border-border bg-popover text-popover-foreground fixed z-50 rounded-lg border shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <ChangeActionItems entry={menu.entry} actions={actions} onDone={() => setMenu(null)} />
        </div>
      ) : null}
    </div>
  );
}

export default ChangesView;
