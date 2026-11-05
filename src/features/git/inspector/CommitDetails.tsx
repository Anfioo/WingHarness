import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  Cloud,
  Copy,
  ExternalLink,
  File as FileIcon,
  FileText,
  FolderOpen,
  History,
  Monitor,
  Pencil,
  Tag as TagIcon,
  UserRoundSearch,
} from "lucide-react";
import type { AllFilesEntry, CommitFileInfo, CommitInfo } from "@/lib/git-core";
import {
  allFiles,
  filterFiles,
  foldersWithChanges,
  joinCommitMessage,
  splitCommitMessage,
} from "@/lib/git-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Hint } from "@/features/git/diff/diff-ui";
import { stepOpenDiffChange } from "@/features/git/diff/change-nav";
import { useGraph } from "@/features/git/graph/store";
import { useRepo } from "@/features/git/repository-store";
import { useUndo } from "@/features/git/history/undoStore";
import { focusRequests, useUi } from "@/features/git/ui-store";
import { basename, formatDate, isMac, timeAgo } from "@/features/git/utils";
import { commitReword, openPath, revealPath, stashRestoreFiles, treeFiles } from "@/commands";
import { AuthorAvatar } from "./author-avatar";
import { ChangeMark, statusMeta } from "./change-mark";
import { DirName } from "./dir-name";
import { EmptyState } from "./empty-state";
import { FileFilterInput } from "./file-filter-input";
import {
  FileTree,
  FileTreeFoldButton,
  type FileTreeFold,
  type FileTreeFoldState,
  INITIAL_FOLD,
  nextFold,
  treeIndent,
} from "./file-tree";

const DESCRIPTION_MIN = 72;
const DESCRIPTION_MAX = 360;

const diffPath = (diff: CommitFileInfo) => diff.path;
const entryPath = (entry: AllFilesEntry<CommitFileInfo>) => entry.path;

type ChangeKind = CommitFileInfo["status"];

const VIRTUAL_FILE_THRESHOLD = 200;
const FILE_ROW_HEIGHT = 34;

function ChangeFilter({
  diffs,
  value,
  onChange,
}: {
  diffs: CommitFileInfo[];
  value: ChangeKind | null;
  onChange: (value: ChangeKind | null) => void;
}) {
  const { t } = useAppTranslation();
  const counts = useMemo(() => {
    const map: Record<ChangeKind, number> = { modified: 0, new: 0, deleted: 0, renamed: 0 };
    for (const diff of diffs) map[diff.status] += 1;
    return map;
  }, [diffs]);
  const order: ChangeKind[] = ["modified", "new", "deleted", "renamed"];
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        className={cn(
          "hover:bg-muted flex h-5 items-center gap-1 rounded px-1 tabular-nums transition-colors",
          value === null ? "bg-muted text-foreground font-medium" : "text-muted-foreground"
        )}
      >
        {t("gitRepo.inspector.files.filterAll")}
      </button>
      {order.map((status) => {
        const meta = statusMeta[status];
        const count = counts[status];
        const active = value === status;
        return (
          <button
            key={status}
            type="button"
            aria-pressed={active}
            aria-label={`${count} ${t(meta.labelKey)}`}
            disabled={count === 0}
            onClick={() => onChange(active ? null : status)}
            className={cn(
              "hover:bg-muted flex h-5 items-center gap-1 rounded px-1 tabular-nums transition-colors disabled:pointer-events-none",
              active ? "bg-muted font-medium" : "text-muted-foreground",
              count === 0 && "opacity-60"
            )}
          >
            <ChangeMark tone={meta.tone}>{meta.mark}</ChangeMark>
            <span className={meta.className}>{count}</span>
          </button>
        );
      })}
    </span>
  );
}

function VirtualFileRows({
  diffs,
  scrollRef,
  renderRow,
}: {
  diffs: CommitFileInfo[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  renderRow: (diff: CommitFileInfo, depth?: number) => React.ReactNode;
}) {
  const [scrollMargin, setScrollMargin] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) setScrollMargin(el.offsetTop);
  }, []);
  const virtualizer = useVirtualizer({
    count: diffs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FILE_ROW_HEIGHT,
    getItemKey: (index) => diffs[index].path,
    overscan: 12,
    scrollMargin,
  });
  return (
    <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: item.size,
            transform: `translateY(${item.start - scrollMargin}px)`,
          }}
        >
          {renderRow(diffs[item.index])}
        </div>
      ))}
    </div>
  );
}

