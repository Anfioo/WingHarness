import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { branchCreate, commitReword, tagCreate } from "@/commands";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/confirm";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { CommitInfo, GraphRow } from "@/lib/git-core";
import { useGitView } from "./git-view-store";
import { runGitAction } from "./actions";
import { executeRewrite, foldInto, fullMessage } from "./rebase-plan";
import type { MenuPoint } from "./context-menu";
import { CommitContextMenu } from "./commit-context-menu";
import { InputDialog, type InputDialogState } from "./dialogs/input-dialog";
import { FixupSquashDialog } from "./dialogs/fixup-squash-dialog";
import { RebaseTodoDialog, type RebaseRequest } from "./dialogs/rebase-todo-dialog";
import { ResetDialog } from "./dialogs/reset-dialog";
import { isValidRefName } from "./ref-name";
import type { ProjectTabOpeners } from "./tab-openers";
import { LOG_ROW_HEIGHT, LogRow, logGutterWidthFor, logLaneWidthFor } from "./log-row";

/** Rows left above the end of the list before the next page is asked for. */
const LOAD_AHEAD = 24;

interface FoldRequest {
  source: CommitInfo;
  /** Every commit folded into the target: the source alone, or the whole selection. */
  sources: CommitInfo[];
  mode: "fixup" | "squash";
}

/**
 * The middle column: the commits of the selected branch, newest first.
 *
 * Rows follow openidea's log: a compact 26px line, thin lane strokes and refs
 * as plain labels — picking a ref here filters, it never checks anything out.
 * Ctrl/Shift click builds a selection the commit menu acts on in one go.
 */
