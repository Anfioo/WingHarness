import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronUp,
  Combine,
  Copy,
  FastForward,
  Filter,
  FolderTree,
  GitBranchPlus,
  GitCommitHorizontal,
  Loader2,
  Settings2,
  GitMerge,
  ListOrdered,
  ListRestart,
  Pencil,
  RotateCcw,
  Search,
  Tag as TagIcon,
  Trash2,
  Undo2,
  User,
  X,
} from "lucide-react";
import { toastOutcome } from "@/features/git/toast-outcome";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { pickRemote, type CommitInfo, type RefInfo } from "@/lib/git-core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Hint } from "@/features/git/diff/diff-ui";
import { PaneEmpty } from "@/pages/git-repo/pane-empty";
import { cn } from "@/lib/utils";
import { ensureRepoProfile } from "@/features/git/identity";
import { useRepo } from "@/features/git/repository-store";
import { activateTab } from "@/features/git/repository/tabs";
import { useUi } from "@/features/git/ui-store";
import { useUndo, type UndoKind } from "@/features/git/history/undoStore";
import { confirmDialog } from "@/components/confirm";
import { useShortcuts } from "@/features/git/diff/use-shortcuts";
import {
  AUTHOR_COL_WIDTH,
  CommitRow,
  GUTTER_GAP,
  GraphTailDefs,
  REF_COL_WIDTH,
  ROW_HEIGHT,
  gutterWidthFor,
  laneWidthFor,
} from "./graph-row";
import { WipRow } from "./wip-row";
import { useGraph } from "./store";
import {
  branchCheckout,
  branchMerge,
  branchRebase,
  checkoutDetached,
  commitRevert,
  mergeCanFf,
  remotePullBranch,
  remotePush,
  resetTo,
  stashApply,
  stashDrop,
  stashPop,
} from "@/commands";

interface MenuState {
  x: number;
  y: number;
  commit: CommitInfo;
}

interface RefMenuState {
  x: number;
  y: number;
  ref: RefInfo;
  commit: CommitInfo;
}

const localNameOf = (remote: RefInfo) => remote.shorthand.split("/").slice(1).join("/");

const stashIndexOf = (ref: RefInfo) => Number(/\{(\d+)\}/.exec(ref.name)?.[1] ?? 0);

