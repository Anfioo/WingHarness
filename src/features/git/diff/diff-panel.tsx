import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  History,
  Loader2,
  Minus,
  Plus,
  Space,
  TextSelect,
  Trash2,
  UserRoundSearch,
  X,
} from "lucide-react";
import type { CommitFileInfo, FileDiff } from "@/lib/git-core";
import { hasCommittedHistory } from "@/lib/git-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/components/confirm";
import { PaneEmpty } from "@/pages/git-repo/pane-empty";
import {
  diffCommitFile,
  diffCommitFiles,
  diffFile,
  discardLine,
  fileContents,
  stageFile,
  stageHunk,
  stageLine,
  unstageFile,
  unstageHunk,
  unstageLine,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRepo } from "@/features/git/repository-store";
import { useUi, type CenterDiffTarget } from "@/features/git/ui-store";
import { useShortcuts } from "./use-shortcuts";
import { captureSelectionRanges, useKeepSelection } from "./keep-selection";
import { Hint, Kbd } from "./diff-ui";
import { wrapUnavailable } from "./diff-shared";
import { useDiffFind } from "./diff-search";
import { useDiffSelectAll } from "./diff-copy";
import { diffSelectionText } from "./diff-selection";
import { DiffViewer } from "./diff-viewer";
import { changeBlocks, DiffMinimap, scrollToFraction } from "./diff-minimap";
import { ChangeNavButtons, useChangeJump } from "./change-nav";
import { DiffLayoutToggle, DiffViewControls, MenuNote } from "./diff-view-controls";
import type { LineMenuInfo } from "./virtual-diff";

const COMPACT_HEADER_WIDTH = 960;