export function CommitList({
  repo,
  branch,
  currentBranch,
  commits,
  rows,
  maxLane,
  selectedOid,
  headBranch,
  loading,
  loadingMore,
  error,
  hasMore,
  openers,
  onSelect,
  onLoadMore,
  onRetry,
}: {
  repo: string | null;
  /** The ref the log is filtered to, or null for every ref. */
  branch: string | null;
  /** The branch HEAD is on, once the refs have been read. */
  currentBranch: string | null;
  commits: readonly CommitInfo[];
  rows: readonly GraphRow[];
  maxLane: number;
  selectedOid: string | null;
  /** The branch HEAD is on, so its label is marked as the current one. */
  headBranch: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  openers: ProjectTabOpeners;
  onSelect: (oid: string | null) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<string | null>(null);
  const selectedOids = useGitView((state) => state.selectedOids);
  const setSelectedOids = useGitView((state) => state.setSelectedOids);

  const [menu, setMenu] = useState<{ point: MenuPoint; primary: CommitInfo } | null>(null);
  const [input, setInput] = useState<InputDialogState | null>(null);
  const [resetCommit, setResetCommit] = useState<CommitInfo | null>(null);
  const [fold, setFold] = useState<FoldRequest | null>(null);
  const [rebase, setRebase] = useState<RebaseRequest | null>(null);

  const laneWidth = logLaneWidthFor(maxLane);
  const gutterWidth = logGutterWidthFor(maxLane, laneWidth);

  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LOG_ROW_HEIGHT,
    overscan: 12,
  });

  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length > 0 ? items[items.length - 1].index : -1;

  useEffect(() => {
    if (lastIndex >= commits.length - LOAD_AHEAD) onLoadMore();
  }, [lastIndex, commits.length, onLoadMore]);

  const selectedCommits = useMemo(
    () => commits.filter((commit) => selectedOids.includes(commit.oid)),
    [commits, selectedOids]
  );

  /** Rewriting only makes sense on the branch the log actually shows. */
  const rewriting = currentBranch !== null && (branch === null || branch === currentBranch);

  // The detail pane picks a commit of its own; the selection follows it so the
  // row is highlighted and the keyboard acts on something.
  useEffect(() => {
    if (selectedOids.length > 0 || selectedOid === null) return;
    if (!commits.some((commit) => commit.oid === selectedOid)) return;
    setSelectedOids([selectedOid]);
  }, [commits, selectedOid, selectedOids.length, setSelectedOids]);

  // A rewrite replaces oids, so rows picked before it no longer exist.
  useEffect(() => {
    if (selectedOids.length === 0) return;
    const known = new Set(commits.map((commit) => commit.oid));
    const next = selectedOids.filter((oid) => known.has(oid));
    if (next.length !== selectedOids.length) setSelectedOids(next);
  }, [commits, selectedOids, setSelectedOids]);

  const scrollTo = useCallback(
    (oid: string) => {
      const index = commits.findIndex((commit) => commit.oid === oid);
      if (index < 0) return;
      virtualizer.scrollToIndex(index, { align: "center" });
      setSelectedOids([oid]);
      anchorRef.current = oid;
      onSelect(oid);
      requestAnimationFrame(() => {
        scrollRef.current?.querySelector<HTMLElement>(`[data-oid="${oid}"]`)?.focus();
      });
    },
    [commits, onSelect, setSelectedOids, virtualizer]
  );

  const handleSelect = useCallback(
    (oid: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
      const toggle = event.ctrlKey || event.metaKey;
      const anchor = anchorRef.current;
      if (event.shiftKey && anchor) {
        const from = commits.findIndex((commit) => commit.oid === anchor);
        const to = commits.findIndex((commit) => commit.oid === oid);
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from];
          setSelectedOids(commits.slice(start, end + 1).map((commit) => commit.oid));
          onSelect(oid);
          return;
        }
      }
      if (toggle) {
        const next = selectedOids.includes(oid)
          ? selectedOids.filter((picked) => picked !== oid)
          : [...selectedOids, oid];
        setSelectedOids(next);
        onSelect(next.length > 0 ? oid : null);
        anchorRef.current = oid;
        return;
      }
      setSelectedOids([oid]);
      onSelect(oid);
      anchorRef.current = oid;
    },
    [commits, onSelect, selectedOids, setSelectedOids]
  );

  // Right-clicking outside the selection makes that row the selection; inside
  // it, the selection stays so the menu can act on every picked row.
  const openMenu = useCallback(
    (commit: CommitInfo, event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (!selectedOids.includes(commit.oid)) setSelectedOids([commit.oid]);
      anchorRef.current = commit.oid;
      onSelect(commit.oid);
      setMenu({ point: { x: event.clientX, y: event.clientY }, primary: commit });
    },
    [onSelect, selectedOids, setSelectedOids]
  );

  const dropCommits = useCallback(
    async (list: readonly CommitInfo[]) => {
      if (!repo || list.length === 0) return;
      if (!rewriting) {
        toast.warning(t("projectGit.error.rewriteCurrentBranch"));
        return;
      }
      const position = new Map(commits.map((commit, index) => [commit.oid, index]));
      const ordered = [...list].sort(
        (left, right) => (position.get(left.oid) ?? 0) - (position.get(right.oid) ?? 0)
      );
      const oldest = ordered[ordered.length - 1];
      const base = oldest.parents[0];
      if (!base) {
        toast.warning(t("projectGit.error.noParentCommit"));
        return;
      }
      if (ordered.some((commit) => commit.parents.length > 1)) {
        toast.warning(t("projectGit.error.noMergeInRange"));
        return;
      }
      const confirmed = await confirmDialog({
        title: t("projectGit.confirm.dropCommit.title"),
        description: t("projectGit.confirm.dropCommit.description"),
        confirmLabel: t("projectGit.confirm.dropCommit.confirm"),
        destructive: true,
      });
      if (!confirmed) return;

      const dropping = new Set(ordered.map((commit) => commit.oid));
      await runGitAction({
        id: "commit.drop",
        label: t("projectGit.menu.commit.drop"),
        success: t("projectGit.toast.rewritten"),
        run: () =>
          executeRewrite(repo, base, (oid) => (dropping.has(oid) ? "drop" : "pick"), {
            required: ordered.map((commit) => commit.oid),
            missingMessage: t("projectGit.error.notInCurrentHistory"),
          }),
      });
    },
    [commits, repo, rewriting, t]
  );

  const openFold = useCallback(
    (source: CommitInfo, mode: "fixup" | "squash") => {
      const sources =
        selectedOids.includes(source.oid) && selectedCommits.length > 1
          ? selectedCommits
          : [source];
      setFold({ source, sources, mode });
    },
    [selectedCommits, selectedOids]
  );

  const foldCandidates = useMemo(() => {
    if (!fold) return [];
    const position = new Map(commits.map((commit, index) => [commit.oid, index]));
    const oldest = Math.max(...fold.sources.map((commit) => position.get(commit.oid) ?? -1));
    if (oldest < 0) return [];
    // The target needs a parent: the rewrite starts there, and a merge commit
    // cannot be folded into.
    return commits.slice(oldest + 1).filter((commit) => commit.parents.length === 1);
  }, [commits, fold]);

  const foldPick = useCallback(
    (target: CommitInfo) => {
      const request = fold;
      setFold(null);
      if (!request || !repo) return;
      void runGitAction({
        id: "commit.fold",
        label: t(
          request.mode === "fixup"
            ? "projectGit.menu.commit.fixup"
            : "projectGit.menu.commit.squashInto"
        ),
        success: t("projectGit.toast.rewritten"),
        run: () =>
          foldInto(
            repo,
            target,
            request.sources,
            request.mode,
            t("projectGit.error.notInCurrentHistory")
          ),
      });
    },
    [fold, repo, t]
  );

  const reword = useCallback(
    (commit: CommitInfo) => {
      if (!repo) return;
      const message = fullMessage(commit);
      if (commit.isHead) {
        setInput({
          title: t("projectGit.dialog.reword.title"),
          label: t("projectGit.dialog.reword.label"),
          initialValue: message,
          confirmLabel: t("projectGit.dialog.reword.submit"),
          multiline: true,
          submit: (value) =>
            runGitAction({
              id: "commit.reword",
              label: t("projectGit.menu.commit.reword"),
              success: t("projectGit.toast.reworded"),
              run: () => commitReword(repo, commit.oid, value),
            }),
        });
        return;
      }
      const base = commit.parents[0];
      if (!base) {
        toast.warning(t("projectGit.error.noParentCommit"));
        return;
      }
      setRebase({
        base,
        presets: { [commit.oid]: "reword" },
        messages: { [commit.oid]: message },
      });
    },
    [repo, t]
  );

  const newBranch = useCallback(
    (commit: CommitInfo) => {
      if (!repo) return;
      setInput({
        title: t("gitRepo.sidebar.dialogs.createBranch.title"),
        description: t("projectGit.dialog.branchFrom", { name: commit.shortOid }),
        label: t("gitRepo.sidebar.dialogs.createBranch.nameLabel"),
        placeholder: t("gitRepo.sidebar.dialogs.createBranch.namePlaceholder"),
        confirmLabel: t("gitRepo.sidebar.dialogs.createBranch.submit"),
        validate: (value) => (isValidRefName(value) ? null : t("projectGit.dialog.invalidBranch")),
        submit: (name) =>
          runGitAction({
            id: "commit.newBranch",
            label: t("projectGit.menu.commit.newBranch"),
            success: t("projectGit.toast.branchCreated", { name }),
            run: () => branchCreate(repo, name, commit.oid, false),
          }),
      });
    },
    [repo, t]
  );

  const newTag = useCallback(
    (commit: CommitInfo) => {
      if (!repo) return;
      setInput({
        title: t("projectGit.dialog.tagTitle"),
        description: t("projectGit.dialog.tagDescription", { oid: commit.shortOid }),
        label: t("projectGit.dialog.tagLabel"),
        placeholder: t("projectGit.dialog.tagPlaceholder"),
        confirmLabel: t("projectGit.dialog.tagSubmit"),
        validate: (value) => (isValidRefName(value) ? null : t("projectGit.dialog.invalidTag")),
        submit: (name) =>
          runGitAction({
            id: "commit.newTag",
            label: t("projectGit.menu.commit.newTag"),
            success: t("projectGit.toast.tagCreated", { name }),
            run: () => tagCreate(repo, name, commit.oid),
          }),
      });
    },
    [repo, t]
  );

  const interactiveRebase = useCallback((commit: CommitInfo) => {
    setRebase({ base: commit.oid });
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, commit: CommitInfo) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const index = commits.findIndex((row) => row.oid === commit.oid);
        const next = index < 0 ? undefined : commits[index + (event.key === "ArrowDown" ? 1 : -1)];
        if (!next) return;
        event.preventDefault();
        scrollTo(next.oid);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        scrollTo(commit.oid);
        return;
      }
      if (event.key === "Delete" || (event.metaKey && event.key === "Backspace")) {
        event.preventDefault();
        void dropCommits(selectedOids.includes(commit.oid) ? selectedCommits : [commit]);
        return;
      }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu({ point: { x: rect.left + 24, y: rect.top + rect.height }, primary: commit });
      }
    },
    [commits, dropCommits, scrollTo, selectedCommits, selectedOids]
  );

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeInput = useCallback(() => setInput(null), []);
  const closeFold = useCallback(() => setFold(null), []);
  const closeReset = useCallback(() => setResetCommit(null), []);
  const closeRebase = useCallback(() => setRebase(null), []);

  const menuSelected = useMemo(() => {
    if (!menu) return [];
    return selectedCommits.some((commit) => commit.oid === menu.primary.oid)
      ? selectedCommits
      : [menu.primary];
  }, [menu, selectedCommits]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="@container min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        aria-label={t("gitRepo.commit.list.aria")}
      >
        {loading && commits.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        ) : error && commits.length === 0 ? (
          <div className="flex flex-col items-start gap-2 px-3 py-4">
            <p className="text-destructive text-xs [overflow-wrap:anywhere]">{error}</p>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              {t("gitRepo.diff.panel.retry")}
            </Button>
          </div>
        ) : commits.length === 0 ? (
          <p className="text-muted-foreground px-3 py-4 text-xs">{t("projectGit.noCommits")}</p>
        ) : (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((item) => {
              const commit = commits[item.index];
              const row = rows[item.index];
              if (!commit || !row) return null;
              return (
                <div
                  key={item.key}
                  className="absolute top-0 left-0 w-full"
                  style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  <LogRow
                    commit={commit}
                    row={row}
                    gutterWidth={gutterWidth}
                    laneWidth={laneWidth}
                    selected={selectedOids.includes(commit.oid)}
                    headBranch={headBranch}
                    onSelect={handleSelect}
                    onContextMenu={openMenu}
                    onKeyDown={handleKeyDown}
                  />
                </div>
              );
            })}
            {loadingMore && (
              <div className="absolute inset-x-0 bottom-0 flex justify-center py-1">
                <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
              </div>
            )}
          </div>
        )}
      </div>
      {error && commits.length > 0 && (
        <p className="text-destructive border-border border-t px-3 py-1 text-[11px]">{error}</p>
      )}
      {!hasMore && commits.length > 0 && !loading && (
        <p className="text-faint border-border border-t px-3 py-1 text-[11px]">
          {t("projectGit.endOfHistory")}
        </p>
      )}

      <CommitContextMenu
        repo={repo}
        point={menu?.point ?? null}
        primary={menu?.primary ?? null}
        selected={menuSelected}
        commits={commits}
        currentBranch={currentBranch}
        branch={branch}
        onClose={closeMenu}
        onReset={setResetCommit}
        onReword={reword}
        onFixup={(commit) => openFold(commit, "fixup")}
        onSquash={(commit) => openFold(commit, "squash")}
        onDrop={(list) => void dropCommits(list)}
        onInteractiveRebase={interactiveRebase}
        onNewBranch={newBranch}
        onNewTag={newTag}
        onGoTo={scrollTo}
        onShowRevision={(commit) => openers.openRevisionTree(commit.oid)}
        onCompareWithWorktree={(commit) => openers.openCompare(commit.oid, null)}
      />
      <ResetDialog repo={repo} commit={resetCommit} onClose={closeReset} />
      <FixupSquashDialog
        source={fold?.source ?? null}
        mode={fold?.mode ?? "fixup"}
        candidates={foldCandidates}
        onPick={foldPick}
        onClose={closeFold}
      />
      <RebaseTodoDialog repo={repo} request={rebase} onClose={closeRebase} />
      <InputDialog request={input} onClose={closeInput} />
    </div>
  );
}
