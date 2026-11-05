import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ComponentProps,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  Check,
  Copy,
  ExternalLink,
  File as FileIcon,
  FolderOpen,
  History,
  Minus,
  Pencil,
  Plus,
  Sparkles,
  SquareCheck,
  Trash2,
  Undo2,
  UserRoundSearch,
} from "lucide-react";
import type { TFunction } from "i18next";
import {
  allFiles,
  filterFiles,
  foldersWithChanges,
  hasCommittedHistory,
  joinCommitMessage,
  splitCommitMessage,
} from "@/lib/git-core";
import type { AllFilesEntry, CommitInfo, FileStatus, FileStatusKind } from "@/lib/git-core";
import { generateCommitMessage } from "@/lib/git-core/ai";
import {
  commitAmend,
  commitCreate,
  deleteFile,
  discardAll,
  discardFile,
  discardStagedAll,
  discardStagedFile,
  historyCommit,
  indexFiles,
  mergeAbort,
  mergeMessage,
  openPath,
  recentRepositories,
  revealPath,
  stageAll,
  stageFile,
  stagedPatch,
  unstageAll,
  unstageFile,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmDialog } from "@/components/confirm";
import { FileFilterInput } from "@/components/git/file-filter-input";
import { ChangeMark } from "@/components/git/change-mark";
import { DirName } from "@/components/git/dir-name";
import {
  FileTree,
  FileTreeFoldButton,
  INITIAL_FOLD,
  nextFold,
  treeIndent as sharedTreeIndent,
  type FileTreeFold,
  type FileTreeFoldState,
} from "@/components/git/file-tree";
import { basename, modKey } from "@/features/git/utils";
import { useRepo } from "@/features/git/repository-store";
import { aiConfigured, getAiProvider } from "@/features/git/ai";
import { useGitSettings } from "@/features/git/settings";
import { focusRequests, useUi } from "@/features/git/ui-store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { EmptyCard } from "./empty-card";
import { useCommitDraft } from "./draftStore";

function Hint({
  label,
  children,
  side = "bottom",
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className={className}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="border-border bg-muted text-muted-foreground rounded border px-1 font-mono text-[10px] leading-4">
      {children}
    </kbd>
  );
}

function Spinner({ className }: { className?: string }) {
  const { t } = useAppTranslation();
  return (
    <span
      role="status"
      aria-label={t("gitRepo.extras.loading")}
      className={cn(
        "inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent",
        className
      )}
    />
  );
}

function Checkbox({
  checked,
  onCheckedChange,
  className,
  onClick,
  ...props
}: {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
} & Omit<ComponentProps<"button">, "onChange">) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked ?? false}
      data-state={checked ? "checked" : "unchecked"}
      onClick={(event) => {
        onClick?.(event);
        onCheckedChange?.(!checked);
      }}
      className={cn(
        "border-input focus-visible:ring-ring/50 inline-flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors focus-visible:ring-2 focus-visible:outline-none",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "hover:border-primary/60 bg-transparent",
        className
      )}
      {...props}
    >
      {checked && <Check className="size-3" />}
    </button>
  );
}

function errorText(error: unknown): string {
  return (error as { message?: string }).message ?? String(error);
}

function statusBadge(kind: FileStatusKind | null, t: TFunction) {
  switch (kind) {
    case "new":
    case "untracked":
      return (
        <ChangeMark tone="success" title={t("gitRepo.commit.mark.added")}>
          A
        </ChangeMark>
      );
    case "modified":
      return (
        <ChangeMark tone="info" title={t("gitRepo.commit.mark.modified")}>
          M
        </ChangeMark>
      );
    case "deleted":
      return (
        <ChangeMark tone="danger" title={t("gitRepo.commit.mark.deleted")}>
          D
        </ChangeMark>
      );
    case "renamed":
      return (
        <ChangeMark tone="primary" title={t("gitRepo.commit.mark.renamed")}>
          R
        </ChangeMark>
      );
    case "conflicted":
      return (
        <ChangeMark tone="danger" title={t("gitRepo.commit.mark.conflicted")}>
          !
        </ChangeMark>
      );
    default:
      return null;
  }
}

const FileRow = memo(function FileRow({
  file,
  staged,
  selected,
  onClick,
  onPrimary,
  onDiscard,
  onContextMenu,
  indent,
  treeMode,
}: {
  file: FileStatus;
  staged: boolean;
  selected: boolean;
  onClick: (file: FileStatus, staged: boolean, event: ReactMouseEvent) => void;
  onPrimary: (file: FileStatus, staged: boolean) => void;
  onDiscard?: (file: FileStatus) => void;
  onContextMenu?: (event: ReactMouseEvent, file: FileStatus, staged: boolean) => void;
  indent?: number;
  treeMode?: boolean;
}) {
  const { t } = useAppTranslation();
  const kind = staged ? file.staged : file.unstaged;
  const conflicted = file.unstaged === "conflicted";
  const row = (
    <div
      data-selected-file-row={selected || undefined}
      title={treeMode ? file.path : undefined}
      className={cn(
        "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors",
        selected ? "bg-primary/10" : "hover:bg-muted"
      )}
      style={indent !== undefined ? { paddingLeft: indent } : undefined}
      onClick={(event) => onClick(file, staged, event)}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, file, staged) : undefined}
    >
      <Checkbox
        checked={staged}
        aria-label={
          staged
            ? t("gitRepo.commit.row.unstage", { path: file.path })
            : t("gitRepo.commit.row.stage", { path: file.path })
        }
        onCheckedChange={() => onPrimary(file, staged)}
        onClick={(event) => event.stopPropagation()}
      />
      {statusBadge(conflicted && !staged ? "conflicted" : kind, t)}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="text-foreground max-w-full shrink-0 truncate">{basename(file.path)}</span>
        {!treeMode && <DirName path={file.path} />}
      </span>
      {onDiscard && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.commit.row.discard", { path: file.path })}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onDiscard(file);
          }}
        >
          <Trash2 className="text-destructive size-3" />
        </Button>
      )}
    </div>
  );
  if (treeMode) return row;
  return (
    <Hint label={file.path} side="left" className="max-w-[34rem] font-mono">
      {row}
    </Hint>
  );
});