function useCompactHeader(ref: React.RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setCompact(el.clientWidth < COMPACT_HEADER_WIDTH);
    const observer = new ResizeObserver(() => setCompact(el.clientWidth < COMPACT_HEADER_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return compact;
}

export function DiffPanel({ target }: { target?: CenterDiffTarget } = {}) {
  const storeTarget = useUi((s) => s.centerDiff);
  const resolved = target ?? storeTarget;
  if (!resolved) return null;
  return <DiffPanelBody target={resolved} />;
}

function DiffPanelBody({ target }: { target: CenterDiffTarget }) {
  const { t } = useAppTranslation();
  const repo = useRepo((s) => s.repo);
  const status = useRepo((s) => s.status);
  const statusVersion = useRepo((s) => s.statusVersion);
  const refreshStatus = useRepo((s) => s.refreshStatus);
  const closeCenterDiff = useUi((s) => s.closeCenterDiff);
  const openCenterDiff = useUi((s) => s.openCenterDiff);
  const openFileHistory = useUi((s) => s.openFileHistory);
  const openBlame = useUi((s) => s.openBlame);
  const diffView = useUi((s) => s.diffView);
  const ignoreWhitespace = useUi((s) => s.ignoreWhitespace);
  const fullFileDiff = useUi((s) => s.fullFileDiff);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const loadedKey = useRef<string | null>(null);
  const requestSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const compact = useCompactHeader(headerRef);
  const [lineMenu, setLineMenu] = useState<{
    x: number;
    y: number;
    info: LineMenuInfo;
    selection: string;
    ranges: Range[];
  } | null>(null);
  useKeepSelection(lineMenu?.ranges ?? null);
  const textDiff = diff && !diff.isBinary && !diff.isImage ? diff : null;
  const { findBar, search } = useDiffFind(textDiff, scrollRef);
  const highlight = search;
  const { selectAllOverlay, selectSide } = useDiffSelectAll(textDiff, scrollRef);

  const path = repo?.path ?? "";
  const isWorkingCopy = target.oid === undefined;
  const blankText = !!diff && !diff.isBinary && !diff.isImage && diff.hunks.length === 0;
  const whitespaceOnly = ignoreWhitespace && !target.unchanged && blankText;
  const emptyFile =
    !!diff &&
    !!target.unchanged &&
    !diff.isBinary &&
    !diff.isImage &&
    diff.hunks.every((hunk) => hunk.lines.length === 0);

  const fetchDiff = async (
    contextLines?: number,
    ignore = ignoreWhitespace
  ): Promise<FileDiff | null> => {
    if (target.unchanged) return fileContents(path, target.path, target.oid ?? undefined);
    if (target.oid) {
      const result = await diffCommitFile(
        path,
        target.oid,
        target.path,
        target.oldPath ?? undefined,
        contextLines,
        ignore
      );
      const untouched =
        result.hunks.length === 0 &&
        result.additions === 0 &&
        result.deletions === 0 &&
        !result.isBinary &&
        !result.isImage;
      return untouched && !ignore ? null : result;
    }
    return diffFile(path, target.path, target.staged ?? false, contextLines, ignore);
  };

  const [commitFileList, setCommitFileList] = useState<CommitFileInfo[]>([]);
  const commitFiles = useMemo(() => commitFileList.map((f) => f.path), [commitFileList]);

  useEffect(() => {
    if (!path || !target.oid) {
      setCommitFileList([]);
      return;
    }
    let cancelled = false;
    void diffCommitFiles(path, target.oid)
      .then((files) => {
        if (!cancelled) setCommitFileList(files);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path, target.oid]);

  const workingSiblings = useMemo(
    () =>
      isWorkingCopy && status
        ? status.files.filter((f) => (target.staged ? f.staged : f.unstaged)).map((f) => f.path)
        : [],
    [isWorkingCopy, status, target.staged]
  );
  const siblings = isWorkingCopy ? workingSiblings : commitFiles;
  const fileIndex = siblings.indexOf(target.path);

  const goFile = (direction: 1 | -1) => {
    if (fileIndex < 0) return;
    const next = siblings[fileIndex + direction];
    if (!next) return;
    if (target.oid) {
      openCenterDiff({
        path: next,
        oid: target.oid,
        oldPath: commitFileList.find((f) => f.path === next)?.oldPath ?? null,
      });
    } else {
      const staged = target.staged ?? false;
      useUi.getState().selectFile({ path: next, staged });
      openCenterDiff({ path: next, staged });
    }
  };
  const goFileRef = useRef(goFile);
  goFileRef.current = goFile;
  const stepChangeRef = useRef<(direction: 1 | -1) => boolean>(() => false);
  const arrowKeysBelongHere = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return false;
    const ui = useUi.getState();
    if (ui.paletteOpen || ui.dialog || ui.conflictFile) return false;
    const active = document.activeElement;
    return !active || active === document.body || !!rootRef.current?.contains(active);
  };

  useShortcuts(
    useMemo(
      () => [
        { combo: "[", handler: () => goFileRef.current(-1), skipInInput: true },
        { combo: "]", handler: () => goFileRef.current(1), skipInInput: true },
        {
          combo: "arrowright",
          skipInInput: true,
          handler: (event: KeyboardEvent) => {
            if (!arrowKeysBelongHere(event)) return;
            stepChangeRef.current(1);
          },
        },
        {
          combo: "arrowleft",
          skipInInput: true,
          handler: (event: KeyboardEvent) => {
            if (!arrowKeysBelongHere(event)) return;
            useUi.getState().closeCenterDiff();
            useUi.getState().focusGraph();
          },
        },
      ],

      []
    )
  );

  useEffect(() => {
    if (!isWorkingCopy || !status) return;
    const entry = status.files.find((f) => f.path === target.path);
    if (target.unchanged) {
      if (entry && (entry.unstaged || entry.staged)) {
        openCenterDiff({ path: target.path, staged: !entry.unstaged });
      }
      return;
    }
    const stillHasThisSide = target.staged ? !!entry?.staged : !!entry?.unstaged;
    if (stillHasThisSide) return;
    const hasOtherSide = target.staged ? !!entry?.unstaged : !!entry?.staged;
    if (hasOtherSide) openCenterDiff({ path: target.path, staged: !target.staged });
    else closeCenterDiff();
  }, [
    status,
    isWorkingCopy,
    target.path,
    target.staged,
    target.unchanged,
    openCenterDiff,
    closeCenterDiff,
  ]);

  const blocks = useMemo(
    () => (diff && !diff.isBinary && !diff.isImage ? changeBlocks(diff, diffView) : []),
    [diff, diffView]
  );
  const anchorChangeRef = useRef<(index: number | null) => void>(() => undefined);
  const autoJumpKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (!diff || loading) return;
    const key = `${path}|${target.path}|${target.oid ?? ""}|${target.staged ?? false}`;
    if (autoJumpKey.current === key) return;
    const el = scrollRef.current;
    if (!el) return;
    autoJumpKey.current = key;
    const apply = () => {
      if (blocks.length > 0) scrollToFraction(el, blocks[0].fraction, "auto");
      else el.scrollTo({ top: 0 });
      anchorChangeRef.current(blocks.length > 0 ? 0 : null);
    };
    apply();
    const applied = el.scrollTop;
    requestAnimationFrame(() => {
      if (autoJumpKey.current === key && applied > 0 && el.scrollTop === 0) apply();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, loading, blocks]);

  const {
    jump: jumpChange,
    step: stepChange,
    anchor: anchorChange,
  } = useChangeJump(blocks, scrollRef, { arrowKeys: true, ready: !!diff && !loading });
  stepChangeRef.current = stepChange;
  anchorChangeRef.current = anchorChange;

  const statusEntry = isWorkingCopy ? status?.files.find((f) => f.path === target.path) : undefined;
  const statusSignature = isWorkingCopy
    ? `${statusEntry?.staged ?? ""}|${statusEntry?.unstaged ?? ""}|${statusVersion}`
    : "";
  const blameable = !isWorkingCopy || !statusEntry || hasCommittedHistory(statusEntry);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const seq = ++requestSeq.current;
    const key = `${path}|${target.path}|${target.oid ?? ""}|${target.staged ?? false}|${target.unchanged ?? false}|${fullFileDiff}|${ignoreWhitespace}|${reloadToken}`;
    if (loadedKey.current !== key) setLoading(true);
    void fetchDiff(fullFileDiff ? 10_000_000 : undefined)
      .then((result) => {
        if (!cancelled && seq === requestSeq.current) {
          setDiff(result);
          setLoadError(null);
          loadedKey.current = key;
        }
      })
      .catch((error) => {
        if (!cancelled && seq === requestSeq.current) {
          setLoadError(String((error as { message?: string }).message ?? error));
          setDiff(null);
          loadedKey.current = key;
        }
      })
      .finally(() => {
        if (!cancelled && seq === requestSeq.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    path,
    target.path,
    target.oid,
    target.staged,
    target.unchanged,
    fullFileDiff,
    ignoreWhitespace,
    reloadToken,
    statusSignature,
  ]);

  const runStage = async (op: () => Promise<unknown>, label: string) => {
    try {
      await op();
      await refreshStatus();
    } catch (error) {
      toast.error(
        t("gitRepo.diff.action.failed", {
          action: label,
          message: (error as { message?: string }).message ?? error,
        })
      );
    }
  };

  return (
    <section
      ref={rootRef}
      className="bg-background flex h-full flex-col"
      aria-label={t("gitRepo.diff.panel.ariaLabel", { path: target.path })}
    >
      <div
        ref={headerRef}
        data-diff-header={compact ? "compact" : "full"}
        className="border-border bg-card flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-3 whitespace-nowrap"
      >
        <Hint
          label={
            <span className="flex items-center gap-1">
              {t("gitRepo.diff.panel.backToGraph")} <Kbd>Esc</Kbd>
            </span>
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("gitRepo.diff.panel.close")}
            onClick={closeCenterDiff}
          >
            <X className="size-4" />
          </Button>
        </Hint>
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{target.path}</span>
        {target.oid && (
          <Badge variant="secondary" className="font-mono">
            {target.oid.slice(0, 8)}
          </Badge>
        )}
        {target.unchanged ? (
          <Badge variant="secondary">{t("gitRepo.diff.panel.unchanged")}</Badge>
        ) : (
          !target.oid && (
            <Badge variant="outline" className={target.staged ? "text-success" : "text-info"}>
              {target.staged ? t("gitRepo.diff.panel.staged") : t("gitRepo.diff.panel.unstaged")}
            </Badge>
          )
        )}
        {diff && !diff.isBinary && !diff.isImage && !target.unchanged && (
          <span className="shrink-0 text-xs">
            <span className="text-success">+{diff.additions}</span>{" "}
            <span className="text-destructive">−{diff.deletions}</span>
          </span>
        )}
        <Separator orientation="vertical" className="mx-1 h-4" />
        {target.oid && !target.unchanged && !target.stash && <DiffLayoutToggle />}
        <DiffViewControls
          wrapDisabled={!!textDiff && wrapUnavailable(textDiff)}
          notes={
            <>
              {ignoreWhitespace && <MenuNote>{t("gitRepo.diff.panel.stagingOffNote")}</MenuNote>}
              {textDiff && wrapUnavailable(textDiff) && (
                <MenuNote>{t("gitRepo.diff.panel.wrapOffNote")}</MenuNote>
              )}
            </>
          }
        />
        <Hint label={t("gitRepo.diff.panel.fileHistory")}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("gitRepo.diff.panel.fileHistory")}
            onClick={() => openFileHistory(target.path)}
          >
            <History className="size-3.5" />
          </Button>
        </Hint>
        <Hint
          label={
            !blameable
              ? t("gitRepo.diff.panel.blameUnavailable")
              : target.oid
                ? t("gitRepo.diff.panel.blameAtCommit")
                : t("gitRepo.diff.panel.blame")
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("gitRepo.diff.panel.blame")}
            disabled={!blameable}
            onClick={() => openBlame(target.path, target.oid ?? null)}
          >
            <UserRoundSearch className="size-3.5" />
          </Button>
        </Hint>
        <ChangeNavButtons blocks={blocks} onJump={jumpChange} showCount={!compact} />
        {siblings.length > 1 && fileIndex >= 0 && (
          <>
            <Separator orientation="vertical" className="mx-1 h-4" />
            <Hint
              label={
                <span className="flex items-center gap-1">
                  {t("gitRepo.diff.panel.previousFile")} <Kbd>[</Kbd>
                </span>
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("gitRepo.diff.panel.previousFile")}
                disabled={fileIndex <= 0}
                onClick={() => goFile(-1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
            </Hint>
            <span className={cn("text-faint text-[10px] tabular-nums", compact && "sr-only")}>
              {t("gitRepo.diff.panel.filePosition", {
                current: fileIndex + 1,
                total: siblings.length,
              })}
            </span>
            <Hint
              label={
                <span className="flex items-center gap-1">
                  {t("gitRepo.diff.panel.nextFile")} <Kbd>]</Kbd>
                </span>
              }
            >
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("gitRepo.diff.panel.nextFile")}
                disabled={fileIndex >= siblings.length - 1}
                onClick={() => goFile(1)}
              >
                <ChevronRight className="size-4" />
              </Button>
            </Hint>
          </>
        )}
        {isWorkingCopy && !target.unchanged && (
          <>
            <Separator orientation="vertical" className="mx-1 h-4" />
            {target.staged ? (
              <Hint label={t("gitRepo.diff.panel.unstageFile")}>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={t("gitRepo.diff.panel.unstageFile")}
                  onClick={() =>
                    void runStage(
                      () => unstageFile(path, target.path),
                      t("gitRepo.diff.action.unstage")
                    )
                  }
                >
                  <Minus className="size-3" /> {!compact && t("gitRepo.diff.panel.unstageFile")}
                </Button>
              </Hint>
            ) : (
              <Hint label={t("gitRepo.diff.panel.stageFile")}>
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={t("gitRepo.diff.panel.stageFile")}
                  onClick={() =>
                    void runStage(
                      () => stageFile(path, target.path),
                      t("gitRepo.diff.action.stage")
                    )
                  }
                >
                  <Plus className="size-3" /> {!compact && t("gitRepo.diff.panel.stageFile")}
                </Button>
              </Hint>
            )}
          </>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1">
        {findBar}
        {selectAllOverlay}
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : loadError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
              <p className="text-destructive max-w-md text-center text-sm [overflow-wrap:anywhere]">
                {t("gitRepo.diff.panel.loadError", { message: loadError })}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setReloadToken((v) => v + 1)}>
                {t("gitRepo.diff.panel.retry")}
              </Button>
            </div>
          ) : emptyFile ? (
            <PaneEmpty
              icon={<FileText />}
              title={t("gitRepo.diff.panel.emptyFileTitle")}
              hint={t("gitRepo.diff.panel.emptyFileHint")}
            />
          ) : whitespaceOnly ? (
            <PaneEmpty
              icon={<Space />}
              title={t("gitRepo.diff.panel.whitespaceTitle")}
              hint={
                isWorkingCopy && target.staged
                  ? t("gitRepo.diff.panel.whitespaceStagedHint")
                  : t("gitRepo.diff.panel.whitespaceHint")
              }
            />
          ) : diff ? (
            <DiffViewer
              diff={diff}
              scrollRef={scrollRef}
              search={highlight}
              onLineContextMenu={(e, info) => {
                e.preventDefault();
                setLineMenu({
                  x: e.clientX,
                  y: e.clientY,
                  info,
                  selection:
                    diffSelectionText(scrollRef.current) ?? window.getSelection()?.toString() ?? "",
                  ranges: captureSelectionRanges(),
                });
              }}
              hunkActions={
                isWorkingCopy && !fullFileDiff && !target.unchanged && !ignoreWhitespace
                  ? (hunkIndex) => (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1.5 text-[10px]"
                        onClick={() =>
                          void runStage(
                            () =>
                              target.staged
                                ? unstageHunk(path, target.path, hunkIndex)
                                : stageHunk(path, target.path, hunkIndex),
                            t("gitRepo.diff.action.hunk")
                          )
                        }
                      >
                        {target.staged ? (
                          <>
                            <Minus className="size-3" /> {t("gitRepo.diff.panel.unstageHunk")}
                          </>
                        ) : (
                          <>
                            <Plus className="size-3" /> {t("gitRepo.diff.panel.stageHunk")}
                          </>
                        )}
                      </Button>
                    )
                  : undefined
              }
            />
          ) : (
            <PaneEmpty
              icon={<FileText />}
              title={t("gitRepo.diff.panel.noDiffTitle")}
              hint={t("gitRepo.diff.panel.noDiffHint")}
            />
          )}
          {diff && !loading && !whitespaceOnly && !emptyFile && (
            <DiffMinimap diff={diff} view={diffView} scrollRef={scrollRef} />
          )}
        </div>
        {lineMenu && (
          <DropdownMenu open onOpenChange={(open) => !open && setLineMenu(null)}>
            <DropdownMenuTrigger asChild>
              <span style={{ position: "fixed", left: lineMenu.x, top: lineMenu.y }} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="bottom"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              {isWorkingCopy && !ignoreWhitespace && lineMenu.info.line.kind !== "context" && (
                <>
                  {target.staged ? (
                    <DropdownMenuItem
                      onClick={() =>
                        void runStage(
                          () =>
                            unstageLine(
                              path,
                              target.path,
                              lineMenu.info.line.kind,
                              (lineMenu.info.line.kind === "addition"
                                ? lineMenu.info.line.newLineNo
                                : lineMenu.info.line.oldLineNo) ?? 0
                            ),
                          t("gitRepo.diff.action.unstageLine")
                        )
                      }
                    >
                      <Minus /> {t("gitRepo.diff.panel.unstageLine")}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={() =>
                        void runStage(
                          () =>
                            stageLine(
                              path,
                              target.path,
                              lineMenu.info.line.kind,
                              (lineMenu.info.line.kind === "addition"
                                ? lineMenu.info.line.newLineNo
                                : lineMenu.info.line.oldLineNo) ?? 0
                            ),
                          t("gitRepo.diff.action.stageLine")
                        )
                      }
                    >
                      <Plus /> {t("gitRepo.diff.panel.stageLine")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      const info = lineMenu.info;
                      void confirmDialog({
                        title: t("gitRepo.diff.panel.discardLineTitle"),
                        description: t("gitRepo.diff.panel.discardLineHint"),
                        confirmLabel: t("gitRepo.diff.panel.discardLineConfirm"),
                        destructive: true,
                      }).then((ok) => {
                        if (ok) {
                          void runStage(
                            () =>
                              discardLine(
                                path,
                                target.path,
                                info.line.kind,
                                (info.line.kind === "addition"
                                  ? info.line.newLineNo
                                  : info.line.oldLineNo) ?? 0
                              ),
                            t("gitRepo.diff.action.discardLine")
                          );
                        }
                      });
                    }}
                  >
                    <Trash2 /> {t("gitRepo.diff.panel.discardLine")}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              {lineMenu.selection && (
                <DropdownMenuItem
                  onClick={() => {
                    void navigator.clipboard.writeText(lineMenu.selection);
                    toast.success(t("gitRepo.diff.panel.copied"));
                  }}
                >
                  <Copy /> {t("gitRepo.diff.panel.copy")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => {
                  void navigator.clipboard.writeText(lineMenu.info.line.content);
                  toast.success(t("gitRepo.diff.panel.lineCopied"));
                }}
              >
                <Copy /> {t("gitRepo.diff.panel.copyLine")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => selectSide(lineMenu.info.side ?? "new")}>
                <TextSelect /> {t("gitRepo.diff.panel.selectAll")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </section>
  );
}
