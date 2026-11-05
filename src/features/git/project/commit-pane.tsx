import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Folder,
  FolderOpen,
  Loader2,
  Minus,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { commitAmend, commitCreate, historyCommit, stageFile, unstageFile } from "@/commands";
import { Button } from "@/components/ui/button";
import { ChangeMark, type ChangeMarkTone } from "@/components/git/change-mark";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCommitDraft } from "@/features/git/commit/draftStore";
import { useProjectRepo } from "./project-repo-store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { FileStatus } from "@/lib/git-core";
import { effectiveKind, type VcsKind } from "@/lib/editor/vcs-decorations";
import { cn } from "@/lib/utils";
import {
  aggregateCheck,
  checkOf,
  groupOf,
  planCommit,
  toggledCheck,
  type CheckState,
  type GroupId,
} from "./commit-plan";
import { CommitMessage, rememberCommitMessage } from "./commit-message";
import { errorText, refreshRepository, stageFileAction, unstageFileAction } from "./file-actions";
import { trackGit } from "./git-console";
import { useGitView } from "./git-view-store";
import {
  copyFilePath,
  FileContextMenu,
  fileAbsolutePath,
  runRestoreFile,
  type FileMenuTarget,
} from "./file-context-menu";
import type { ProjectMenuItem } from "./context-menu";
import type { ProjectTabOpeners } from "./tab-openers";

const TONES: Record<VcsKind, { mark: string; tone: ChangeMarkTone }> = {
  modified: { mark: "M", tone: "info" },
  added: { mark: "A", tone: "success" },
  deleted: { mark: "D", tone: "danger" },
  renamed: { mark: "R", tone: "primary" },
  untracked: { mark: "U", tone: "neutral" },
  conflicted: { mark: "!", tone: "danger" },
  ignored: { mark: "", tone: "neutral" },
};

const GROUP_ORDER: GroupId[] = ["conflicts", "changes", "unversioned"];

interface DirNode {
  name: string;
  path: string;
  children: TreeNode[];
  files: FileStatus[];
}
type TreeNode = DirNode | { name: string; file: FileStatus };

const isDir = (node: TreeNode): node is DirNode => "children" in node;

function collectFiles(node: DirNode): FileStatus[] {
  const out: FileStatus[] = [];
  for (const child of node.children) {
    if (isDir(child)) out.push(...collectFiles(child));
    else out.push(child.file);
  }
  node.files = out;
  return out;
}

/** Directories first, then files, each by name — the order the IDE shows them in. */
function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    const aDir = isDir(a);
    const bDir = isDir(b);
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) if (isDir(node)) sortNodes(node.children);
}

function buildTree(files: readonly FileStatus[]): TreeNode[] {
  const root: DirNode = { name: "", path: "", children: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      const path = dir.path ? `${dir.path}/${name}` : name;
      const found = dir.children.find((node): node is DirNode => isDir(node) && node.path === path);
      if (found) {
        dir = found;
        continue;
      }
      const created: DirNode = { name, path, children: [], files: [] };
      dir.children.push(created);
      dir = created;
    }
    dir.children.push({ name: parts[parts.length - 1] ?? file.path, file });
  }
  collectFiles(root);
  sortNodes(root.children);
  return root.children;
}

/** Without directory grouping the files are one flat list, ordered by path. */
function flatRows(files: readonly FileStatus[]): TreeNode[] {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({ name: file.path.split("/").pop() ?? file.path, file }));
}

function CheckBox({
  state,
  disabled,
  label,
  onToggle,
}: {
  state: "on" | "off" | "partial";
  disabled?: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "partial" ? "mixed" : state === "on"}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "border-border flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
        state !== "off" && "border-primary bg-primary text-primary-foreground",
        disabled && "opacity-50"
      )}
    >
      {state === "on" && <Check className="size-2.5" />}
      {state === "partial" && <Minus className="size-2.5" />}
    </button>
  );
}