const fileStatusPath = (file: FileStatus) => file.path;
const entryPath = (entry: AllFilesEntry<FileStatus>) => entry.path;
export const commitShortcut = { current: null as (() => void) | null };
const COMMIT_BOX_MIN = 72;
const COMMIT_BOX_AUTO_MAX = 260;
const COMMIT_BOX_MAX = 600;
const FILE_ROW_HEIGHT = 32;

function VirtualFileList({
  files,
  scrollRef,
  rowHeight,
  renderRow,
}: {
  files: FileStatus[];
  scrollRef: RefObject<HTMLDivElement | null>;
  rowHeight: (file: FileStatus) => number;
  renderRow: (file: FileStatus) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // Re-measured after every render: the rows above move when a pane resizes,
  // and the equality guard keeps the update from looping.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) setScrollMargin((prev) => (prev === el.offsetTop ? prev : el.offsetTop));
  });
  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rowHeight(files[index]),
    getItemKey: (index) => files[index].path,
    overscan: 12,
    scrollMargin,
  });
  const sizeSignature = useMemo(
    () => files.map((file) => rowHeight(file)).join(","),
    [files, rowHeight]
  );
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, sizeSignature]);
  return (
    <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={item.key}
          className="absolute left-0 w-full"
          style={{
            top: 0,
            height: item.size,
            transform: `translateY(${item.start - scrollMargin}px)`,
          }}
        >
          {renderRow(files[item.index])}
        </div>
      ))}
    </div>
  );
}