export function CommitDetails({
  commit,
  diffs,
  loading,
  error,
  onRetry,
}: {
  commit: CommitInfo;
  diffs: CommitFileInfo[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useAppTranslation();
  const select = useGraph((s) => s.select);
  const openCenterDiff = useUi((s) => s.openCenterDiff);
  const closeCenterDiff = useUi((s) => s.closeCenterDiff);
  const centerDiff = useUi((s) => s.centerDiff);
  const fileView = useUi((s) => s.fileView);
  const fileTree = fileView !== "list";
  const allMode = fileView === "all";
  const repoPath = useRepo((s) => s.repo?.path ?? "");
  const stash = useRepo((s) => s.stashes.find((entry) => entry.oid === commit.oid) ?? null);
  const refreshStatus = useRepo((s) => s.refreshStatus);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [fold, setFold] = useState<FileTreeFold>(INITIAL_FOLD);
  const [foldState, setFoldState] = useState<FileTreeFoldState | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const fileFilterOpen = useUi((s) => s.fileFilterOpen);
  const fileFilterFocusSeq = useUi((s) => s.fileFilterFocusSeq);
  useEffect(() => {
    if (!fileFilterOpen) setFileQuery("");
  }, [fileFilterOpen]);
  const [kindFilter, setKindFilter] = useState<ChangeKind | null>(null);
  const filtering = fileQuery.trim().length > 0 || kindFilter !== null;
  const shownDiffs = useMemo(() => {
    const byQuery = filterFiles(diffs, diffPath, fileQuery);
    return kindFilter ? byQuery.filter((d) => d.status === kindFilter) : byQuery;
  }, [diffs, fileQuery, kindFilter]);
  const [tree, setTree] = useState<string[] | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeSeq, setTreeSeq] = useState(0);
  useEffect(() => {
    if (!allMode || !repoPath) return;
    let cancelled = false;
    setTree(null);
    setTreeError(null);
    void treeFiles(repoPath, commit.oid)
      .then((paths) => {
        if (!cancelled) setTree(paths);
      })
      .catch((err) => {
        if (!cancelled) setTreeError(String((err as { message?: string }).message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, [allMode, repoPath, commit.oid, treeSeq]);
  const allEntries = useMemo(
    () => (allMode && tree ? allFiles(tree, diffs, diffPath) : []),
    [allMode, tree, diffs]
  );
  const changedFolders = useMemo(() => foldersWithChanges(allEntries), [allEntries]);
  const shownEntries = useMemo(() => {
    const byQuery = filterFiles(allEntries, entryPath, fileQuery);
    return kindFilter ? byQuery.filter((e) => e.change?.status === kindFilter) : byQuery;
  }, [allEntries, fileQuery, kindFilter]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const pickAnchor = useRef<string | null>(null);
  useEffect(() => {
    setFileQuery("");
    setKindFilter(null);
    setPicked(new Set());
    pickAnchor.current = null;
  }, [commit.oid]);
  useEffect(() => {
    if (picked.size === 0) return;
    const present = new Set(diffs.map((d) => d.path));
    if ([...picked].every((p) => present.has(p))) return;
    setPicked(new Set([...picked].filter((p) => present.has(p))));
  }, [diffs, picked]);
  const togglePick = (file: string, range: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && pickAnchor.current) {
        const order = shownDiffs.map((d) => d.path);
        const from = order.indexOf(pickAnchor.current);
        const to = order.indexOf(file);
        if (from >= 0 && to >= 0) {
          const [a, b] = from < to ? [from, to] : [to, from];
          for (const p of order.slice(a, b + 1)) next.add(p);
          return next;
        }
      }
      if (next.has(file)) next.delete(file);
      else next.add(file);
      pickAnchor.current = file;
      return next;
    });
  };
  const longBody = commit.body.split("\n").length > 8 || commit.body.length > 600;
  const unpushed = useRepo((s) => s.unpushed);
  const refresh = useRepo((s) => s.refresh);
  const reloadGraph = useGraph((s) => s.reload);
  const pushed = !unpushed.includes(commit.oid);
  const canReword = !stash;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const draftSummaryRef = useRef<HTMLTextAreaElement>(null);
  const draftBodyRef = useRef<HTMLTextAreaElement>(null);
  const [descHeight, setDescHeight] = useState<number | null>(null);
  const [descResizing, setDescResizing] = useState(false);
  const startDescResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = draftBodyRef.current;
    if (!el) return;
    const startY = event.clientY;
    const startHeight = el.getBoundingClientRect().height;
    setDescResizing(true);
    const onMove = (e: MouseEvent) => {
      setDescHeight(
        Math.round(
          Math.min(DESCRIPTION_MAX, Math.max(DESCRIPTION_MIN, startHeight + (e.clientY - startY)))
        )
      );
    };
    const onUp = () => {
      setDescResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const originalMessage = joinCommitMessage(commit.summary, commit.body);
  const startEditing = useCallback(() => {
    if (!canReword) return;
    setDraft(joinCommitMessage(commit.summary, commit.body));
    setEditing(true);
  }, [canReword, commit.summary, commit.body]);
  useEffect(() => {
    setEditing(false);
    setSaving(false);
    setDescHeight(null);
  }, [commit.oid]);
  useEffect(() => {
    if (editing) draftSummaryRef.current?.focus();
  }, [editing]);
  const draftParts = splitCommitMessage(draft);
  useLayoutEffect(() => {
    const el = draftSummaryRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draftParts.summary]);
  const editMessageRequest = useUi((s) => s.editMessageRequest);
  useEffect(() => {
    if (!editMessageRequest || editMessageRequest.seq === focusRequests.editMessageConsumed) return;
    if (editMessageRequest.oid !== commit.oid) return;
    focusRequests.editMessageConsumed = editMessageRequest.seq;
    startEditing();
  }, [editMessageRequest, commit.oid, startEditing]);
  const canSave =
    draftParts.summary.trim().length > 0 && draft.trim() !== originalMessage.trim() && !saving;
  const cancelEditing = () => {
    setEditing(false);
    setDraft("");
  };
  const saveMessage = async () => {
    if (!canSave) return;
    if (pushed) {
      const ok = await confirmDialog({
        title: t("gitRepo.inspector.commitDetails.rewriteTitle"),
        description: t("gitRepo.inspector.commitDetails.rewriteDescription"),
        confirmLabel: t("gitRepo.inspector.commitDetails.rewriteConfirm"),
        destructive: true,
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const newOid = await useUndo.getState().tracked({
        path: repoPath,
        kind: "reword",
        label: t("gitRepo.inspector.commitDetails.rewriteLabel"),
        action: () => commitReword(repoPath, commit.oid, draft),
      });
      setEditing(false);
      toast.success(t("gitRepo.inspector.commitDetails.saved"));
      await refresh();
      await reloadGraph(repoPath);
      select(newOid);
    } catch (err) {
      toast.error(
        t("gitRepo.inspector.commitDetails.saveFailed", {
          error: (err as { message?: string }).message ?? err,
        })
      );
    } finally {
      setSaving(false);
    }
  };
  const onEditorKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelEditing();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void saveMessage();
    }
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  const activeIndex = shownDiffs.findIndex(
    (d) => centerDiff?.path === d.path && centerDiff.oid === (d.sourceOid ?? commit.oid)
  );
  const openFileAt = useCallback(
    (index: number) => {
      const d = shownDiffs[index];
      if (!d) return;
      openCenterDiff({
        path: d.path,
        oid: d.sourceOid ?? commit.oid,
        oldPath: d.oldPath,
        stash: !!stash,
      });
      requestAnimationFrame(() => {
        filesRef.current?.querySelector("[data-active-file]")?.scrollIntoView({ block: "nearest" });
      });
    },
    [shownDiffs, openCenterDiff, commit.oid, stash]
  );
  const inspectorFocusSeq = useUi((s) => s.inspectorFocusSeq);
  const wantFirstFile = useRef(false);
  useEffect(() => {
    if (inspectorFocusSeq === focusRequests.inspectorConsumed) return;
    focusRequests.inspectorConsumed = inspectorFocusSeq;
    filesRef.current?.focus();
    if (activeIndex >= 0) return;
    if (!loading && shownDiffs.length > 0) openFileAt(0);
    else wantFirstFile.current = true;
  }, [inspectorFocusSeq, activeIndex, loading, shownDiffs, openFileAt]);
  useEffect(() => {
    if (!wantFirstFile.current || loading || shownDiffs.length === 0) return;
    wantFirstFile.current = false;
    openFileAt(0);
  }, [loading, shownDiffs, openFileAt]);
  useEffect(() => {
    wantFirstFile.current = false;
  }, [commit.oid]);
  const onFilesKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (shownDiffs.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next =
        activeIndex < 0
          ? step === 1
            ? 0
            : shownDiffs.length - 1
          : Math.min(shownDiffs.length - 1, Math.max(0, activeIndex + step));
      openFileAt(next);
      return;
    }
    if (e.key === "ArrowRight" || e.key === "Enter") {
      if (shownDiffs.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "ArrowRight" && activeIndex >= 0 && stepOpenDiffChange(1) !== "none") return;
      openFileAt(activeIndex < 0 ? 0 : activeIndex);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      closeCenterDiff();
      useUi.getState().focusGraph();
    }
  };
  const [fileMenu, setFileMenu] = useState<{
    x: number;
    y: number;
    path: string;
    oid: string;
    deleted: boolean;
    changed: boolean;
  } | null>(null);
  const restoreFromStash = async (files: string[]) => {
    if (!stash || files.length === 0) return;
    try {
      await stashRestoreFiles(repoPath, stash.index, files);
      await refreshStatus();
      toast.success(
        files.length === 1
          ? t("gitRepo.inspector.stash.appliedOne", { name: basename(files[0]) })
          : t("gitRepo.inspector.stash.appliedMany", { count: files.length }),
        { description: t("gitRepo.inspector.stash.unchanged") }
      );
      setPicked(new Set());
    } catch (err) {
      toast.error(
        t("gitRepo.inspector.stash.applyFailed", {
          error: (err as { message?: string }).message ?? err,
        })
      );
    }
  };
  const renderDiffRow = (diff: CommitFileInfo, depth?: number) => {
    const diffOid = diff.sourceOid ?? commit.oid;
    const active = centerDiff?.path === diff.path && centerDiff.oid === diffOid;
    const meta = statusMeta[diff.status];
    return (
      <Hint key={diff.path} label={diff.path} side="left">
        <div
          data-active-file={active || undefined}
          className={cn(
            "group flex w-full items-center gap-2 rounded-md py-1.5 pr-3 pl-2 text-left text-xs transition-colors",
            active ? "bg-primary/10 text-foreground" : "hover:bg-muted",
            stash && picked.has(diff.path) && !active && "bg-primary/5"
          )}
          style={fileTree && depth !== undefined ? { paddingLeft: treeIndent(depth) } : undefined}
          onContextMenu={(e) => {
            e.preventDefault();
            setFileMenu({
              x: e.clientX,
              y: e.clientY,
              path: diff.path,
              oid: diffOid,
              deleted: diff.status === "deleted",
              changed: true,
            });
          }}
        >
          {stash && (
            <input
              type="checkbox"
              checked={picked.has(diff.path)}
              aria-label={t("gitRepo.inspector.stash.selectAria", { path: diff.path })}
              onChange={() => togglePick(diff.path, false)}
              onClick={(e) => {
                e.stopPropagation();
                if (e.shiftKey) {
                  e.preventDefault();
                  togglePick(diff.path, true);
                }
              }}
              className="accent-primary size-3.5 shrink-0 cursor-pointer"
            />
          )}
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={(e) => {
              if (stash && (e.shiftKey || e.metaKey || e.ctrlKey)) {
                togglePick(diff.path, e.shiftKey);
                return;
              }
              if (active) closeCenterDiff();
              else
                openCenterDiff({
                  path: diff.path,
                  oid: diffOid,
                  oldPath: diff.oldPath,
                  stash: !!stash,
                });
            }}
          >
            <ChangeMark tone={meta?.tone ?? "neutral"} title={meta ? t(meta.labelKey) : undefined}>
              {meta?.mark ?? "?"}
            </ChangeMark>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span className="max-w-full shrink-0 truncate">{basename(diff.path)}</span>
              {!fileTree && <DirName path={diff.path} className="text-[11px]" />}
            </span>
            {diff.additions > 0 && (
              <span className="text-success shrink-0 font-mono text-[11px]">+{diff.additions}</span>
            )}
            {diff.deletions > 0 && (
              <span className="text-destructive shrink-0 font-mono text-[11px]">
                −{diff.deletions}
              </span>
            )}
          </button>
          {stash && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("gitRepo.inspector.stash.applyFileAria", { path: diff.path })}
              className="-my-1 -mr-1 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              onClick={() => void restoreFromStash([diff.path])}
            >
              <ArchiveRestore className="text-primary size-3.5" />
            </Button>
          )}
        </div>
      </Hint>
    );
  };
  const renderPlainRow = (file: string, depth?: number) => {
    const active =
      centerDiff?.path === file && centerDiff.oid === commit.oid && !!centerDiff.unchanged;
    return (
      <Hint key={`plain-${file}`} label={file} side="left">
        <div
          data-active-file={active || undefined}
          data-unchanged-file
          className={cn(
            "group flex w-full items-center gap-2 rounded-md py-1.5 pr-3 pl-2 text-left text-xs transition-colors",
            active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted"
          )}
          style={fileTree && depth !== undefined ? { paddingLeft: treeIndent(depth) } : undefined}
          onContextMenu={(e) => {
            e.preventDefault();
            setFileMenu({
              x: e.clientX,
              y: e.clientY,
              path: file,
              oid: commit.oid,
              deleted: false,
              changed: false,
            });
          }}
        >
          {stash && <span className="size-4 shrink-0" />}
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => {
              if (active) closeCenterDiff();
              else openCenterDiff({ path: file, oid: commit.oid, unchanged: true });
            }}
          >
            <span className="flex w-4 shrink-0 justify-center">
              <FileIcon className="text-faint size-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">{basename(file)}</span>
          </button>
        </div>
      </Hint>
    );
  };
  const renderEntry = (entry: AllFilesEntry<CommitFileInfo>, depth?: number) =>
    entry.change ? renderDiffRow(entry.change, depth) : renderPlainRow(entry.path, depth);
  return (
    <div ref={scrollRef} className="flex h-full flex-col overflow-y-auto">
      <div className="border-border border-b px-4 pt-3 pb-4">
        {editing ? (
          <div
            data-message-editor
            className={cn(
              "border-border bg-card rounded-md border shadow-sm transition-colors",
              "focus-within:border-primary/60 focus-within:ring-primary/60 focus-within:ring-2"
            )}
            onKeyDown={onEditorKeyDown}
          >
            <Textarea
              ref={draftSummaryRef}
              value={draftParts.summary}
              onChange={(e) => setDraft(joinCommitMessage(e.target.value, draftParts.body))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  draftBodyRef.current?.focus();
                }
              }}
              placeholder={t("gitRepo.inspector.commitDetails.summaryPlaceholder")}
              aria-label={t("gitRepo.inspector.commitDetails.summaryAria")}
              rows={1}
              autoCapitalize="off"
              spellCheck
              className="text-foreground placeholder:text-faint min-h-9 resize-none overflow-hidden rounded-none border-0 bg-transparent px-3 py-2 text-sm leading-snug font-medium shadow-none placeholder:font-normal focus-visible:border-0 focus-visible:ring-0"
            />
            <div className="bg-border mx-3 h-px" />
            <Textarea
              ref={draftBodyRef}
              value={draftParts.body}
              onChange={(e) => setDraft(joinCommitMessage(draftParts.summary, e.target.value))}
              aria-label={t("gitRepo.inspector.commitDetails.bodyAria")}
              placeholder={t("gitRepo.inspector.commitDetails.bodyPlaceholder")}
              rows={Math.min(12, Math.max(3, draftParts.body.split("\n").length + 1))}
              style={descHeight === null ? undefined : { height: descHeight }}
              className="text-foreground min-h-[72px] resize-none rounded-none border-0 bg-transparent px-3 py-2 text-xs leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0"
            />
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("gitRepo.inspector.commitDetails.resizeDescription")}
              title={t("gitRepo.inspector.commitDetails.resizeHint")}
              onMouseDown={startDescResize}
              onDoubleClick={() => setDescHeight(null)}
              className="group/handle flex h-3 cursor-row-resize items-center justify-center"
            >
              <span
                className={cn(
                  "h-0.5 w-10 rounded-full transition-colors",
                  descResizing ? "bg-primary" : "bg-border group-hover/handle:bg-primary/60"
                )}
              />
            </div>
            <div className="border-border flex items-center justify-between gap-2 border-t px-2 py-1.5">
              <span className="text-faint text-[11px]">
                {t("gitRepo.inspector.commitDetails.saveHint", {
                  mod: isMac ? "⌘⏎" : "Ctrl+⏎",
                })}
              </span>
              <span className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={saving}>
                  {t("gitRepo.inspector.commitDetails.cancel")}
                </Button>
                <Button size="sm" onClick={() => void saveMessage()} disabled={!canSave}>
                  {saving
                    ? t("gitRepo.inspector.commitDetails.saving")
                    : t("gitRepo.inspector.commitDetails.save")}
                </Button>
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <h2
                className={cn(
                  "text-foreground min-w-0 flex-1 text-sm leading-snug font-semibold [overflow-wrap:anywhere]",
                  canReword && "cursor-text"
                )}
                title={canReword ? t("gitRepo.inspector.commitDetails.editTitle") : undefined}
                onDoubleClick={startEditing}
              >
                {commit.summary}
              </h2>
              {!stash && (
                <Hint
                  label={
                    pushed
                      ? t("gitRepo.inspector.commitDetails.editHintPushed")
                      : t("gitRepo.inspector.commitDetails.editHint")
                  }
                >
                  <span className="-mt-1 inline-flex shrink-0">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={t("gitRepo.inspector.commitDetails.editAria")}
                      disabled={!canReword}
                      onClick={startEditing}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                  </span>
                </Hint>
              )}
            </div>
            {commit.body && !editing && (
              <div className="mt-2">
                <pre
                  className={cn(
                    "text-muted-foreground font-sans text-xs leading-relaxed break-words whitespace-pre-wrap",
                    longBody && !bodyExpanded && "line-clamp-[8]",
                    canReword && "cursor-text"
                  )}
                  onDoubleClick={startEditing}
                >
                  {commit.body}
                </pre>
                {longBody && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:bg-muted hover:text-foreground mt-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors"
                    onClick={() => setBodyExpanded((v) => !v)}
                  >
                    {bodyExpanded ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                    {bodyExpanded
                      ? t("gitRepo.inspector.commitDetails.showLess")
                      : t("gitRepo.inspector.commitDetails.showFull")}
                  </button>
                )}
              </div>
            )}
            <div className="border-border bg-muted/50 mt-3 rounded-md border p-2.5">
              <div className="flex items-center gap-2.5">
                <AuthorAvatar name={commit.author.name} email={commit.author.email} size={28} />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="text-foreground truncate text-xs font-medium">
                    {commit.author.name}
                  </span>
                  <span
                    className="text-faint truncate text-[11px]"
                    title={formatDate(commit.author.time)}
                  >
                    {timeAgo(commit.author.time)} · {formatDate(commit.author.time)}
                    {commit.committer.email !== commit.author.email &&
                      ` · ${t("gitRepo.inspector.commitDetails.committedBy", { name: commit.committer.name })}`}
                  </span>
                </span>
                <Hint label={t("gitRepo.inspector.commitDetails.copyHashHint")}>
                  <button
                    className="border-border bg-card text-muted-foreground hover:text-foreground flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[11px]"
                    aria-label={t("gitRepo.inspector.commitDetails.commitHashAria")}
                    onClick={() => {
                      void navigator.clipboard.writeText(commit.oid);
                      toast.success(t("gitRepo.inspector.commitDetails.hashCopied"));
                    }}
                  >
                    {commit.shortOid} <Copy className="size-2.5" />
                  </button>
                </Hint>
              </div>
              {(commit.parents.length > 0 || commit.refs.length > 0) && (
                <div className="border-border mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2">
                  {commit.parents.length > 0 && (
                    <span className="text-faint text-[11px]">
                      {commit.parents.length > 1
                        ? t("gitRepo.inspector.commitDetails.parents")
                        : t("gitRepo.inspector.commitDetails.parent")}
                    </span>
                  )}
                  {commit.parents.map((parent) => (
                    <button
                      key={parent}
                      className="border-border bg-card text-muted-foreground hover:text-foreground flex h-5 items-center rounded border px-1.5 font-mono text-[10px]"
                      onClick={() => select(parent)}
                      title={t("gitRepo.inspector.commitDetails.showCommit")}
                    >
                      {parent.slice(0, 7)}
                    </button>
                  ))}
                  {commit.refs.length > 0 && commit.parents.length > 0 && (
                    <span className="bg-border mx-0.5 h-3 w-px" />
                  )}
                  {commit.refs.map((ref) => (
                    <Badge
                      key={ref.name}
                      variant={
                        ref.kind === "tag"
                          ? "default"
                          : ref.kind === "remoteBranch"
                            ? "secondary"
                            : "outline"
                      }
                      className="max-w-48"
                    >
                      {ref.kind === "tag" && <TagIcon className="size-2.5 shrink-0" />}
                      {ref.kind === "remoteBranch" && <Cloud className="size-2.5 shrink-0" />}
                      {(ref.kind === "localBranch" || ref.kind === "head") && (
                        <Monitor className="size-2.5 shrink-0" />
                      )}
                      <span className="truncate">{ref.shorthand}</span>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
        <div
          ref={filesRef}
          tabIndex={0}
          aria-label={t("gitRepo.inspector.files.aria")}
          onKeyDown={onFilesKeyDown}
          className="focus-visible:ring-primary/40 rounded-md p-2 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
        >
          <p className="border-border text-muted-foreground mb-1 flex items-center justify-between gap-2 border-b px-2 pt-1 pb-2 text-xs font-semibold tracking-wide uppercase">
            <span className="shrink-0">
              {t("gitRepo.inspector.files.title")}
              {!loading && !error && (
                <span className="text-faint ml-1">
                  {allMode && tree ? (
                    filtering ? (
                      <>
                        {shownEntries.length}{" "}
                        <span className="font-normal tracking-normal normal-case">
                          {t("gitRepo.inspector.files.ofCount", { total: allEntries.length })}
                        </span>
                      </>
                    ) : (
                      <>
                        {allEntries.length}{" "}
                        <span className="font-normal tracking-normal normal-case">
                          {t("gitRepo.inspector.files.changedCount", { count: diffs.length })}
                        </span>
                      </>
                    )
                  ) : filtering ? (
                    <>
                      {shownDiffs.length}{" "}
                      <span className="font-normal tracking-normal normal-case">
                        {t("gitRepo.inspector.files.ofCount", { total: diffs.length })}
                      </span>
                    </>
                  ) : (
                    diffs.length
                  )}
                </span>
              )}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-[11px] font-normal tracking-normal normal-case">
              {loading ? (
                t("gitRepo.inspector.files.loading")
              ) : error ? (
                ""
              ) : (
                <ChangeFilter diffs={diffs} value={kindFilter} onChange={setKindFilter} />
              )}
              {fileTree && !loading && !error && (
                <FileTreeFoldButton
                  state={foldState}
                  onFold={(mode) => setFold((f) => nextFold(f, mode))}
                />
              )}
            </span>
          </p>
          {stash && !loading && !error && (
            <div className="border-border bg-muted/50 mb-1.5 flex min-h-7 items-center gap-2 rounded-md border px-2 py-1 text-[11px]">
              {picked.size === 0 ? (
                <>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">
                    {t("gitRepo.inspector.stash.hint")}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => setPicked(new Set(diffs.map((d) => d.path)))}
                  >
                    {t("gitRepo.inspector.stash.selectAll")}
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {t("gitRepo.inspector.stash.selectedCount", {
                      count: picked.size,
                      total: diffs.length,
                    })}
                  </span>
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => setPicked(new Set())}
                  >
                    {t("gitRepo.inspector.stash.clear")}
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 shrink-0 gap-1 px-2 text-[11px]"
                    onClick={() => void restoreFromStash([...picked])}
                  >
                    <ArchiveRestore className="size-3" />
                    {t("gitRepo.inspector.stash.applyCount", { count: picked.size })}
                  </Button>
                </>
              )}
            </div>
          )}
          {fileFilterOpen && (
            <div className="mb-1 px-0.5">
              <FileFilterInput
                value={fileQuery}
                onChange={setFileQuery}
                onClose={() => useUi.getState().setFileFilterOpen(false)}
                focusSeq={fileFilterFocusSeq}
              />
            </div>
          )}
          {loading ? (
            <div className="space-y-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-muted h-7 animate-pulse rounded-md" />
              ))}
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className="text-destructive min-w-0 flex-1 text-xs [overflow-wrap:anywhere]">
                {t("gitRepo.inspector.files.loadFailed", { error })}
              </span>
              <Button variant="ghost" size="sm" className="shrink-0" onClick={onRetry}>
                {t("gitRepo.inspector.files.retry")}
              </Button>
            </div>
          ) : allMode ? (
            treeError ? (
              <div className="flex items-center gap-2 px-2 py-1.5">
                <span className="text-destructive min-w-0 flex-1 text-xs [overflow-wrap:anywhere]">
                  {t("gitRepo.inspector.files.listFailed", { error: treeError })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setTreeSeq((n) => n + 1)}
                >
                  {t("gitRepo.inspector.files.retry")}
                </Button>
              </div>
            ) : tree === null ? (
              <div className="space-y-1">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="bg-muted h-7 animate-pulse rounded-md" />
                ))}
              </div>
            ) : shownEntries.length === 0 ? (
              filtering ? (
                <p className="text-faint px-2 py-1.5 text-xs">
                  {t("gitRepo.inspector.files.noMatch")}
                </p>
              ) : (
                <EmptyState
                  icon={<FileText className="size-4" />}
                  title={t("gitRepo.inspector.files.emptyTitle")}
                  description={t("gitRepo.inspector.files.emptyDescription")}
                />
              )
            ) : (
              <FileTree
                items={shownEntries}
                pathOf={entryPath}
                renderFile={renderEntry}
                fold={fold}
                onFoldState={setFoldState}
                defaultCollapsed={(folder) => !changedFolders.has(folder)}
              />
            )
          ) : shownDiffs.length === 0 && filtering ? (
            <p className="text-faint px-2 py-1.5 text-xs">{t("gitRepo.inspector.files.noMatch")}</p>
          ) : fileTree ? (
            <FileTree
              items={shownDiffs}
              pathOf={diffPath}
              renderFile={renderDiffRow}
              fold={fold}
              onFoldState={setFoldState}
            />
          ) : shownDiffs.length > VIRTUAL_FILE_THRESHOLD ? (
            <VirtualFileRows diffs={shownDiffs} scrollRef={scrollRef} renderRow={renderDiffRow} />
          ) : (
            shownDiffs.map((diff) => renderDiffRow(diff))
          )}
        </div>
      </div>
      {fileMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setFileMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: fileMenu.x, top: fileMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="max-w-64 truncate font-mono">
              {fileMenu.path}
            </DropdownMenuLabel>
            {stash && fileMenu.changed && (
              <>
                <DropdownMenuItem onClick={() => void restoreFromStash([fileMenu.path])}>
                  <ArchiveRestore className="text-muted-foreground size-4" />
                  {t("gitRepo.inspector.fileMenu.applyFile")}
                </DropdownMenuItem>
                {picked.size > 1 && picked.has(fileMenu.path) && (
                  <DropdownMenuItem onClick={() => void restoreFromStash([...picked])}>
                    <ArchiveRestore className="text-muted-foreground size-4" />
                    {t("gitRepo.inspector.stash.applySelected", { count: picked.size })}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem
              disabled={fileMenu.deleted}
              onClick={() => useUi.getState().openEditor(fileMenu.path)}
            >
              <Pencil className="text-muted-foreground size-4" />
              {t("gitRepo.inspector.fileMenu.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => useUi.getState().openFileHistory(fileMenu.path)}>
              <History className="text-muted-foreground size-4" />
              {t("gitRepo.inspector.fileMenu.history")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={fileMenu.deleted}
              onClick={() => useUi.getState().openBlame(fileMenu.path, fileMenu.oid)}
            >
              <UserRoundSearch className="text-muted-foreground size-4" />
              {t("gitRepo.inspector.fileMenu.blame")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={fileMenu.deleted}
              onClick={() =>
                void openPath(`${repoPath}/${fileMenu.path}`).catch((err) =>
                  toast.error(
                    t("gitRepo.inspector.fileMenu.openFailed", {
                      error: (err as { message?: string }).message ?? err,
                    })
                  )
                )
              }
            >
              <ExternalLink className="text-muted-foreground size-4" />
              {t("gitRepo.inspector.fileMenu.openExternal")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={fileMenu.deleted}
              onClick={() =>
                void revealPath(`${repoPath}/${fileMenu.path}`).catch((err) =>
                  toast.error(
                    t("gitRepo.inspector.fileMenu.revealFailed", {
                      error: (err as { message?: string }).message ?? err,
                    })
                  )
                )
              }
            >
              <FolderOpen className="text-muted-foreground size-4" />
              {isMac
                ? t("gitRepo.inspector.fileMenu.revealMac")
                : t("gitRepo.inspector.fileMenu.reveal")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(fileMenu.path);
                toast.success(t("gitRepo.inspector.fileMenu.pathCopied"));
              }}
            >
              <Copy className="text-muted-foreground size-4" />
              {t("gitRepo.inspector.fileMenu.copyPath")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(`${repoPath}/${fileMenu.path}`);
                toast.success(t("gitRepo.inspector.fileMenu.absoluteCopied"));
              }}
            >
              <Copy className="text-muted-foreground size-4" />
              {t("gitRepo.inspector.fileMenu.copyAbsolute")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
