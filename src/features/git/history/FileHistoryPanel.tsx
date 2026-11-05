import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  Copy,
  FileCheck,
  FileText,
  GitCommitHorizontal,
  History,
  Loader2,
  MousePointerClick,
  Pencil,
  TextSelect,
  UserRoundSearch,
  X,
} from "lucide-react";
import type { CommitInfo, FileDiff } from "@/lib/git-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { basename, timeAgo } from "@/features/git/utils";
import { Hint, Kbd } from "@/features/git/diff/diff-ui";
import { PaneEmpty } from "@/pages/git-repo/pane-empty";
import { SettingEmpty } from "@/features/git/settings/SettingCard";
import { AuthorAvatar } from "@/features/git/inspector/author-avatar";
import { historyFile, diffFile, diffCommit } from "@/commands";
import { useRepo } from "@/features/git/repository-store";
import { useGraph } from "@/features/git/graph/store";
import { useUi } from "@/features/git/ui-store";
import { captureSelectionRanges, useKeepSelection } from "@/features/git/diff/keep-selection";
import { DiffViewer } from "@/features/git/diff/diff-viewer";
import { DiffViewControls } from "@/features/git/diff/diff-view-controls";
import { changeBlocks, DiffMinimap } from "@/features/git/diff/diff-minimap";
import { ChangeNavButtons, useChangeJump } from "@/features/git/diff/change-nav";
import { BlameView } from "@/features/git/blame/BlameView";
import { useDiffFind } from "@/features/git/diff/diff-search";
import { useDiffSelectAll } from "@/features/git/diff/diff-copy";
import { diffSelectionText } from "@/features/git/diff/diff-selection";
import type { LineMenuInfo } from "@/features/git/diff/virtual-diff";

const HISTORY_PAGE = 500;
const COMMIT_ROW_ESTIMATE = 54;
const WORKING_COPY = "working-copy";

function VirtualCommitList({
  commits,
  scrollRef,
  renderRow,
}: {
  commits: CommitInfo[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  renderRow: (commit: CommitInfo) => React.ReactNode;
}) {
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => COMMIT_ROW_ESTIMATE,
    getItemKey: (index) => commits[index].oid,
    overscan: 12,
  });
  return (
    <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => (
        <li
          key={item.key}
          className="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${item.start}px)` }}
        >
          {renderRow(commits[item.index])}
        </li>
      ))}
    </ul>
  );
}