function FileRow({
  name,
  file,
  depth,
  check,
  disabled,
  showPath,
  onToggle,
  onOpenDiff,
  onMenu,
  onKeyDown,
}: {
  name: string;
  file: FileStatus;
  depth: number;
  check: CheckState;
  disabled: boolean;
  showPath: boolean;
  onToggle: () => void;
  onOpenDiff: () => void;
  onMenu: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useAppTranslation();
  const kind = effectiveKind(file);
  if (!kind) return null;
  const meta = TONES[kind];
  const partial = check === "staged" || check === "hunks";
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";

  return (
    <div
      className="hover:bg-muted flex h-6 items-center gap-1.5 rounded pr-2 text-xs transition-colors"
      style={{ paddingLeft: 6 + depth * 12 }}
      onContextMenu={onMenu}
    >
      <CheckBox
        state={check === "none" ? "off" : partial ? "partial" : "on"}
        disabled={disabled}
        label={t("gitRepo.commit.list.aria")}
        onToggle={onToggle}
      />
      <button
        type="button"
        title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
        onClick={onOpenDiff}
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <ChangeMark tone={meta.tone} title={t(`projectGit.status.${kind}`)}>
          {meta.mark}
        </ChangeMark>
        <span className={cn("min-w-0 truncate", showPath && dir ? "shrink" : "flex-1")}>
          {name}
        </span>
        {showPath && dir && (
          <span className="text-faint max-w-[60%] min-w-0 shrink-0 truncate text-[10px]">
            {dir}
          </span>
        )}
        {partial && (
          <span className="text-faint shrink-0 text-[10px]" title={t("projectGit.partialHint")}>
            {t("projectGit.partial")}
          </span>
        )}
      </button>
    </div>
  );
}

function TreeRows({
  nodes,
  depth,
  scope,
  checks,
  disabled,
  showPath,
  collapsed,
  onToggleCollapse,
  onToggleDir,
  onToggleFile,
  onOpenDiff,
  onMenu,
  onKeyDown,
}: {
  nodes: readonly TreeNode[];
  depth: number;
  scope: GroupId;
  checks: ReadonlyMap<string, CheckState>;
  disabled: boolean;
  showPath: boolean;
  collapsed: ReadonlySet<string>;
  onToggleCollapse: (key: string) => void;
  onToggleDir: (files: FileStatus[]) => void;
  onToggleFile: (file: FileStatus) => void;
  onOpenDiff: (file: FileStatus) => void;
  onMenu: (file: FileStatus, event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (file: FileStatus, event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useAppTranslation();
  return (
    <>
      {nodes.map((node) => {
        if (!isDir(node)) {
          return (
            <FileRow
              key={`f:${node.file.path}`}
              name={node.name}
              file={node.file}
              depth={depth}
              check={checkOf(node.file, checks)}
              disabled={disabled}
              showPath={showPath}
              onToggle={() => onToggleFile(node.file)}
              onOpenDiff={() => onOpenDiff(node.file)}
              onMenu={(event) => onMenu(node.file, event)}
              onKeyDown={(event) => onKeyDown(node.file, event)}
            />
          );
        }
        const key = `${scope}:${node.path}`;
        const open = !collapsed.has(key);
        const aggregate = aggregateCheck(node.files, checks);
        return (
          <div key={`d:${node.path}`}>
            <div
              className="hover:bg-muted text-muted-foreground flex h-6 items-center gap-1 rounded pr-2 text-xs transition-colors"
              style={{ paddingLeft: 4 + depth * 12 }}
            >
              <CheckBox
                state={aggregate.checked ? "on" : aggregate.indeterminate ? "partial" : "off"}
                disabled={disabled}
                label={t("gitRepo.commit.list.aria")}
                onToggle={() => onToggleDir(node.files)}
              />
              <button
                type="button"
                onClick={() => onToggleCollapse(key)}
                aria-label={node.path}
                className="flex size-3 shrink-0 items-center justify-center"
              >
                {open ? (
                  <ChevronDown className="text-faint size-3" />
                ) : (
                  <ChevronRight className="text-faint size-3" />
                )}
              </button>
              {open ? (
                <FolderOpen className="text-faint size-3.5 shrink-0" />
              ) : (
                <Folder className="text-faint size-3.5 shrink-0" />
              )}
              <button
                type="button"
                onClick={() => onToggleDir(node.files)}
                aria-expanded={open}
                title={node.path}
                className="min-w-0 flex-1 truncate text-left"
              >
                {node.name}
              </button>
              <span className="text-faint shrink-0 tabular-nums">{node.files.length}</span>
            </div>
            {open && (
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                scope={scope}
                checks={checks}
                disabled={disabled}
                showPath={showPath}
                collapsed={collapsed}
                onToggleCollapse={onToggleCollapse}
                onToggleDir={onToggleDir}
                onToggleFile={onToggleFile}
                onOpenDiff={onOpenDiff}
                onMenu={onMenu}
                onKeyDown={onKeyDown}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * The Commit button's cover over the side bar: the working copy grouped the way
 * the IDE groups it, a checkbox per file, and the message and buttons below.
 *
 * The commit takes the whole index, so the plan unstages anything left out of
 * the selection before it stages anything new.
 */
export function CommitPane({
  repo,
  openers,
  onClose,
}: {
  repo: string | null;
  openers: ProjectTabOpeners;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const status = useProjectRepo((state) => state.status);
  const info = useProjectRepo((state) => state.repo);
  const refreshing = useProjectRepo((state) => state.refreshing);
  const refreshToken = useGitView((state) => state.refreshToken);
  const changesTree = useGitView((state) => state.changesTree);
  const changesShowPath = useGitView((state) => state.changesShowPath);
  const drafts = useCommitDraft((state) => state.drafts);
  const amendFor = useCommitDraft((state) => state.amendFor);

  const [checks, setChecks] = useState<Map<string, CheckState>>(() => new Map());
  const [amendMessage, setAmendMessage] = useState("");
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
  // Every group starts open: the point of this view is to show the working
  // copy as it is, untracked files included.
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<GroupId>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<FileMenuTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const amendOidRef = useRef<string | null>(null);

  const draft = repo ? (drafts[repo] ?? "") : "";
  const amend = repo !== null && amendFor === repo;
  const message = amend ? amendMessage : draft;
  const headOid = info?.headOid ?? null;
  const ready = info?.path === repo && status !== null;

  // The page opens the repository; this view owns re-reading it as the working
  // copy changes, without a poll of its own.
  useEffect(() => {
    if (!repo) return;
    const state = useProjectRepo.getState();
    const reload =
      state.repo?.path === repo ? state.refreshStatus() : state.open(repo).then(() => undefined);
    void reload.then(
      () => setError(null),
      (cause: unknown) => setError(errorText(cause))
    );
  }, [repo, refreshToken]);

  useEffect(() => {
    if (!repo) return;
    const onFocus = () => {
      if (useProjectRepo.getState().repo?.path === repo) {
        void useProjectRepo
          .getState()
          .refreshStatus()
          .catch(() => undefined);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [repo]);

  const files = useMemo(() => {
    if (!status || info?.path !== repo) return [] as FileStatus[];
    return status.files.filter((file) => groupOf(file) !== null);
  }, [status, info?.path, repo]);

  // Guarded by the same path check as `files`, so the counter can never count a
  // working copy the list is not showing.
  const plan = useMemo(
    () => planCommit(info?.path === repo ? (status?.files ?? []) : [], checks),
    [status?.files, info?.path, repo, checks]
  );

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((id) => ({
        id,
        files: files.filter((file) => groupOf(file) === id),
      })).filter((group) => group.files.length > 0),
    [files]
  );

  const aggregate = aggregateCheck(files, checks);

  const setMessage = useCallback(
    (value: string) => {
      if (!repo) return;
      if (amend) setAmendMessage(value);
      else useCommitDraft.getState().setDraft(repo, value);
    },
    [repo, amend]
  );

  const toggleAmend = useCallback(
    (next: boolean) => {
      if (!repo) return;
      useCommitDraft.getState().setAmend(repo, next);
      if (!next || !headOid) return;
      if (amendOidRef.current === headOid) return;
      setBusy(true);
      void trackGit(repo, `git show --format=%B ${headOid.slice(0, 7)}`, () =>
        historyCommit(repo, headOid)
      )
        .then((commit) => {
          amendOidRef.current = headOid;
          setAmendMessage(commit.body ? `${commit.summary}\n\n${commit.body}` : commit.summary);
        })
        .catch((cause: unknown) => {
          toast.error(t("projectGit.headMessageFailed", { message: errorText(cause) }));
        })
        .finally(() => setBusy(false));
    },
    [repo, headOid, t]
  );

  const toggleFile = useCallback((file: FileStatus) => {
    setChecks((previous) => {
      const next = new Map(previous);
      next.set(file.path, toggledCheck(checkOf(file, previous)));
      return next;
    });
  }, []);

  const toggleFiles = useCallback((list: readonly FileStatus[]) => {
    setChecks((previous) => {
      const current = aggregateCheck(list, previous);
      const target: CheckState = current.checked ? "none" : "all";
      const next = new Map(previous);
      for (const file of list) next.set(file.path, target);
      return next;
    });
  }, []);

  const toggleDirKey = useCallback((key: string) => {
    setCollapsedDirs((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((id: GroupId) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const withBusy = useCallback(async (run: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await run();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  // A file counts as staged when the index holds its change, which is what the
  // diff tab must show.
  const stagedFor = useCallback(
    (file: FileStatus) => {
      const check = checkOf(file, checks);
      return (
        check === "staged" || check === "hunks" || (file.staged !== null && file.unstaged === null)
      );
    },
    [checks]
  );

  const openDiffFor = useCallback(
    (file: FileStatus) => {
      openers.openDiff({
        oid: null,
        path: file.path,
        oldPath: file.origPath,
        staged: stagedFor(file),
      });
    },
    [openers, stagedFor]
  );

  // The working copy may hold the file (then the editor opens it), or it may
  // have been deleted, and only the last commit can still show it.
  const editSource = useCallback(
    (file: FileStatus) => {
      const fullPath = repo ? fileAbsolutePath(repo, file.path) : null;
      void (async () => {
        if (fullPath && (await openers.openFile(fullPath))) return;
        if (headOid) openers.openRevisionFile(headOid, file.path);
        else toast.error(t("projectGit.editorUnavailable"));
      })();
    },
    [repo, openers, headOid, t]
  );

  const openMenu = useCallback(
    (file: FileStatus, event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      setMenu({
        point: { x: event.clientX, y: event.clientY },
        row: {
          path: file.path,
          oldPath: file.origPath,
          oid: null,
          staged: stagedFor(file),
          deleted: effectiveKind(file) === "deleted",
        },
      });
    },
    [stagedFor]
  );

  const onFileKeyDown = useCallback(
    (file: FileStatus, event: KeyboardEvent<HTMLButtonElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        openDiffFor(file);
        return;
      }
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copyFilePath(file.path, t);
        return;
      }
      if (event.key === "F4") {
        event.preventDefault();
        editSource(file);
        return;
      }
      if (event.key === "Delete") {
        event.preventDefault();
        if (repo && headOid) void runRestoreFile(repo, file.path, headOid, t);
      }
    },
    [openDiffFor, editSource, repo, headOid, t]
  );

  const commit = useCallback(() => {
    if (!repo || busyRef.current) return;
    const current = useProjectRepo.getState().status;
    if (!current) return;
    const currentPlan = planCommit(current.files, checks);
    const text = message.trim();
    if (!currentPlan.included.length && !amend) {
      toast.info(t("projectGit.commitNoChanges"));
      return;
    }
    if (!amend && !text) return;
    const unresolved = currentPlan.included.filter((file) => effectiveKind(file) === "conflicted");
    if (unresolved.length) {
      toast.error(t("projectGit.commitConflicts"));
      return;
    }

    busyRef.current = true;
    setBusy(true);
    void (async () => {
      try {
        if (currentPlan.unstage.length) {
          await trackGit(repo, `git reset HEAD -- ${currentPlan.unstage.join(" ")}`, async () => {
            for (const path of currentPlan.unstage) await unstageFile(repo, path);
          });
        }
        if (currentPlan.stage.length) {
          await trackGit(repo, `git add -- ${currentPlan.stage.join(" ")}`, async () => {
            for (const path of currentPlan.stage) await stageFile(repo, path);
          });
        }
        if (currentPlan.partial.length) {
          // Selecting individual blocks is not wired up yet: staging the whole
          // file keeps the commit explainable instead of leaving half an index.
          await trackGit(repo, `git add -- ${currentPlan.partial.join(" ")}`, async () => {
            for (const path of currentPlan.partial) await stageFile(repo, path);
          });
          toast.info(t("projectGit.commitPartialWhole", { path: currentPlan.partial[0] }));
        }
        if (amend) {
          await trackGit(repo, "git commit --amend", () => commitAmend(repo, text || undefined));
          toast.success(t("gitRepo.commit.toast.amended"));
        } else {
          await trackGit(repo, "git commit", () => commitCreate(repo, text));
          toast.success(t("gitRepo.commit.toast.committed"));
        }
        if (text) rememberCommitMessage(text);
        setChecks(new Map());
        setAmendMessage("");
        amendOidRef.current = null;
        useCommitDraft.getState().setDraft(repo, "");
        useCommitDraft.getState().setAmend(repo, false);
        await refreshRepository(repo, true);
      } catch (cause) {
        // Whatever got staged before the failure is still in the index; show it
        // rather than leaving the view describing a state that no longer exists.
        await refreshRepository(repo);
        toast.error(t("gitRepo.commit.toast.commitFailed", { message: errorText(cause) }));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    })();
  }, [repo, checks, message, amend, t]);

  const canCommit =
    !busy && (amend ? headOid !== null : message.trim() !== "" && plan.included.length > 0);
  const branchName = status?.branch ?? info?.headBranch ?? null;

  // Staging stays on the file menu even though the checkbox does the same: a
  // right-click is where an IDE user looks for it.
  const menuFile = menu ? files.find((file) => file.path === menu.row.path) : undefined;
  const extraItems: Array<ProjectMenuItem | null | false> = menuFile
    ? [
        {
          id: "file.stage",
          label: t("gitRepo.commit.menu.stageFile"),
          icon: <Plus />,
          disabled: busy || !menuFile.unstaged || menuFile.unstaged === "conflicted",
          onSelect: () => {
            if (repo) void withBusy(() => stageFileAction(repo, menuFile));
          },
        },
        {
          id: "file.unstage",
          label: t("gitRepo.commit.menu.unstageFile"),
          icon: <Minus />,
          disabled: busy || !menuFile.staged,
          onSelect: () => {
            if (repo) void withBusy(() => unstageFileAction(repo, menuFile));
          },
        },
      ]
    : [];

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <div className="border-border flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={branchName ?? undefined}
        >
          {branchName ?? t("projectGit.workingTree")}
        </span>
        {(status?.ahead ?? 0) > 0 || (status?.behind ?? 0) > 0 ? (
          <span className="text-faint shrink-0 font-mono text-[10px]">
            {(status?.ahead ?? 0) > 0 && `↑${status?.ahead} `}
            {(status?.behind ?? 0) > 0 && `↓${status?.behind}`}
          </span>
        ) : null}
        <span className="text-faint shrink-0 text-[10px] tabular-nums">
          {t("gitRepo.commit.menu.selected", { count: plan.included.length })}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("projectGit.viewOptions")}
              title={t("projectGit.viewOptions")}
            >
              <Eye className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuCheckboxItem
              checked={changesTree}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => useGitView.getState().setChangesTree(checked === true)}
            >
              {t("projectGit.groupByDir")}
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={changesShowPath}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                useGitView.getState().setChangesShowPath(checked === true)
              }
            >
              {t("projectGit.showFilePath")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={aggregate.checked ? t("projectGit.deselectAll") : t("projectGit.selectAll")}
          title={aggregate.checked ? t("projectGit.deselectAll") : t("projectGit.selectAll")}
          disabled={busy || files.length === 0}
          onClick={() => toggleFiles(files)}
        >
          {aggregate.checked ? <Check className="size-3" /> : <Minus className="size-3" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("projectGit.refresh")}
          title={t("projectGit.refresh")}
          disabled={busy}
          onClick={() => {
            if (!repo) return;
            void withBusy(async () => {
              try {
                await refreshRepository(repo, true);
                setError(null);
              } catch (cause) {
                setError(errorText(cause));
              }
            });
          }}
        >
          <RotateCw className={cn("size-3", (busy || refreshing) && "animate-spin")} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("projectGit.closeView")}
          title={t("projectGit.closeView")}
          onClick={onClose}
        >
          <X className="size-3" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {repo === null ? (
          <p className="text-muted-foreground px-2 py-3 text-xs">{t("projectGit.noRepo")}</p>
        ) : error ? (
          <p className="text-destructive px-2 py-2 text-[11px] [overflow-wrap:anywhere]">
            {t("projectGit.statusFailed", { message: error })}
          </p>
        ) : !ready ? (
          <div className="flex justify-center py-8">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        ) : files.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-xs">
            {t("gitRepo.commit.changes.empty")}
          </p>
        ) : (
          groups.map((group) => {
            const open = !collapsedGroups.has(group.id);
            const groupAggregate = aggregateCheck(group.files, checks);
            const title =
              group.id === "changes"
                ? t("gitRepo.commit.changes.title")
                : t(`projectGit.group.${group.id}`);
            return (
              <div key={group.id} className="pb-1">
                <div className="text-faint flex h-6 items-center gap-1 px-2 text-[11px] font-medium tracking-wide uppercase">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    aria-expanded={open}
                    className="flex size-3 shrink-0 items-center justify-center"
                  >
                    {open ? (
                      <ChevronDown className="size-3" />
                    ) : (
                      <ChevronRight className="size-3" />
                    )}
                  </button>
                  <CheckBox
                    state={
                      groupAggregate.checked
                        ? "on"
                        : groupAggregate.indeterminate
                          ? "partial"
                          : "off"
                    }
                    disabled={busy}
                    label={title}
                    onToggle={() => toggleFiles(group.files)}
                  />
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    className="min-w-0 flex-1 truncate text-left"
                  >
                    {title}
                  </button>
                  <span className="tabular-nums">{group.files.length}</span>
                </div>
                {open && (
                  <TreeRows
                    nodes={changesTree ? buildTree(group.files) : flatRows(group.files)}
                    depth={0}
                    scope={group.id}
                    checks={checks}
                    disabled={busy}
                    showPath={changesShowPath}
                    collapsed={collapsedDirs}
                    onToggleCollapse={toggleDirKey}
                    onToggleDir={toggleFiles}
                    onToggleFile={toggleFile}
                    onOpenDiff={openDiffFor}
                    onMenu={openMenu}
                    onKeyDown={onFileKeyDown}
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      <CommitMessage
        message={message}
        included={plan.included.length}
        amend={amend}
        amendEnabled={headOid !== null}
        busy={busy}
        canCommit={canCommit}
        onChange={setMessage}
        onAmendChange={toggleAmend}
        onCommit={commit}
      />

      <FileContextMenu
        repo={repo}
        target={menu}
        headOid={headOid}
        openers={openers}
        onClose={() => setMenu(null)}
        extraItems={extraItems}
      />
    </div>
  );
}