export function WorkingCopyPanel() {
  const { t } = useAppTranslation();
  const repo = useRepo((s) => s.repo);
  const status = useRepo((s) => s.status);
  const conflicts = useRepo((s) => s.conflicts);
  const submodules = useRepo((s) => s.submodules);
  const refreshStatus = useRepo((s) => s.refreshStatus);
  const statusVersion = useRepo((s) => s.statusVersion);
  const selectedFile = useUi((s) => s.selectedFile);
  const selectFile = useUi((s) => s.selectFile);
  const openCenterDiff = useUi((s) => s.openCenterDiff);
  const openEditor = useUi((s) => s.openEditor);
  const openConflict = useUi((s) => s.openConflict);
  const centerDiff = useUi((s) => s.centerDiff);
  const fileView = useUi((s) => s.fileView);
  const fileFilterOpen = useUi((s) => s.fileFilterOpen);
  const fileFilterFocusSeq = useUi((s) => s.fileFilterFocusSeq);
  const inspectorFocusSeq = useUi((s) => s.inspectorFocusSeq);
  const editMessageRequest = useUi((s) => s.editMessageRequest);
  const commitBoxHeight = useUi((s) => s.commitBoxHeight);
  const fileTree = fileView !== "list";
  const allMode = fileView === "all";
  const path = repo?.path ?? "";
  const message = useCommitDraft((s) => (path ? (s.drafts[path] ?? "") : ""));
  const amend = useCommitDraft((s) => !!path && s.amendFor === path);
  const setMessage = (text: string) => {
    if (!path) return;
    useCommitDraft.getState().setDraft(path, text);
  };
  const { summary, body } = splitCommitMessage(message);
  const setSummary = (text: string) => setMessage(joinCommitMessage(text, body));
  const setBody = (text: string) => setMessage(joinCommitMessage(summary, text));
  const setAmend = (value: boolean) => {
    if (!path) return;
    useCommitDraft.getState().setAmend(path, value);
  };
  const summaryRef = useRef<HTMLInputElement>(null);
  const [unstagedFold, setUnstagedFold] = useState<FileTreeFold>(INITIAL_FOLD);
  const [unstagedFoldState, setUnstagedFoldState] = useState<FileTreeFoldState | null>(null);
  const [stagedFold, setStagedFold] = useState<FileTreeFold>(INITIAL_FOLD);
  const [stagedFoldState, setStagedFoldState] = useState<FileTreeFoldState | null>(null);
  const [allFold, setAllFold] = useState<FileTreeFold>(INITIAL_FOLD);
  const [allFoldState, setAllFoldState] = useState<FileTreeFoldState | null>(null);
  const [resizing, setResizing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [fileMenu, setFileMenu] = useState<{
    x: number;
    y: number;
    file: FileStatus;
    staged: boolean;
  } | null>(null);
  const [multi, setMulti] = useState<{ staged: boolean; paths: string[] } | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [indexPaths, setIndexPaths] = useState<string[] | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const messageRef = useRef<HTMLTextAreaElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const committingRef = useRef(false);
  const aiRunRef = useRef(0);

  const applyBoxHeight = (el: HTMLTextAreaElement, fixed: number | null) => {
    if (fixed !== null) {
      el.style.height = `${fixed}px`;
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.max(COMMIT_BOX_MIN, Math.min(el.scrollHeight, COMMIT_BOX_AUTO_MAX))}px`;
  };
  const boxHeightRef = useRef(commitBoxHeight);
  boxHeightRef.current = commitBoxHeight;
  const attachMessageBox = (el: HTMLTextAreaElement | null) => {
    messageRef.current = el;
    if (el) applyBoxHeight(el, boxHeightRef.current);
  };
  useEffect(() => {
    const el = messageRef.current;
    if (el) applyBoxHeight(el, commitBoxHeight);
  }, [body, commitBoxHeight]);

  const startResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const el = messageRef.current;
    if (!el) return;
    const startY = event.clientY;
    const startHeight = el.getBoundingClientRect().height;
    setResizing(true);
    const onMove = (move: MouseEvent) => {
      const next = Math.round(
        Math.min(COMMIT_BOX_MAX, Math.max(COMMIT_BOX_MIN, startHeight + (startY - move.clientY)))
      );
      useUi.getState().setCommitBoxHeight(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    if (!path || useCommitDraft.getState().drafts[path]) return;
    let cancelled = false;
    void mergeMessage(path)
      .then((mergeMsg) => {
        if (cancelled || !mergeMsg) return;
        if (useCommitDraft.getState().drafts[path]) return;
        useCommitDraft.getState().setDraft(path, mergeMsg);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path, status]);

  useEffect(() => {
    if (!fileFilterOpen) setFileQuery("");
  }, [fileFilterOpen]);

  const files = useMemo(() => status?.files ?? [], [status]);
  const conflictedPaths = useMemo(() => new Set(conflicts), [conflicts]);
  const filtering = fileQuery.trim().length > 0;
  const allStaged = useMemo(() => files.filter((file) => file.staged), [files]);
  const allUnstaged = useMemo(
    () => files.filter((file) => file.unstaged && !conflictedPaths.has(file.path)),
    [files, conflictedPaths]
  );
  const stagedFiles = useMemo(
    () => filterFiles(allStaged, fileStatusPath, fileQuery),
    [allStaged, fileQuery]
  );
  const unstagedFiles = useMemo(
    () => filterFiles(allUnstaged, fileStatusPath, fileQuery),
    [allUnstaged, fileQuery]
  );
  const statusReady = status !== null;

  useEffect(() => {
    setIndexPaths(null);
    setIndexError(null);
  }, [path]);

  useEffect(() => {
    if (!allMode || !path || !statusReady) return;
    let cancelled = false;
    indexFiles(path)
      .then((paths) => {
        if (!cancelled) setIndexPaths(paths);
      })
      .catch((error: unknown) => {
        if (!cancelled) setIndexError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [allMode, path, statusReady, statusVersion]);

  const changedFiles = useMemo(
    () => files.filter((file) => (file.staged || file.unstaged) && !conflictedPaths.has(file.path)),
    [files, conflictedPaths]
  );
  const allEntries = useMemo(
    () => (allMode && indexPaths ? allFiles(indexPaths, changedFiles, fileStatusPath) : []),
    [allMode, indexPaths, changedFiles]
  );
  const changedFolders = useMemo(() => foldersWithChanges(allEntries), [allEntries]);
  const shownEntries = useMemo(
    () => filterFiles(allEntries, entryPath, fileQuery),
    [allEntries, fileQuery]
  );

  useEffect(() => {
    setMulti(null);
    setFileQuery("");
  }, [path]);

  useEffect(() => {
    if (!multi || !status) return;
    const present = new Set(
      status.files
        .filter((file) =>
          multi.staged ? file.staged : file.unstaged && file.unstaged !== "conflicted"
        )
        .map((file) => file.path)
    );
    const kept = multi.paths.filter((p) => present.has(p));
    if (kept.length === multi.paths.length) return;
    setMulti(kept.length > 1 ? { staged: multi.staged, paths: kept } : null);
  }, [multi, status, statusVersion]);

  const editMessageSeqRef = useRef(0);
  useEffect(() => {
    if (!editMessageRequest || editMessageRequest.seq === editMessageSeqRef.current) return;
    editMessageSeqRef.current = editMessageRequest.seq;
    if (!path) return;
    const oid = editMessageRequest.oid;
    let cancelled = false;
    void historyCommit(path, oid)
      .then((info: CommitInfo) => {
        if (cancelled) return;
        useCommitDraft.getState().setDraft(path, joinCommitMessage(info.summary, info.body));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [editMessageRequest, path]);

  const showDiff = useCallback(
    (file: FileStatus, staged: boolean) => {
      selectFile({ path: file.path, staged });
      openCenterDiff({ path: file.path, staged });
    },
    [selectFile, openCenterDiff]
  );

  const isSubmodule = useCallback(
    (file: string) => submodules.some((s) => s.path === file),
    [submodules]
  );

  const discardOne = useCallback(
    async (file: string, staged = false) => {
      try {
        const clean = staged ? await discardStagedFile(path, file) : await discardFile(path, file);
        await refreshStatus();
        if (!clean) {
          toast.error(
            useRepo.getState().submodules.some((s) => s.path === file)
              ? t("gitRepo.commit.discard.submodule", { path: file })
              : t("gitRepo.commit.discard.leftoverFile", { path: file })
          );
        }
      } catch (error) {
        toast.error(t("gitRepo.commit.discard.failed", { message: errorText(error) }));
      }
    },
    [path, refreshStatus, t]
  );

  const discardEverything = useCallback(async () => {
    const before = allUnstaged.length;
    try {
      const remaining = await discardAll(path);
      await refreshStatus();
      if (remaining.length > 0) {
        const submoduleCount = remaining.filter(isSubmodule).length;
        const listed =
          remaining.slice(0, 3).join(", ") +
          (remaining.length > 3 ? ` +${remaining.length - 3} more` : "");
        if (submoduleCount > 0) {
          toast.error(
            t("gitRepo.commit.discard.leftoverSub", {
              count: remaining.length,
              submodules: submoduleCount,
              listed,
            })
          );
        } else {
          toast.error(t("gitRepo.commit.discard.leftover", { count: remaining.length, listed }));
        }
      } else if (before > 0) {
        toast.success(t("gitRepo.commit.toast.discarded", { count: before }));
      }
    } catch (error) {
      toast.error(t("gitRepo.commit.discard.allFailed", { message: errorText(error) }));
    }
  }, [allUnstaged.length, isSubmodule, path, refreshStatus, t]);

  const run = useCallback(
    async (op: () => Promise<unknown>, errorLabel: string) => {
      try {
        await op();
        await refreshStatus();
      } catch (error) {
        toast.error(`${errorLabel}: ${errorText(error)}`);
      }
    },
    [refreshStatus]
  );

  const stageMany = useCallback(
    (paths: string[], staged: boolean) =>
      run(
        () =>
          Promise.all(
            paths.map((file) => (staged ? unstageFile(path, file) : stageFile(path, file)))
          ),
        staged ? t("gitRepo.commit.ops.unstageFailed") : t("gitRepo.commit.ops.stageFailed")
      ),
    [run, path, t]
  );

  const discardMany = useCallback(
    async (paths: string[], staged: boolean) => {
      const leftovers: string[] = [];
      try {
        for (const file of paths) {
          const clean = staged
            ? await discardStagedFile(path, file)
            : await discardFile(path, file);
          if (!clean) leftovers.push(file);
        }
        await refreshStatus();
        if (leftovers.length > 0) {
          const listed =
            leftovers.slice(0, 3).join(", ") +
            (leftovers.length > 3 ? ` +${leftovers.length - 3} more` : "");
          if (leftovers.some(isSubmodule)) {
            toast.error(
              t("gitRepo.commit.discard.leftoverSub", {
                count: leftovers.length,
                submodules: leftovers.filter(isSubmodule).length,
                listed,
              })
            );
          } else {
            toast.error(t("gitRepo.commit.discard.leftover", { count: leftovers.length, listed }));
          }
        } else {
          toast.success(t("gitRepo.commit.toast.discarded", { count: paths.length }));
        }
      } catch (error) {
        toast.error(t("gitRepo.commit.discard.allFailed", { message: errorText(error) }));
      }
    },
    [isSubmodule, path, refreshStatus, t]
  );

  const requestDiscardMany = useCallback(
    (paths: string[], staged: boolean) => {
      void confirmDialog({
        title: t("gitRepo.commit.discard.manyTitle", { count: paths.length }),
        description: staged
          ? t("gitRepo.commit.discard.descManyStaged")
          : t("gitRepo.commit.discard.descManyUnstaged"),
        confirmLabel: t("gitRepo.commit.discard.confirm"),
        destructive: true,
      }).then((ok) => {
        if (ok) void discardMany(paths, staged);
      });
    },
    [discardMany, t]
  );

  const discardAllStaged = useCallback(async () => {
    const before = allStaged.length;
    try {
      const remaining = await discardStagedAll(path);
      await refreshStatus();
      if (remaining.length > 0) {
        const listed =
          remaining.slice(0, 3).join(", ") +
          (remaining.length > 3 ? ` +${remaining.length - 3} more` : "");
        toast.error(
          t("gitRepo.commit.discard.stagedLeftover", { count: remaining.length, listed })
        );
      } else if (before > 0) {
        toast.success(t("gitRepo.commit.toast.discardedStaged", { count: before }));
      }
    } catch (error) {
      toast.error(t("gitRepo.commit.discard.allFailed", { message: errorText(error) }));
    }
  }, [allStaged.length, path, refreshStatus, t]);

  const toggleStage = useCallback(
    (file: FileStatus, staged: boolean) =>
      void run(
        () => (staged ? unstageFile(path, file.path) : stageFile(path, file.path)),
        staged ? t("gitRepo.commit.ops.unstageFailed") : t("gitRepo.commit.ops.stageFailed")
      ),
    [run, path, t]
  );

  const openFileMenu = useCallback((event: ReactMouseEvent, file: FileStatus, staged: boolean) => {
    event.preventDefault();
    setFileMenu({ x: event.clientX, y: event.clientY, file, staged });
  }, []);

  const requestDiscard = useCallback(
    (file: FileStatus, staged = false) => {
      void confirmDialog({
        title: t("gitRepo.commit.discard.title"),
        description: staged
          ? file.staged === "new"
            ? t("gitRepo.commit.discard.descStagedNew")
            : t("gitRepo.commit.discard.descStaged")
          : file.unstaged === "untracked"
            ? t("gitRepo.commit.discard.descUntracked")
            : t("gitRepo.commit.discard.descUnstaged"),
        path: file.path,
        confirmLabel: t("gitRepo.commit.discard.confirm"),
        destructive: true,
      }).then((ok) => {
        if (ok) void discardOne(file.path, staged);
      });
    },
    [discardOne, t]
  );

  const requestDiscardStaged = useCallback(
    (file: FileStatus) => requestDiscard(file, true),
    [requestDiscard]
  );

  const cleanTree = status !== null && files.length === 0 && conflicts.length === 0 && !filtering;

  const commit = async () => {
    if (!summary.trim() && !amend) return;
    if (committingRef.current) return;
    committingRef.current = true;
    setCommitting(true);
    try {
      if (amend) {
        await commitAmend(path, message.trim() ? message.trim() : undefined);
        toast.success(t("gitRepo.commit.toast.amended"));
      } else {
        await commitCreate(path, message.trim());
        toast.success(t("gitRepo.commit.toast.committed"));
      }
      setMessage("");
      setAmend(false);
      await refreshStatus();
      await useRepo.getState().refresh();
    } catch (error) {
      toast.error(t("gitRepo.commit.toast.commitFailed", { message: errorText(error) }));
    } finally {
      committingRef.current = false;
      setCommitting(false);
    }
  };
  useEffect(() => {
    commitShortcut.current = () => void commit();
    return () => {
      commitShortcut.current = null;
    };
  });

  const generateMessage = async () => {
    if (aiBusy) {
      aiRunRef.current += 1;
      setAiBusy(false);
      return;
    }
    if (!aiConfigured()) {
      toast.info(t("gitRepo.commit.ai.needProvider"));
      return;
    }
    if (stagedFiles.length === 0 && !amend && repo?.state !== "merge") {
      toast.info(t("gitRepo.commit.ai.needStaged"));
      return;
    }
    const run = ++aiRunRef.current;
    const stillRunning = () => aiRunRef.current === run;
    setAiBusy(true);
    try {
      const patch = await stagedPatch(path);
      if (!stillRunning()) return;
      const recents = await recentRepositories();
      if (!stillRunning()) return;
      const projectInstructions = recents.find((entry) => entry.path === path)?.aiInstructions;
      const generated = await generateCommitMessage(getAiProvider(), patch, {
        style: useGitSettings.getState().aiStyle.commit,
        branch: status?.branch ?? null,
        projectInstructions,
      });
      if (!stillRunning()) return;
      setMessage(generated);
    } catch (error) {
      if (stillRunning()) {
        toast.error(t("gitRepo.commit.ai.failed", { message: errorText(error) }));
      }
    } finally {
      if (stillRunning()) setAiBusy(false);
    }
  };

  const fileRowHeight = useCallback(() => FILE_ROW_HEIGHT, []);

  const visibleOrder = useMemo(
    () =>
      allMode
        ? shownEntries.flatMap((entry) =>
            entry.change ? [{ file: entry.change, staged: !entry.change.unstaged }] : []
          )
        : [
            ...unstagedFiles.map((file) => ({ file, staged: false })),
            ...stagedFiles.map((file) => ({ file, staged: true })),
          ],
    [allMode, shownEntries, unstagedFiles, stagedFiles]
  );

  const onRowClick = useCallback(
    (file: FileStatus, staged: boolean, event: ReactMouseEvent) => {
      const side = visibleOrder.filter((e) => e.staged === staged).map((e) => e.file.path);
      if (event.shiftKey) {
        const anchor = useUi.getState().selectedFile;
        const from = anchor && anchor.staged === staged ? side.indexOf(anchor.path) : -1;
        const to = side.indexOf(file.path);
        if (from < 0 || to < 0) {
          showDiff(file, staged);
          return;
        }
        const [a, b] = from < to ? [from, to] : [to, from];
        const paths = side.slice(a, b + 1);
        setMulti(paths.length > 1 ? { staged, paths } : null);
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        const anchor = useUi.getState().selectedFile;
        const base =
          multi && multi.staged === staged
            ? multi.paths
            : anchor && anchor.staged === staged && anchor.path !== file.path
              ? [anchor.path]
              : [];
        const paths = base.includes(file.path)
          ? base.filter((p) => p !== file.path)
          : [...base, file.path];
        setMulti(paths.length > 1 ? { staged, paths } : null);
        if (paths.length === 1) selectFile({ path: paths[0], staged });
        return;
      }
      setMulti(null);
      showDiff(file, staged);
    },
    [visibleOrder, multi, showDiff, selectFile]
  );

  const multiPaths = useMemo(() => new Set(multi?.paths ?? []), [multi]);
  const inMulti = (file: FileStatus, staged: boolean) =>
    !!multi && multi.staged === staged && multiPaths.has(file.path);
  const menuMulti =
    fileMenu && multi && multi.paths.length > 1 && inMulti(fileMenu.file, fileMenu.staged)
      ? multi
      : null;

  const moveFileSelection = (direction: 1 | -1) => {
    if (visibleOrder.length === 0) return;
    const current = useUi.getState().selectedFile;
    const index = current
      ? visibleOrder.findIndex((e) => e.file.path === current.path && e.staged === current.staged)
      : -1;
    const nextIndex =
      index < 0 ? (direction === 1 ? 0 : visibleOrder.length - 1) : index + direction;
    const next = visibleOrder[nextIndex];
    if (!next) return;
    setMulti(null);
    showDiff(next.file, next.staged);
    requestAnimationFrame(() => {
      listScrollRef.current
        ?.querySelector("[data-selected-file-row]")
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  useEffect(() => {
    if (inspectorFocusSeq === focusRequests.inspectorConsumed) return;
    focusRequests.inspectorConsumed = inspectorFocusSeq;
    listScrollRef.current?.focus();
    if (!useUi.getState().selectedFile && visibleOrder[0]) {
      showDiff(visibleOrder[0].file, visibleOrder[0].staged);
    }
  }, [inspectorFocusSeq, visibleOrder, showDiff]);

  const onListKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      useUi.getState().closeCenterDiff();
      useUi.getState().focusGraph();
      return;
    }
    if (e.key === "ArrowRight") {
      const current = useUi.getState().selectedFile;
      const entry = current
        ? visibleOrder.find((x) => x.file.path === current.path && x.staged === current.staged)
        : visibleOrder[0];
      if (!entry) return;
      e.preventDefault();
      e.stopPropagation();
      showDiff(entry.file, entry.staged);
      return;
    }
    if (e.key === "Escape" && multi) {
      e.preventDefault();
      e.stopPropagation();
      setMulti(null);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      moveFileSelection(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      moveFileSelection(-1);
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    const current = useUi.getState().selectedFile;
    if (!current) return;
    const entry = visibleOrder.find(
      (x) => x.file.path === current.path && x.staged === current.staged
    );
    if (!entry) return;
    e.preventDefault();
    if (e.key === "Enter") {
      if (conflictedPaths.has(entry.file.path) && !entry.staged) openConflict(entry.file.path);
      else showDiff(entry.file, entry.staged);
    } else {
      toggleStage(entry.file, entry.staged);
    }
  };

  const treeIndent = (depth?: number) =>
    fileTree && depth !== undefined ? sharedTreeIndent(depth) : undefined;

  const renderUnstaged = (file: FileStatus, depth?: number) => (
    <FileRow
      key={`u-${file.path}`}
      file={file}
      staged={false}
      treeMode={fileTree}
      indent={treeIndent(depth)}
      selected={(selectedFile?.path === file.path && !selectedFile.staged) || inMulti(file, false)}
      onClick={onRowClick}
      onPrimary={toggleStage}
      onContextMenu={openFileMenu}
      onDiscard={requestDiscard}
    />
  );

  const renderStaged = (file: FileStatus, depth?: number) => (
    <FileRow
      key={`s-${file.path}`}
      file={file}
      staged
      treeMode={fileTree}
      indent={treeIndent(depth)}
      selected={(selectedFile?.path === file.path && selectedFile.staged) || inMulti(file, true)}
      onClick={onRowClick}
      onPrimary={toggleStage}
      onContextMenu={openFileMenu}
      onDiscard={requestDiscardStaged}
    />
  );

  const renderPlain = (file: string, depth?: number) => {
    const active =
      centerDiff?.path === file && centerDiff.oid === undefined && !!centerDiff.unchanged;
    return (
      <div
        key={`p-${file}`}
        role="button"
        tabIndex={-1}
        data-unchanged-file
        title={file}
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors",
          active ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted"
        )}
        style={treeIndent(depth) !== undefined ? { paddingLeft: treeIndent(depth) } : undefined}
        onClick={() => {
          setMulti(null);
          selectFile(null);
          openCenterDiff({ path: file, staged: false, unchanged: true });
        }}
      >
        {changedFiles.length > 0 && <span className="size-4 shrink-0" />}
        <span className="flex w-4 shrink-0 justify-center">
          <FileIcon className="text-faint size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate">{basename(file)}</span>
      </div>
    );
  };

  const renderEntry = (entry: AllFilesEntry<FileStatus>, depth?: number) =>
    entry.change
      ? entry.change.unstaged
        ? renderUnstaged(entry.change, depth)
        : renderStaged(entry.change, depth)
      : renderPlain(entry.path, depth);

  const countLabel = (shown: number, total: number) =>
    filtering ? (
      <span className="text-faint">
        {shown}{" "}
        <span className="font-normal tracking-normal normal-case">
          {t("gitRepo.commit.list.of", { total })}
        </span>
      </span>
    ) : (
      <span className="text-faint">{total}</span>
    );

  const commitLabel = amend
    ? t("gitRepo.commit.commit.amendBtn")
    : stagedFiles.length > 0
      ? t("gitRepo.commit.commit.button", { count: stagedFiles.length })
      : t("gitRepo.commit.commit.buttonEmpty");

  const abortMerge = () => {
    void confirmDialog({
      title: t("gitRepo.commit.commit.abortTitle"),
      description: t("gitRepo.commit.commit.abortDescription"),
      confirmLabel: t("gitRepo.commit.commit.abortLabel"),
      destructive: true,
    }).then((ok) => {
      if (!ok) return;
      void (async () => {
        try {
          await mergeAbort(path);
          await refreshStatus();
          await useRepo.getState().refresh();
        } catch (error) {
          toast.error(t("gitRepo.commit.commit.abortFailed", { message: errorText(error) }));
        }
      })();
    });
  };

  return (
    <div className="flex h-full flex-col">
      {status !== null && fileFilterOpen && (
        <div className="shrink-0 px-2 pt-2">
          <FileFilterInput
            value={fileQuery}
            onChange={setFileQuery}
            onClose={() => useUi.getState().setFileFilterOpen(false)}
            focusSeq={fileFilterFocusSeq}
            placeholder={t("gitRepo.commit.filter.placeholder")}
          />
        </div>
      )}
      <div
        ref={listScrollRef}
        tabIndex={0}
        aria-label={t("gitRepo.commit.list.aria")}
        onKeyDown={onListKeyDown}
        className="focus-visible:ring-primary/40 relative min-h-0 flex-1 overflow-y-auto p-2 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
      >
        {status === null ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-5" />
          </div>
        ) : (
          <>
            {cleanTree ? (
              <EmptyCard
                tone="success"
                icon={<Check />}
                title={t("gitRepo.commit.clean.title")}
                description={t("gitRepo.commit.clean.description")}
                className="mt-1"
                action={
                  !amend && repo?.state !== "merge" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground -mb-1 self-start"
                      onClick={() => setAmend(true)}
                    >
                      <Undo2 className="size-3" /> {t("gitRepo.commit.clean.amend")}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                {conflicts.length > 0 && (
                  <div className="border-destructive/40 bg-destructive/5 mb-2 rounded-lg border p-2">
                    <div className="mb-1 flex items-center justify-between px-1">
                      <span className="text-destructive flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
                        <AlertTriangle className="size-3.5" /> {t("gitRepo.commit.conflicts.title")}{" "}
                        <span className="text-faint font-normal">{conflicts.length}</span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => openConflict(conflicts[0])}
                      >
                        {t("gitRepo.commit.conflicts.resolve")}
                      </Button>
                    </div>
                    <p className="text-faint mb-1 px-2 text-[11px]">
                      {t("gitRepo.commit.conflicts.hint", {
                        operation:
                          repo?.state === "merge"
                            ? t("gitRepo.commit.conflicts.merge")
                            : repo?.state === "rebase"
                              ? t("gitRepo.commit.conflicts.rebase")
                              : t("gitRepo.commit.conflicts.operation"),
                      })}
                    </p>
                    {conflicts.map((file) => (
                      <button
                        key={file}
                        type="button"
                        onClick={() => openConflict(file)}
                        className="group hover:bg-destructive/10 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors"
                      >
                        <ChangeMark tone="danger" title={t("gitRepo.commit.mark.conflicted")}>
                          !
                        </ChangeMark>
                        <span className="text-foreground max-w-full shrink-0 truncate font-medium">
                          {basename(file)}
                        </span>
                        <DirName path={file} className="text-[11px]" />
                        <span className="text-destructive shrink-0 text-[11px] opacity-0 transition-opacity group-hover:opacity-100">
                          {t("gitRepo.commit.conflicts.resolve")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {allMode ? (
                  <div className="flex flex-col gap-1">
                    <div className="mb-1 flex items-center justify-between px-2">
                      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                        {t("gitRepo.commit.all.title")}{" "}
                        {filtering ? (
                          countLabel(shownEntries.length, allEntries.length)
                        ) : (
                          <span className="text-faint">
                            {t("gitRepo.commit.all.counts", {
                              total: allEntries.length,
                              changed: changedFiles.length,
                            })}
                          </span>
                        )}
                      </span>
                      <FileTreeFoldButton
                        state={allFoldState}
                        onFold={(mode) => setAllFold((f) => nextFold(f, mode))}
                      />
                    </div>
                    {indexError !== null ? (
                      <p className="text-destructive px-2 pb-2 text-xs [overflow-wrap:anywhere]">
                        {t("gitRepo.commit.all.error", { message: indexError })}
                      </p>
                    ) : indexPaths === null ? (
                      <>
                        {[0, 1, 2].map((i) => (
                          <div key={i} className="bg-muted h-7 animate-pulse rounded-md" />
                        ))}
                      </>
                    ) : shownEntries.length === 0 ? (
                      <p className="text-faint px-2 pb-2 text-xs">
                        {filtering ? t("gitRepo.commit.filter.none") : t("gitRepo.commit.all.none")}
                      </p>
                    ) : (
                      <FileTree
                        items={shownEntries}
                        pathOf={entryPath}
                        renderFile={renderEntry}
                        fold={allFold}
                        onFoldState={setAllFoldState}
                        defaultCollapsed={(folder) => !changedFolders.has(folder)}
                      />
                    )}
                  </div>
                ) : (
                  <>
                    <div className="mb-1 flex items-center justify-between px-2">
                      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                        {t("gitRepo.commit.changes.title")}{" "}
                        {countLabel(unstagedFiles.length, allUnstaged.length)}
                      </span>
                      <div className="flex items-center gap-1">
                        {allUnstaged.length > 0 && (
                          <>
                            {fileTree && (
                              <FileTreeFoldButton
                                state={unstagedFoldState}
                                onFold={(mode) => setUnstagedFold((f) => nextFold(f, mode))}
                              />
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                void run(
                                  () => stageAll(path),
                                  t("gitRepo.commit.changes.stageAllFailed")
                                )
                              }
                            >
                              <Plus className="size-3" /> {t("gitRepo.commit.changes.stageAll")}
                            </Button>
                            <Hint label={t("gitRepo.commit.changes.discardAll")}>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("gitRepo.commit.changes.discardAll")}
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => {
                                  void confirmDialog({
                                    title: t("gitRepo.commit.changes.discardAllTitle", {
                                      count: allUnstaged.length,
                                    }),
                                    description: t("gitRepo.commit.changes.discardAllDescription", {
                                      mod: modKey(),
                                    }),
                                    confirmLabel: t("gitRepo.commit.changes.discardAllConfirm"),
                                    destructive: true,
                                  }).then((ok) => {
                                    if (ok) void discardEverything();
                                  });
                                }}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </Hint>
                          </>
                        )}
                      </div>
                    </div>
                    {allUnstaged.length === 0 ? (
                      <p className="text-faint px-2 pb-2 text-xs">
                        {filtering && allUnstaged.length > 0
                          ? t("gitRepo.commit.filter.noneUnstaged")
                          : t("gitRepo.commit.changes.empty")}
                      </p>
                    ) : fileTree ? (
                      <FileTree
                        items={unstagedFiles}
                        pathOf={fileStatusPath}
                        renderFile={renderUnstaged}
                        fold={unstagedFold}
                        onFoldState={setUnstagedFoldState}
                      />
                    ) : (
                      <VirtualFileList
                        files={unstagedFiles}
                        scrollRef={listScrollRef}
                        rowHeight={fileRowHeight}
                        renderRow={renderUnstaged}
                      />
                    )}
                    <div
                      data-staged-header
                      className="border-border mt-3 mb-1 flex items-center justify-between border-t px-2 pt-3"
                    >
                      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                        {t("gitRepo.commit.staged.title")}{" "}
                        {countLabel(stagedFiles.length, allStaged.length)}
                      </span>
                      <div className="flex items-center gap-1">
                        {allStaged.length > 0 && (
                          <>
                            {fileTree && (
                              <FileTreeFoldButton
                                state={stagedFoldState}
                                onFold={(mode) => setStagedFold((f) => nextFold(f, mode))}
                              />
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                void run(
                                  () => unstageAll(path),
                                  t("gitRepo.commit.staged.unstageAllFailed")
                                )
                              }
                            >
                              <Minus className="size-3" /> {t("gitRepo.commit.staged.unstageAll")}
                            </Button>
                            <Hint label={t("gitRepo.commit.staged.discardAll")}>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("gitRepo.commit.staged.discardAll")}
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => {
                                  void confirmDialog({
                                    title: t("gitRepo.commit.staged.discardAllTitle", {
                                      count: allStaged.length,
                                    }),
                                    description: t("gitRepo.commit.staged.discardAllDescription", {
                                      mod: modKey(),
                                    }),
                                    confirmLabel: t("gitRepo.commit.changes.discardAllConfirm"),
                                    destructive: true,
                                  }).then((ok) => {
                                    if (ok) void discardAllStaged();
                                  });
                                }}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </Hint>
                          </>
                        )}
                      </div>
                    </div>
                    {allStaged.length === 0 ? (
                      filtering && allStaged.length > 0 ? (
                        <p className="text-faint px-2 pb-2 text-xs">
                          {t("gitRepo.commit.filter.noneStaged")}
                        </p>
                      ) : (
                        <EmptyCard
                          icon={<SquareCheck />}
                          title={t("gitRepo.commit.staged.emptyTitle")}
                          description={t("gitRepo.commit.staged.emptyDescription")}
                        />
                      )
                    ) : fileTree ? (
                      <FileTree
                        items={stagedFiles}
                        pathOf={fileStatusPath}
                        renderFile={renderStaged}
                        fold={stagedFold}
                        onFoldState={setStagedFoldState}
                      />
                    ) : (
                      <VirtualFileList
                        files={stagedFiles}
                        scrollRef={listScrollRef}
                        rowHeight={fileRowHeight}
                        renderRow={renderStaged}
                      />
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>

      {fileMenu && (
        <DropdownMenu open onOpenChange={(open) => !open && setFileMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: fileMenu.x, top: fileMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            {menuMulti ? (
              <>
                <DropdownMenuLabel>
                  {t("gitRepo.commit.menu.selected", { count: menuMulti.paths.length })}
                </DropdownMenuLabel>
                <DropdownMenuItem onClick={() => void stageMany(menuMulti.paths, menuMulti.staged)}>
                  {menuMulti.staged ? <Minus /> : <Plus />}
                  {menuMulti.staged
                    ? t("gitRepo.commit.menu.unstageFiles", { count: menuMulti.paths.length })
                    : t("gitRepo.commit.menu.stageFiles", { count: menuMulti.paths.length })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    useUi.getState().openDialog("createStash", { paths: menuMulti.paths })
                  }
                >
                  <Archive />{" "}
                  {t("gitRepo.commit.menu.stashFiles", { count: menuMulti.paths.length })}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => requestDiscardMany(menuMulti.paths, menuMulti.staged)}
                >
                  <Trash2 />{" "}
                  {t("gitRepo.commit.menu.discardMany", { count: menuMulti.paths.length })}
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuLabel className="max-w-64 truncate font-mono">
                  {fileMenu.file.path}
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => void stageMany([fileMenu.file.path], fileMenu.staged)}
                >
                  {fileMenu.staged ? <Minus /> : <Plus />}
                  {fileMenu.staged
                    ? t("gitRepo.commit.menu.unstageFile")
                    : t("gitRepo.commit.menu.stageFile")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    useUi.getState().openDialog("createStash", { paths: [fileMenu.file.path] })
                  }
                >
                  <Archive /> {t("gitRepo.commit.menu.stashFile")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => openEditor(fileMenu.file.path)}>
                  <Pencil /> {t("gitRepo.commit.menu.edit")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => useUi.getState().openFileHistory(fileMenu.file.path)}
                >
                  <History /> {t("gitRepo.commit.menu.history")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!hasCommittedHistory(fileMenu.file)}
                  onClick={() => useUi.getState().openBlame(fileMenu.file.path)}
                >
                  <UserRoundSearch />{" "}
                  {hasCommittedHistory(fileMenu.file)
                    ? t("gitRepo.commit.menu.blame")
                    : t("gitRepo.commit.menu.blameDisabled")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void openPath(`${path}/${fileMenu.file.path}`).catch((error: unknown) => {
                      toast.error(
                        t("gitRepo.commit.menu.openFailed", { message: errorText(error) })
                      );
                    })
                  }
                >
                  <ExternalLink /> {t("gitRepo.commit.menu.openExternal")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void revealPath(`${path}/${fileMenu.file.path}`).catch((error: unknown) => {
                      toast.error(
                        t("gitRepo.commit.menu.revealFailed", { message: errorText(error) })
                      );
                    })
                  }
                >
                  <FolderOpen /> {t("gitRepo.commit.menu.reveal")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void navigator.clipboard.writeText(fileMenu.file.path);
                    toast.success(t("gitRepo.commit.menu.copied"));
                  }}
                >
                  <Copy /> {t("gitRepo.commit.menu.copyPath")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void navigator.clipboard.writeText(`${path}/${fileMenu.file.path}`);
                    toast.success(t("gitRepo.commit.menu.absCopied"));
                  }}
                >
                  <Copy /> {t("gitRepo.commit.menu.copyAbsPath")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => requestDiscard(fileMenu.file, fileMenu.staged)}
                >
                  <Trash2 /> {t("gitRepo.commit.menu.discard")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => {
                    const file = fileMenu.file;
                    void confirmDialog({
                      title: t("gitRepo.commit.discard.removeTitle"),
                      description:
                        file.unstaged === "untracked"
                          ? t("gitRepo.commit.discard.removeUntracked")
                          : t("gitRepo.commit.discard.removeTracked"),
                      path: file.path,
                      confirmLabel: t("gitRepo.commit.discard.removeConfirm"),
                      destructive: true,
                    }).then((ok) => {
                      if (ok)
                        void run(
                          () => deleteFile(path, file.path),
                          t("gitRepo.commit.ops.deleteFailed")
                        );
                    });
                  }}
                >
                  <Trash2 /> {t("gitRepo.commit.menu.delete")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {status === null ? null : files.length === 0 && !amend && repo?.state !== "merge" ? null : (
        <div className="border-border relative shrink-0 border-t p-3">
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("gitRepo.commit.commit.resize")}
            title={t("gitRepo.commit.commit.resizeTitle")}
            onMouseDown={startResize}
            onDoubleClick={() => useUi.getState().setCommitBoxHeight(null)}
            className={cn(
              "group/handle absolute -top-1 right-0 left-0 z-10 flex h-2 cursor-row-resize items-center justify-center"
            )}
          >
            <span
              className={cn(
                "h-0.5 w-10 rounded-full transition-colors",
                resizing ? "bg-primary" : "group-hover/handle:bg-primary/60 bg-transparent"
              )}
            />
          </div>
          <div
            className={cn(
              "border-border bg-card rounded-md border shadow-sm transition-colors",
              "focus-within:border-primary/60 focus-within:ring-primary/60 focus-within:ring-2"
            )}
          >
            <div className="relative flex items-center">
              <input
                ref={summaryRef}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    messageRef.current?.focus();
                  }
                }}
                placeholder={
                  amend
                    ? t("gitRepo.commit.commit.summaryPlaceholderAmend")
                    : t("gitRepo.commit.commit.summaryPlaceholder")
                }
                aria-label={t("gitRepo.commit.commit.summaryAria")}
                autoCapitalize="off"
                spellCheck
                className={cn(
                  "text-foreground h-9 min-w-0 flex-1 bg-transparent pl-3 text-sm font-medium outline-none",
                  "placeholder:text-faint placeholder:font-normal",
                  summary.length > 50 ? "pr-24" : "pr-9"
                )}
              />
              {summary.length > 50 && (
                <span
                  className={cn(
                    "pointer-events-none absolute right-9 font-mono text-[10px] tabular-nums",
                    summary.length > 72 ? "text-destructive" : "text-faint"
                  )}
                  title={t("gitRepo.commit.commit.summaryLengthTitle")}
                >
                  {summary.length}/72
                </span>
              )}
            </div>
            <div className="bg-border mx-3 h-px" />
            <Textarea
              ref={attachMessageBox}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && body.length === 0) {
                  e.preventDefault();
                  summaryRef.current?.focus();
                }
              }}
              placeholder={t("gitRepo.commit.commit.bodyPlaceholder")}
              aria-label={t("gitRepo.commit.commit.bodyAria")}
              autoCapitalize="off"
              spellCheck
              className={cn(
                "text-foreground min-h-[72px] resize-none rounded-none border-0 bg-transparent px-3 py-2 text-xs leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0",
                commitBoxHeight === null ? "max-h-[260px]" : "max-h-[600px] overflow-y-auto"
              )}
            />
            <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
              <label className="text-muted-foreground mr-auto flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox checked={amend} onCheckedChange={(value) => setAmend(value === true)} />
                <Undo2 className="size-3" /> {t("gitRepo.commit.commit.amend")}
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => void generateMessage()}
              >
                {aiBusy ? <Spinner /> : <Sparkles className="size-3.5" />}
                {aiBusy ? t("gitRepo.commit.ai.generating") : t("gitRepo.commit.ai.label")}
              </Button>
              {repo?.state === "merge" && (
                <Hint label={t("gitRepo.commit.commit.abortHint")}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={abortMerge}
                  >
                    {t("gitRepo.commit.commit.abortLabel")}
                  </Button>
                </Hint>
              )}
              <Hint
                label={
                  <span className="flex items-center gap-1">
                    {stagedFiles.length === 0 && !amend && repo?.state !== "merge"
                      ? t("gitRepo.commit.commit.stageHint")
                      : t("gitRepo.commit.commit.hint")}{" "}
                    <Kbd>{modKey()}</Kbd> <Kbd>⏎</Kbd>
                  </span>
                }
              >
                <Button
                  size="sm"
                  disabled={
                    committing ||
                    (!summary.trim() && !amend) ||
                    (stagedFiles.length === 0 && !amend && repo?.state !== "merge")
                  }
                  onClick={() => void commit()}
                >
                  {committing && <Spinner className="text-primary-foreground" />}
                  {commitLabel}
                </Button>
              </Hint>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