export function CommitGraph() {
  const { t } = useAppTranslation();
  const repo = useRepo((s) => s.repo);
  const refresh = useRepo((s) => s.refresh);
  const worktrees = useRepo((s) => s.worktrees);
  const branches = useRepo((s) => s.branches);
  const remotes = useRepo((s) => s.remotes);
  const {
    rows,
    commits,
    maxLane,
    hasMore,
    loading,
    error,
    filters,
    find,
    locatedOid,
    selectedOid,
    selectedOids,
    pendingScrollIndex,
    loadMore,
    reload,
    setFilters,
    setFind,
    stepFind,
    select,
    toggleSelect,
    rangeSelect,
    clearPendingScroll,
  } = useGraph();
  const openDialog = useUi((s) => s.openDialog);
  const requestEditMessage = useUi((s) => s.requestEditMessage);
  const graphColumns = useUi((s) => s.graphColumns);
  const graphTail = useUi((s) => s.graphTail);
  const setGraphTail = useUi((s) => s.setGraphTail);
  const setGraphColumn = useUi((s) => s.setGraphColumn);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [refMenu, setRefMenu] = useState<RefMenuState | null>(null);
  const [refMenuFf, setRefMenuFf] = useState<boolean | null>(null);
  const [searchDraft, setSearchDraft] = useState(find?.text ?? "");
  const [authorDraft, setAuthorDraft] = useState(find?.author ?? "");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const path = repo?.path ?? "";
  const refMenuSource =
    refMenu && (refMenu.ref.kind === "localBranch" || refMenu.ref.kind === "remoteBranch")
      ? refMenu.ref.shorthand
      : null;

  useEffect(() => {
    setRefMenuFf(null);
    if (!refMenuSource) return;
    const head = useRepo.getState().repo?.headBranch;
    if (!head || head === refMenuSource) {
      setRefMenuFf(false);
      return;
    }
    let cancelled = false;
    void mergeCanFf(path, head, refMenuSource)
      .then((ok) => !cancelled && setRefMenuFf(ok))
      .catch(() => !cancelled && setRefMenuFf(false));
    return () => {
      cancelled = true;
    };
  }, [path, refMenuSource]);

  const graphFocusSeq = useUi((s) => s.graphFocusSeq);
  useEffect(() => {
    if (graphFocusSeq > 0) scrollRef.current?.focus();
  }, [graphFocusSeq]);

  const worktreeBranches = useMemo(() => {
    const map = new Map<string, string>();
    for (const wt of worktrees) if (wt.branch && !wt.isCurrent) map.set(wt.branch, wt.name);
    return map;
  }, [worktrees]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const items = virtualizer.getVirtualItems();

  useEffect(() => {
    const last = items[items.length - 1];
    if (!last || !hasMore || loading || error || !path) return;
    if (last.index >= rows.length - 40) void loadMore(path);
  }, [items, hasMore, loading, error, path, rows.length, loadMore]);

  useEffect(() => {
    const text = searchDraft.trim();
    const author = authorDraft.trim();
    const current = useGraph.getState().find;
    if ((current?.text ?? "") === text && (current?.author ?? "") === author) return;
    const timer = setTimeout(() => {
      const selectedAt = useGraph.getState().selectionEpoch();
      void setFind(path, { text, author }, selectedAt);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft, authorDraft, path, setFind]);

  const onFindKeyDown = (value: string, clear: () => void) => (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) void stepFind(path, -1);
      else void stepFind(path, 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (value) clear();
      else requestEditMessage("");
    }
  };

  const matchOids = useMemo(() => new Set(find?.matches.map((match) => match.oid) ?? []), [find]);

  useEffect(() => {
    if (pendingScrollIndex === null || pendingScrollIndex >= rows.length) return;
    virtualizer.scrollToIndex(pendingScrollIndex, { align: "center" });
    clearPendingScroll();
  }, [pendingScrollIndex, rows.length, virtualizer, clearPendingScroll]);

  const laneWidth = laneWidthFor(maxLane);
  const gutterWidth = gutterWidthFor(maxLane, laneWidth);
  const filtersActive = Boolean(filters.branch);

  const moveSelection = useCallback(
    (step: number) => {
      if (commits.length === 0) return;
      const ui = useUi.getState();
      if (
        ui.centerDiff ||
        ui.centerEditor ||
        ui.centerFileHistory ||
        ui.paletteOpen ||
        ui.dialog ||
        ui.conflictFile
      )
        return;
      const currentIndex = selectedOid
        ? commits.findIndex((commit) => commit.oid === selectedOid)
        : -1;
      let nextIndex: number;
      if (step === Number.POSITIVE_INFINITY) nextIndex = commits.length - 1;
      else if (step === Number.NEGATIVE_INFINITY) nextIndex = 0;
      else nextIndex = Math.min(Math.max(currentIndex + step, 0), commits.length - 1);
      if (nextIndex === currentIndex) return;
      const target = commits[nextIndex];
      if (!target) return;
      select(target.oid);
      virtualizer.scrollToIndex(nextIndex, { align: "auto" });
    },
    [commits, selectedOid, select, virtualizer]
  );

  const keyNav = useMemo(
    () => [
      { combo: "arrowdown", handler: () => moveSelection(1) },
      { combo: "arrowup", handler: () => moveSelection(-1) },
      { combo: "home", handler: () => moveSelection(Number.NEGATIVE_INFINITY) },
      { combo: "end", handler: () => moveSelection(Number.POSITIVE_INFINITY) },
      {
        combo: "arrowright",
        handler: () => useUi.getState().focusInspector(),
      },
      {
        combo: "mod+f",
        handler: () => searchInputRef.current?.select(),
      },
    ],
    [moveSelection]
  );

  useShortcuts(keyNav);

  const act = useCallback(
    async (
      label: string,
      op: () => Promise<unknown>,
      undoable?: {
        kind: UndoKind;
        extra?: Parameters<ReturnType<typeof useUndo.getState>["tracked"]>[0]["extra"];
      }
    ) => {
      try {
        const result = undoable
          ? await useUndo.getState().tracked({
              path,
              kind: undoable.kind,
              label,
              extra: undoable.extra,
              action: op,
              shouldRecord: (r) => {
                const status = (r as { status?: string } | undefined)?.status;
                return status === undefined || status === "ok" || status === "fast_forward";
              },
            })
          : await op();
        toastOutcome(
          result as { status?: string; message?: string } | undefined,
          t("gitRepo.graph.actions.done", { label })
        );
        await refresh();
        await reload(path);
      } catch (error) {
        toast.error(
          t("gitRepo.graph.actions.failed", {
            label,
            error: (error as { message?: string }).message ?? error,
          })
        );
      }
    },
    [t, refresh, reload, path]
  );

  const pushRemoteFor = (branch: string) =>
    pickRemote(remotes, branches.find((b) => !b.isRemote && b.name === branch)?.upstream)?.name ??
    "origin";

  const pushBranch = async (branch: string) => {
    await ensureRepoProfile(path);
    await act(t("gitRepo.graph.actions.push", { name: branch }), () =>
      remotePush(path, pushRemoteFor(branch), branch, false, false, true)
    );
    void import("@/features/git/forge/store").then(({ useForge }) =>
      useForge.getState().load(true)
    );
  };

  const aheadOf = (branch: string) =>
    branches.find((b) => !b.isRemote && b.name === branch)?.ahead ?? 0;

  const onContextMenu = (event: React.MouseEvent, commit: CommitInfo) => {
    event.preventDefault();
    const stashRef = commit.refs.find((ref) => ref.kind === "stash");
    if (stashRef) setRefMenu({ x: event.clientX, y: event.clientY, ref: stashRef, commit });
    else setMenu({ x: event.clientX, y: event.clientY, commit });
  };

  const onRowSelect = (oid: string, event: React.MouseEvent) => {
    if (event.shiftKey) rangeSelect(oid);
    else if (event.metaKey || event.ctrlKey) toggleSelect(oid);
    else select(oid);
  };

  const multiSelection = useMemo(() => {
    if (!menu || selectedOids.length < 2 || !selectedOids.includes(menu.commit.oid)) return null;
    const indices = selectedOids
      .map((oid) => commits.findIndex((commit) => commit.oid === oid))
      .filter((index) => index >= 0);
    if (indices.length < 2) return null;
    if (indices.some((index) => commits[index].parents.length > 1)) return null;
    const max = Math.max(...indices);
    const baseOid = commits[max].parents[0];
    if (!baseOid) return null;
    return {
      baseOid,
      count: indices.length,
      contiguous: Math.max(...indices) - Math.min(...indices) === indices.length - 1,
    };
  }, [menu, selectedOids, commits]);

  const pickSelection = useMemo(() => {
    if (!menu || selectedOids.length < 2 || !selectedOids.includes(menu.commit.oid)) return null;
    const indices = selectedOids
      .map((oid) => commits.findIndex((commit) => commit.oid === oid))
      .filter((index) => index >= 0);
    if (indices.length < 2) return null;
    return [...indices].sort((a, b) => b - a).map((index) => commits[index].oid);
  }, [menu, selectedOids, commits]);

  const checkoutRef = (ref: RefInfo) => {
    const held =
      ref.kind === "localBranch"
        ? worktrees.find((w) => w.branch === ref.shorthand && !w.isCurrent)
        : undefined;
    if (held && !held.isMissing) {
      // The branch is checked out in another working copy: show that one rather
      // than moving the branch under the working copy that has it.
      activateTab(held.path);
      return;
    }
    void act(
      t("gitRepo.graph.actions.checkout", { name: ref.shorthand }),
      () => branchCheckout(path, ref.shorthand),
      { kind: "checkout" }
    );
  };

  const onRefMenu = (event: React.MouseEvent, ref: RefInfo, commit: CommitInfo) =>
    setRefMenu({ x: event.clientX, y: event.clientY, ref, commit });

  const resetToRemote = (ref: RefInfo, commit: CommitInfo) => {
    const name = ref.shorthand.split("/").slice(1).join("/");
    const local = branches.find((b) => !b.isRemote && b.name === name);
    if (!local) return;
    const held = worktrees.find((w) => w.branch === name && !w.isCurrent);
    if (held && !held.isMissing) {
      toast.error(t("gitRepo.graph.resetToRemote.inWorktree", { name, worktree: held.name }));
      return;
    }
    const losing =
      local.upstream === ref.shorthand && local.ahead > 0
        ? t("gitRepo.graph.resetToRemote.losing", { count: local.ahead })
        : "";
    void confirmDialog({
      title: t("gitRepo.graph.resetToRemote.title"),
      description: local.isHead
        ? t("gitRepo.graph.resetToRemote.checkedOut", {
            remote: ref.shorthand,
            oid: commit.shortOid,
            losing,
          })
        : t("gitRepo.graph.resetToRemote.notCheckedOut", {
            remote: ref.shorthand,
            oid: commit.shortOid,
            losing,
          }),
      path: name,
      confirmLabel: t("gitRepo.graph.resetToRemote.confirm"),
      destructive: true,
    }).then(async (ok) => {
      if (!ok) return;
      if (!local.isHead) {
        try {
          await useUndo.getState().tracked({
            path,
            kind: "checkout",
            label: t("gitRepo.graph.actions.checkout", { name }),
            action: () => branchCheckout(path, name),
          });
        } catch (error) {
          toast.error(
            t("gitRepo.graph.actions.failed", {
              label: t("gitRepo.graph.actions.checkout", { name }),
              error: (error as { message?: string }).message ?? error,
            })
          );
          return;
        }
      }
      await act(
        t("gitRepo.graph.actions.reset", { name, remote: ref.shorthand }),
        () => resetTo(path, commit.oid, "hard"),
        { kind: "reset" }
      );
    });
  };

  const localBranchNames = useMemo(
    () => new Set(branches.filter((b) => !b.isRemote && b.ahead > 0).map((b) => b.name)),
    [branches]
  );

  const headBranch = useMemo(
    () => branches.find((b) => b.isHead && !b.isRemote)?.name ?? null,
    [branches]
  );

  const refMenuResetTarget = (() => {
    if (!refMenu || refMenu.ref.kind !== "remoteBranch") return null;
    const name = localNameOf(refMenu.ref);
    if (!localBranchNames.has(name)) return null;
    const hasLocal = refMenu.commit.refs.some(
      (ref) => ref.kind === "localBranch" && ref.shorthand === name
    );
    return hasLocal ? null : name;
  })();

  return (
    <section
      className="bg-background relative flex h-full flex-col"
      aria-label={t("gitRepo.graph.list.historyAria")}
    >
      <GraphTailDefs />
      <div className="border-border bg-card flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="relative w-64">
          <Search className="text-faint absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            ref={searchInputRef}
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={onFindKeyDown(searchDraft, () => setSearchDraft(""))}
            placeholder={t("gitRepo.graph.toolbar.searchPlaceholder")}
            className="h-7 pl-8 text-xs"
          />
        </div>
        {find &&
          (find.loading && find.matches.length === 0 ? (
            <Loader2 className="text-faint size-3.5 animate-spin" />
          ) : find.matches.length === 0 ? (
            <span className="text-danger text-xs">{t("gitRepo.graph.toolbar.noMatches")}</span>
          ) : (
            <span
              className="border-border bg-muted/60 flex items-center gap-0.5 rounded-md border px-1"
              aria-label={
                find.truncated
                  ? t("gitRepo.graph.toolbar.matchAriaOrMore", {
                      index: find.active + 1,
                      count: find.matches.length,
                    })
                  : t("gitRepo.graph.toolbar.matchAria", {
                      index: find.active + 1,
                      count: find.matches.length,
                    })
              }
            >
              <Hint label={t("gitRepo.graph.toolbar.previousMatch")}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-5 w-5"
                  aria-label={t("gitRepo.graph.toolbar.previousMatchAria")}
                  onClick={() => void stepFind(path, -1)}
                >
                  <ChevronUp className="size-3.5" />
                </Button>
              </Hint>
              <span className="text-muted-foreground px-1 text-[10px] font-medium whitespace-nowrap tabular-nums">
                {find.truncated
                  ? t("gitRepo.graph.toolbar.matchOrMore", {
                      index: find.active + 1,
                      count: find.matches.length,
                    })
                  : t("gitRepo.graph.toolbar.match", {
                      index: find.active + 1,
                      count: find.matches.length,
                    })}
              </span>
              <Hint label={t("gitRepo.graph.toolbar.nextMatch")}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-5 w-5"
                  aria-label={t("gitRepo.graph.toolbar.nextMatchAria")}
                  onClick={() => void stepFind(path, 1)}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </Hint>
            </span>
          ))}
        <div className="relative w-44">
          <User className="text-faint absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={authorDraft}
            onChange={(e) => setAuthorDraft(e.target.value)}
            onKeyDown={onFindKeyDown(authorDraft, () => setAuthorDraft(""))}
            placeholder={t("gitRepo.graph.toolbar.authorPlaceholder")}
            className="h-7 pl-8 text-xs"
          />
        </div>
        {filters.branch && (
          <span className="border-primary/40 bg-primary/10 text-primary flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
            <Filter className="size-3" />
            {filters.branch}
            <button
              aria-label={t("gitRepo.graph.toolbar.clearBranchFilter")}
              onClick={() => setFilters(path, { branch: "" })}
            >
              <X className="size-3" />
            </button>
          </span>
        )}
        <div className="text-faint ml-auto flex items-center gap-2 text-xs">
          {loading && <Loader2 className="size-3.5 animate-spin" />}
          <span>
            {hasMore
              ? t("gitRepo.graph.toolbar.commitCountMore", { count: commits.length })
              : t("gitRepo.graph.toolbar.commitCount", { count: commits.length })}
          </span>
          <DropdownMenu>
            <Hint label={t("gitRepo.graph.toolbar.graphDisplay")}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("gitRepo.graph.toolbar.graphDisplayAria")}
                >
                  <Settings2 className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t("gitRepo.graph.toolbar.showInGraph")}</DropdownMenuLabel>
              {(
                [
                  ["refs", t("gitRepo.graph.toolbar.columns.refs")],
                  ["message", t("gitRepo.graph.toolbar.columns.message")],
                  ["author", t("gitRepo.graph.toolbar.columns.author")],
                  ["hash", t("gitRepo.graph.toolbar.columns.hash")],
                  ["date", t("gitRepo.graph.toolbar.columns.date")],
                ] as const
              ).map(([key, label]) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={graphColumns[key]}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) => setGraphColumn(key, checked === true)}
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuCheckboxItem
                checked={graphTail}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(checked) => setGraphTail(checked === true)}
              >
                {t("gitRepo.graph.toolbar.laneColorBand")}
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div
        className={cn(
          "border-border bg-card text-faint flex h-6 shrink-0 items-center gap-2 border-b pr-4 text-[10px] font-semibold tracking-wide uppercase select-none",
          graphColumns.refs ? "pl-1" : "pl-4"
        )}
        aria-hidden
      >
        {graphColumns.refs && (
          <span className="-mr-2 shrink-0 truncate" style={{ width: REF_COL_WIDTH }}>
            {t("gitRepo.graph.header.refs")}
          </span>
        )}
        <span className="shrink-0 truncate" style={{ width: gutterWidth, marginRight: GUTTER_GAP }}>
          {t("gitRepo.graph.header.graph")}
        </span>
        {graphColumns.message && (
          <span className="min-w-0 flex-1 truncate">{t("gitRepo.graph.header.message")}</span>
        )}
        {graphColumns.author && (
          <span className="shrink-0 truncate" style={{ width: AUTHOR_COL_WIDTH }}>
            {t("gitRepo.graph.header.author")}
          </span>
        )}
        {graphColumns.hash && (
          <span className={cn("w-14 shrink-0", graphColumns.message ? "text-right" : "text-left")}>
            {t("gitRepo.graph.header.hash")}
          </span>
        )}
        {graphColumns.date && (
          <span
            className={cn("w-[4.5rem] shrink-0", graphColumns.message ? "text-right" : "text-left")}
          >
            {t("gitRepo.graph.header.date")}
          </span>
        )}
        {!graphColumns.message && <span className="min-w-0 flex-1" />}
      </div>
      <div
        ref={scrollRef}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto outline-none"
        role="table"
        aria-label={t("gitRepo.graph.list.tableAria")}
      >
        <WipRow gutterWidth={gutterWidth} showRefs={graphColumns.refs} />
        {rows.length === 0 && !loading ? (
          error ? (
            <div className="text-danger flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm">
              <span className="[overflow-wrap:anywhere]">
                {t("gitRepo.graph.list.loadFailed", { error })}
              </span>
              <Button variant="ghost" size="sm" onClick={() => void reload(path)}>
                {t("gitRepo.graph.list.retry")}
              </Button>
            </div>
          ) : (
            <PaneEmpty
              icon={filtersActive ? <Filter /> : <GitCommitHorizontal />}
              title={
                filtersActive
                  ? t("gitRepo.graph.list.noMatchingCommits")
                  : t("gitRepo.graph.list.noCommitsYet")
              }
              hint={
                filtersActive
                  ? t("gitRepo.graph.list.noMatchingCommitsHint")
                  : t("gitRepo.graph.list.noCommitsYetHint")
              }
            >
              {filtersActive ? (
                <Button variant="ghost" size="sm" onClick={() => setFilters(path, { branch: "" })}>
                  {t("gitRepo.graph.list.clearFilters")}
                </Button>
              ) : null}
            </PaneEmpty>
          )
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((item) => {
              const row = rows[item.index];
              const commit = commits[item.index];
              if (!row || !commit) return null;
              return (
                <div
                  key={commit.oid}
                  className={cn(
                    locatedOid === commit.oid
                      ? "animate-locate bg-primary/10 rounded-md shadow-[inset_3px_0_0_hsl(var(--primary))]"
                      : matchOids.has(commit.oid) &&
                          "shadow-[inset_2px_0_0_hsl(var(--primary)/0.45)]"
                  )}
                  data-search-match={
                    matchOids.has(commit.oid)
                      ? locatedOid === commit.oid
                        ? "active"
                        : "true"
                      : undefined
                  }
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <CommitRow
                    commit={commit}
                    row={row}
                    gutterWidth={gutterWidth}
                    selected={selectedOid === commit.oid || selectedOids.includes(commit.oid)}
                    laneWidth={laneWidth}
                    columns={graphColumns}
                    showTail={graphTail}
                    headBranch={headBranch}
                    worktrees={worktreeBranches}
                    resettableBranches={localBranchNames}
                    onSelect={onRowSelect}
                    onContextMenu={onContextMenu}
                    onCheckoutRef={checkoutRef}
                    onRefMenu={onRefMenu}
                    onResetToRemote={resetToRemote}
                  />
                </div>
              );
            })}
          </div>
        )}
        {error && rows.length > 0 && !loading && (
          <div className="text-danger flex items-center justify-center gap-2 px-3 py-2 text-xs">
            <span className="[overflow-wrap:anywhere]">
              {t("gitRepo.graph.list.loadMoreFailed", { error })}
            </span>
            <button
              className="shrink-0 underline underline-offset-2"
              onClick={() => void reload(path)}
            >
              {t("gitRepo.graph.list.retry")}
            </button>
          </div>
        )}
      </div>

      {refMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setRefMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: refMenu.x, top: refMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel
              className={cn(
                "max-w-64 truncate",
                refMenu.ref.kind === "stash" ? "font-normal" : "font-mono"
              )}
            >
              {refMenu.ref.shorthand}
            </DropdownMenuLabel>
            {refMenu.ref.kind === "stash" && (
              <>
                <DropdownMenuItem
                  onClick={() =>
                    void act(t("gitRepo.graph.actions.applyStash"), () =>
                      stashApply(path, stashIndexOf(refMenu.ref))
                    )
                  }
                >
                  <Archive /> {t("gitRepo.graph.refMenu.applyStash")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void act(t("gitRepo.graph.actions.popStash"), () =>
                      stashPop(path, stashIndexOf(refMenu.ref))
                    )
                  }
                >
                  <ArchiveRestore /> {t("gitRepo.graph.refMenu.popStash")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    const ref = refMenu.ref;
                    void confirmDialog({
                      title: t("gitRepo.graph.refMenu.dropStashConfirm.title"),
                      description: t("gitRepo.graph.refMenu.dropStashConfirm.description"),
                      path: ref.shorthand,
                      confirmLabel: t("gitRepo.graph.refMenu.dropStashConfirm.confirm"),
                      destructive: true,
                    }).then((ok) => {
                      if (ok)
                        void act(t("gitRepo.graph.actions.dropStash"), () =>
                          stashDrop(path, stashIndexOf(ref))
                        );
                    });
                  }}
                >
                  <Trash2 /> {t("gitRepo.graph.refMenu.dropStash")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {refMenu.ref.kind !== "tag" && refMenu.ref.kind !== "stash" && (
              <>
                <DropdownMenuItem onClick={() => checkoutRef(refMenu.ref)}>
                  <Check /> {t("gitRepo.graph.refMenu.checkout", { name: refMenu.ref.shorthand })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void act(
                      t("gitRepo.graph.actions.merge", { name: refMenu.ref.shorthand }),
                      () => branchMerge(path, refMenu.ref.shorthand, true),
                      {
                        kind: "merge",
                        extra: { branch: refMenu.ref.shorthand },
                      }
                    )
                  }
                >
                  <GitMerge /> {t("gitRepo.graph.refMenu.merge")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={refMenuFf !== true}
                  onClick={() =>
                    void act(
                      t("gitRepo.graph.actions.fastForward", { name: refMenu.ref.shorthand }),
                      () => branchMerge(path, refMenu.ref.shorthand, false),
                      {
                        kind: "merge",
                        extra: { branch: refMenu.ref.shorthand },
                      }
                    )
                  }
                >
                  <FastForward /> {t("gitRepo.graph.refMenu.fastForward")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void act(
                      t("gitRepo.graph.actions.rebase", { name: refMenu.ref.shorthand }),
                      () => branchRebase(path, refMenu.ref.shorthand),
                      {
                        kind: "rebase",
                      }
                    )
                  }
                >
                  <ListRestart /> {t("gitRepo.graph.refMenu.rebase")}
                </DropdownMenuItem>
                {refMenuResetTarget && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => resetToRemote(refMenu.ref, refMenu.commit)}
                  >
                    <RotateCcw /> {t("gitRepo.graph.refMenu.reset", { name: refMenuResetTarget })}
                  </DropdownMenuItem>
                )}
                {refMenu.ref.kind === "localBranch" && (
                  <>
                    <DropdownMenuItem
                      onClick={() =>
                        void act(
                          t("gitRepo.graph.actions.pull", { name: refMenu.ref.shorthand }),
                          () => remotePullBranch(path, refMenu.ref.shorthand)
                        )
                      }
                    >
                      <ArrowDownToLine /> {t("gitRepo.graph.refMenu.pull")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void pushBranch(refMenu.ref.shorthand)}>
                      <ArrowUpFromLine /> {t("gitRepo.graph.refMenu.push")}
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(refMenu.ref.shorthand);
                toast.success(t("gitRepo.graph.refMenu.nameCopied"));
              }}
            >
              <Copy /> {t("gitRepo.graph.refMenu.copyName")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {menu && (
        <DropdownMenu open onOpenChange={(o) => !o && setMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: menu.x, top: menu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="font-mono">{menu.commit.shortOid}</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() =>
                void act(
                  t("gitRepo.graph.actions.checkout", { name: menu.commit.shortOid }),
                  () => checkoutDetached(path, menu.commit.oid),
                  {
                    kind: "checkout",
                  }
                )
              }
            >
              {t("gitRepo.graph.commitMenu.checkoutDetached")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                select(menu.commit.oid);
                requestEditMessage(menu.commit.oid);
              }}
            >
              <Pencil /> {t("gitRepo.graph.commitMenu.editMessage")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openDialog("createBranch", menu.commit.oid)}>
              <GitBranchPlus /> {t("gitRepo.graph.commitMenu.createBranch")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openDialog("createTag", menu.commit.oid)}>
              <TagIcon /> {t("gitRepo.graph.commitMenu.createTag")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => openDialog("createWorktree", { oid: menu.commit.oid })}
            >
              <FolderTree /> {t("gitRepo.graph.commitMenu.newWorktree")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {menu.commit.refs.some((ref) => ref.kind === "localBranch") && (
              <>
                {menu.commit.refs
                  .filter((ref) => ref.kind === "localBranch")
                  .map((ref) => (
                    <DropdownMenuItem key={ref.name} onClick={() => void pushBranch(ref.shorthand)}>
                      <ArrowUpFromLine />
                      <span className="max-w-64 truncate">
                        {t("gitRepo.graph.commitMenu.pushBranch", { name: ref.shorthand })}
                      </span>
                      {aheadOf(ref.shorthand) > 0 && (
                        <span className="text-muted-foreground ml-auto pl-3 text-[11px] tabular-nums">
                          ↑{aheadOf(ref.shorthand)}
                        </span>
                      )}
                    </DropdownMenuItem>
                  ))}
                <DropdownMenuSeparator />
              </>
            )}
            {pickSelection ? (
              <DropdownMenuItem onClick={() => openDialog("cherryPick", { oids: pickSelection })}>
                <ListRestart />{" "}
                {t("gitRepo.graph.commitMenu.cherryPick", { count: pickSelection.length })}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => openDialog("cherryPick", menu.commit.oid)}>
                <ListRestart /> {t("gitRepo.graph.commitMenu.cherryPickHere")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() =>
                void act(
                  t("gitRepo.graph.actions.revert", { oid: menu.commit.shortOid }),
                  () => commitRevert(path, menu.commit.oid),
                  {
                    kind: "revert",
                  }
                )
              }
            >
              <Undo2 /> {t("gitRepo.graph.commitMenu.revert")}
            </DropdownMenuItem>
            {multiSelection?.contiguous && (
              <DropdownMenuItem
                onClick={() =>
                  openDialog("interactiveRebase", {
                    baseOid: multiSelection.baseOid,
                    squashOids: selectedOids,
                  })
                }
              >
                <Combine /> {t("gitRepo.graph.commitMenu.squash", { count: multiSelection.count })}
              </DropdownMenuItem>
            )}
            {multiSelection && (
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  openDialog("interactiveRebase", {
                    baseOid: multiSelection.baseOid,
                    dropOids: selectedOids,
                  })
                }
              >
                <Trash2 /> {t("gitRepo.graph.commitMenu.drop", { count: multiSelection.count })}
              </DropdownMenuItem>
            )}
            {!menu.commit.isHead && (
              <DropdownMenuItem onClick={() => openDialog("interactiveRebase", menu.commit.oid)}>
                <ListOrdered /> {t("gitRepo.graph.commitMenu.interactiveRebase")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                void act(
                  t("gitRepo.graph.actions.resetSoft", { oid: menu.commit.shortOid }),
                  () => resetTo(path, menu.commit.oid, "soft"),
                  {
                    kind: "reset",
                  }
                )
              }
            >
              <RotateCcw /> {t("gitRepo.graph.commitMenu.resetSoft")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void act(
                  t("gitRepo.graph.actions.resetMixed", { oid: menu.commit.shortOid }),
                  () => resetTo(path, menu.commit.oid, "mixed"),
                  {
                    kind: "reset",
                  }
                )
              }
            >
              <RotateCcw /> {t("gitRepo.graph.commitMenu.resetMixed")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                void confirmDialog({
                  title: t("gitRepo.graph.commitMenu.hardResetConfirm.title", {
                    oid: menu.commit.shortOid,
                  }),
                  description: t("gitRepo.graph.commitMenu.hardResetConfirm.description"),
                  confirmLabel: t("gitRepo.graph.commitMenu.hardResetConfirm.confirm"),
                  destructive: true,
                }).then((ok) => {
                  if (ok)
                    void act(
                      t("gitRepo.graph.actions.resetHard", { oid: menu.commit.shortOid }),
                      () => resetTo(path, menu.commit.oid, "hard"),
                      {
                        kind: "reset",
                      }
                    );
                });
              }}
            >
              <RotateCcw /> {t("gitRepo.graph.commitMenu.resetHard")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </section>
  );
}