export function FileHistoryPanel() {
  const { t } = useAppTranslation();
  const file = useUi((s) => s.centerFileHistory) ?? "";
  const preset = useUi((s) => s.fileHistoryPreset);
  const closeFileHistory = useUi((s) => s.closeFileHistory);
  const diffView = useUi((s) => s.diffView);
  const ignoreWhitespace = useUi((s) => s.ignoreWhitespace);
  const fullFileDiff = useUi((s) => s.fullFileDiff);
  const path = useRepo((s) => s.repo?.path) ?? "";
  const revealCommit = useGraph((s) => s.revealCommit);

  const [pane, setPane] = useState(() => useUi.getState().fileHistoryPreset?.pane ?? "diff");
  const pendingRev = useRef<string | null>(null);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const historySeq = useRef(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);

  const textDiff = diff && !diff.isBinary && !diff.isImage ? diff : null;
  const blocks = useMemo(
    () => (textDiff ? changeBlocks(textDiff, diffView) : []),
    [textDiff, diffView]
  );
  const { jump: jumpChange } = useChangeJump(blocks, scrollRef);
  const { findBar, search } = useDiffFind(textDiff, scrollRef);
  const { selectAllOverlay, selectSide } = useDiffSelectAll(textDiff, scrollRef);

  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; commit: CommitInfo } | null>(
    null
  );
  const [lineMenu, setLineMenu] = useState<{
    x: number;
    y: number;
    info: LineMenuInfo;
    selection: string;
    ranges: Range[];
  } | null>(null);
  useKeepSelection(lineMenu?.ranges ?? null);

  const openCommit = (commit: CommitInfo) => {
    void revealCommit(path, commit.oid);
    closeFileHistory();
  };
  const openCommitOid = (oid: string) => {
    void revealCommit(path, oid);
    closeFileHistory();
  };

  useEffect(() => {
    if (!preset) return;
    const rev = preset.rev ?? WORKING_COPY;
    pendingRev.current = rev;
    setPane(preset.pane);
    setSelected(rev);
    useUi.getState().clearFileHistoryPreset();
  }, [preset]);

  useEffect(() => {
    if (!path || !file) return;
    const counter = historySeq;
    const seq = ++counter.current;
    setCommits(null);
    setHistoryError(null);
    setSelected(null);
    setHasMore(false);
    setLoadingMore(false);
    void historyFile(path, file, HISTORY_PAGE)
      .then((page) => {
        if (seq !== counter.current) return;
        setCommits(page.commits);
        setHasMore(page.hasMore);
        setSelected(pendingRev.current ?? page.commits[0]?.oid ?? null);
        pendingRev.current = null;
      })
      .catch((error) => {
        if (seq !== counter.current) return;
        setHistoryError((error as { message?: string }).message ?? String(error));
      });
    return () => {
      counter.current++;
    };
  }, [path, file, historyAttempt]);

  const loadOlder = () => {
    if (!path || !commits || loadingMore) return;
    setLoadingMore(true);
    const seq = historySeq.current;
    void historyFile(path, file, HISTORY_PAGE, commits.length)
      .then((page) => {
        if (seq !== historySeq.current) return;
        setCommits([...commits, ...page.commits]);
        setHasMore(page.hasMore);
      })
      .catch((error) => {
        toast.error(
          t("gitRepo.inspector.history.loadMoreFailed", {
            error: (error as { message?: string }).message ?? String(error),
          })
        );
      })
      .finally(() => {
        if (seq === historySeq.current) setLoadingMore(false);
      });
  };

  useEffect(() => {
    if (!path || !file || !selected || pane === "blame") {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    const context = fullFileDiff ? 10_000_000 : undefined;
    const request =
      selected === WORKING_COPY
        ? diffFile(path, file, false, context, ignoreWhitespace).then((d) =>
            d.hunks.length > 0 ? d : null
          )
        : diffCommit(path, selected, context, ignoreWhitespace).then(
            (diffs) => diffs.find((d) => d.path === file) ?? null
          );
    void request
      .then((found) => {
        if (cancelled) return;
        setDiff(found);
        scrollRef.current?.scrollTo({ top: 0 });
      })
      .catch((error) => {
        if (cancelled) return;
        toast.error(
          t("gitRepo.inspector.history.diffFailed", {
            error: (error as { message?: string }).message ?? String(error),
          })
        );
        setDiff(null);
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, file, selected, fullFileDiff, ignoreWhitespace, pane, t]);

  if (!file) return null;

  return (
    <section
      className="bg-background flex h-full flex-col"
      aria-label={t("gitRepo.inspector.history.aria", { file })}
    >
      <div className="border-border bg-card flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Hint
          label={
            <span className="flex items-center gap-1">
              {t("gitRepo.inspector.history.backToGraph")} <Kbd>Esc</Kbd>
            </span>
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("gitRepo.inspector.history.close")}
            onClick={closeFileHistory}
          >
            <X className="size-4" />
          </Button>
        </Hint>
        <History className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file}</span>
        {diff && !diff.isBinary && !diff.isImage && (
          <span className="shrink-0 text-xs">
            <span className="text-success">+{diff.additions}</span>{" "}
            <span className="text-destructive">−{diff.deletions}</span>
          </span>
        )}
        <div className="border-border flex items-center rounded-md border p-0.5">
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-6 px-2", pane === "diff" && "bg-muted text-foreground")}
            aria-pressed={pane === "diff"}
            aria-label={t("gitRepo.inspector.history.diffView")}
            onClick={() => setPane("diff")}
          >
            {t("gitRepo.inspector.history.diffTab")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-6 px-2", pane === "blame" && "bg-muted text-foreground")}
            aria-pressed={pane === "blame"}
            aria-label={t("gitRepo.inspector.history.blameView")}
            onClick={() => setPane("blame")}
          >
            <UserRoundSearch className="size-3.5" />
            {t("gitRepo.inspector.history.blameTab")}
          </Button>
        </div>
        {pane === "diff" && (
          <>
            <DiffViewControls />
            <ChangeNavButtons blocks={blocks} onJump={jumpChange} />
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          ref={listScrollRef}
          className="border-border bg-card w-72 shrink-0 overflow-y-auto border-r"
        >
          {historyError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-destructive text-sm">
                {t("gitRepo.inspector.history.errorTitle", { error: historyError })}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setHistoryAttempt((n) => n + 1)}>
                {t("gitRepo.inspector.history.retry")}
              </Button>
            </div>
          ) : commits === null ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            </div>
          ) : commits.length === 0 ? (
            <PaneEmpty
              icon={<GitCommitHorizontal />}
              title={t("gitRepo.inspector.history.noHistoryTitle")}
              hint={t("gitRepo.inspector.history.noHistoryHint")}
            />
          ) : (
            <>
              <div
                role="button"
                tabIndex={0}
                data-working-copy-row
                className={cn(
                  "border-border flex w-full cursor-pointer items-start gap-2.5 border-b px-3 py-2.5 text-left",
                  selected === WORKING_COPY
                    ? "border-l-primary bg-muted border-l-2"
                    : "hover:bg-muted/60 border-l-2 border-l-transparent"
                )}
                onClick={() => setSelected(WORKING_COPY)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(WORKING_COPY);
                  }
                }}
              >
                <span className="bg-primary/15 text-primary flex size-6 shrink-0 items-center justify-center rounded-full">
                  <Pencil className="size-3" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-xs">
                    {t("gitRepo.inspector.history.workingCopy")}
                  </span>
                  <span className="text-muted-foreground block truncate text-[11px]">
                    {t("gitRepo.inspector.history.workingCopyHint")}
                  </span>
                </span>
              </div>
              <VirtualCommitList
                commits={commits}
                scrollRef={listScrollRef}
                renderRow={(commit) => (
                  <div
                    role="button"
                    tabIndex={0}
                    className={cn(
                      "group border-border flex w-full cursor-pointer items-start gap-2.5 border-b px-3 py-2.5 text-left",
                      selected === commit.oid
                        ? "border-l-primary bg-muted border-l-2"
                        : "hover:bg-muted/60 border-l-2 border-l-transparent"
                    )}
                    onClick={() => setSelected(commit.oid)}
                    onDoubleClick={() => openCommit(commit)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(commit.oid);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCommitMenu({ x: e.clientX, y: e.clientY, commit });
                    }}
                  >
                    <AuthorAvatar name={commit.author.name} email={commit.author.email} size={24} />
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-xs">
                        {commit.summary}
                      </span>
                      <span className="text-muted-foreground block truncate text-[11px]">
                        {commit.author.name} · {timeAgo(commit.author.time)}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {commit.shortOid}
                      </Badge>
                      <Hint label={t("gitRepo.inspector.history.openInGraph")}>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="h-5 w-5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          aria-label={t("gitRepo.inspector.history.openCommitAria", {
                            oid: commit.shortOid,
                          })}
                          onClick={(e) => {
                            e.stopPropagation();
                            openCommit(commit);
                          }}
                        >
                          <GitCommitHorizontal className="size-3.5" />
                        </Button>
                      </Hint>
                    </span>
                  </div>
                )}
              />
              {hasMore && (
                <div className="py-2 text-center">
                  <Button variant="ghost" size="sm" disabled={loadingMore} onClick={loadOlder}>
                    {loadingMore ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      t("gitRepo.inspector.history.showOlder")
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1">
          {findBar}
          {selectAllOverlay}
          {pane === "blame" ? (
            <BlameView
              file={file}
              rev={selected === WORKING_COPY ? null : selected}
              onOpenCommit={openCommitOid}
              onBlameAt={setSelected}
              onResolvedRev={setSelected}
            />
          ) : (
            <>
              <div
                ref={scrollRef}
                data-history-diff-scroller
                className="min-h-0 min-w-0 flex-1 overflow-y-auto"
              >
                {diffLoading ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="text-muted-foreground size-5 animate-spin" />
                  </div>
                ) : diff ? (
                  <DiffViewer
                    diff={diff}
                    scrollRef={scrollRef}
                    search={search}
                    onLineContextMenu={(e, info) => {
                      e.preventDefault();
                      setLineMenu({
                        x: e.clientX,
                        y: e.clientY,
                        info,
                        selection:
                          diffSelectionText(scrollRef.current) ??
                          window.getSelection()?.toString() ??
                          "",
                        ranges: captureSelectionRanges(),
                      });
                    }}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center p-8">
                    <div className="w-full max-w-sm">
                      {selected === WORKING_COPY ? (
                        <SettingEmpty
                          icon={<FileCheck className="size-4" />}
                          title={t("gitRepo.inspector.history.noUncommittedTitle")}
                          description={t("gitRepo.inspector.history.noUncommittedHint", {
                            file: basename(file),
                          })}
                        />
                      ) : selected ? (
                        <SettingEmpty
                          icon={<FileText className="size-4" />}
                          title={t("gitRepo.inspector.history.nothingChangedTitle")}
                          description={t("gitRepo.inspector.history.nothingChangedHint", {
                            file: basename(file),
                          })}
                        />
                      ) : (
                        <SettingEmpty
                          icon={<MousePointerClick className="size-4" />}
                          title={t("gitRepo.inspector.history.pickCommitTitle")}
                          description={t("gitRepo.inspector.history.pickCommitHint")}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
              {diff && !diffLoading && (
                <DiffMinimap diff={diff} view={diffView} scrollRef={scrollRef} />
              )}
            </>
          )}
        </div>
      </div>

      {commitMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setCommitMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: commitMenu.x, top: commitMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuItem onClick={() => openCommit(commitMenu.commit)}>
              <GitCommitHorizontal /> {t("gitRepo.inspector.history.openInGraph")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(commitMenu.commit.oid);
                toast.success(t("gitRepo.inspector.history.hashCopied"));
              }}
            >
              <Copy /> {t("gitRepo.inspector.history.copyHash")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {lineMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setLineMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: lineMenu.x, top: lineMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {lineMenu.selection && (
              <DropdownMenuItem
                onClick={() => {
                  void navigator.clipboard.writeText(lineMenu.selection);
                  toast.success(t("gitRepo.inspector.history.copied"));
                }}
              >
                <Copy /> {t("gitRepo.inspector.history.copy")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(lineMenu.info.line.content);
                toast.success(t("gitRepo.inspector.history.lineCopied"));
              }}
            >
              <Copy /> {t("gitRepo.inspector.history.copyLine")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => selectSide(lineMenu.info.side ?? "new")}>
              <TextSelect /> {t("gitRepo.inspector.history.selectAll")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </section>
  );
}
