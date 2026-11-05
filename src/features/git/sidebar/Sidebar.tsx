import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { toastOutcome } from "@/features/git/toast-outcome";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  Check,
  ChevronRight,
  ChevronsDownUp,
  Cloud,
  Copy,
  Eraser,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderTree,
  GitBranch,
  FastForward,
  GitMerge,
  Globe,
  GitPullRequest,
  Home,
  MoveRight,
  ListRestart,
  Lock,
  MoreHorizontal,
  GitBranchPlus,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Tag as TagIcon,
  Trash2,
  Undo2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Hint } from "@/features/git/diff/diff-ui";
import { EmptyCard } from "@/features/git/commit/empty-card";
import { cn } from "@/lib/utils";
import { confirmDialog } from "@/components/confirm";
import { useRepo } from "@/features/git/repository-store";
import {
  ancestorFolders,
  buildBranchTree,
  leafCount,
  type BranchTreeNode,
} from "@/features/git/branch-tree";
import { useGraph } from "@/features/git/graph/store";
import { useUi } from "@/features/git/ui-store";
import { useUndo, type UndoKind } from "@/features/git/history/undoStore";
import { useForge } from "@/features/git/forge/store";
import { useGitSettings } from "@/features/git/settings/store";
import { closeRepoTabs } from "@/features/git/repository/tabs";
import { remoteWebUrl } from "@/lib/git-core";
import { pullRequestCheckoutSpec } from "@/lib/git-core/forge";
import type { ForgeKind, PullRequestInfo } from "@/lib/git-core/forge";
import type {
  BranchInfo,
  RemoteInfo,
  StashInfo,
  SubmoduleInfo,
  TagInfo,
  WorktreeInfo,
} from "@/lib/git-core";
import { capCount, isMac } from "@/features/git/utils";
import { killTerminalSession } from "@/features/git/terminal/sessions";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  branchCheckout,
  branchDelete,
  branchMerge,
  branchRebase,
  checkoutDetached,
  mergeCanFf,
  prCheckout,
  remoteAdd,
  remoteEdit,
  remoteFetch,
  remotePullBranch,
  remotePush,
  remotePushTag,
  remoteRemove,
  repoInfo,
  revealPath,
  stashApply,
  stashDrop,
  stashPop,
  submoduleUpdate,
  tagDelete,
  worktreePrune,
  worktreeRemove,
} from "@/commands";

function HeadMark({ active }: { active: boolean }) {
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center">
      {active && <Check className="size-3.5" />}
    </span>
  );
}

const outcomeOk = (result: unknown) => {
  const status = (result as { status?: string } | undefined)?.status;
  return status === undefined || status === "ok" || status === "fast_forward";
};

const FLAT_FILTER_CAP = 300;

export const SIDEBAR_SECTIONS = [
  "branches",
  "worktrees",
  "pullRequests",
  "remotes",
  "tags",
  "stashes",
  "submodules",
] as const;

function Section({
  icon,
  title,
  count,
  children,
  open,
  onToggle,
  action,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  children: ReactNode;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
}) {
  return (
    <div
      data-sidebar-section
      className={cn("flex flex-col", open ? "min-h-[5.5rem] shrink" : "shrink-0")}
    >
      <div
        data-sidebar-section-header
        className="group text-foreground/80 hover:bg-accent flex w-full shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold tracking-wide uppercase"
      >
        <button
          className="flex min-w-0 flex-1 items-center gap-2"
          aria-expanded={open}
          onClick={onToggle}
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 transition-transform duration-150",
              open && "rotate-90"
            )}
          />
          <span
            data-sidebar-section-icon
            className="bg-primary/15 text-primary flex size-5 shrink-0 items-center justify-center rounded"
          >
            {icon}
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        </button>
        {action && (
          <span className="flex w-0 min-w-0 items-center overflow-hidden group-focus-within:w-auto group-hover:w-auto">
            {action}
          </span>
        )}
        <Badge
          variant="secondary"
          className="bg-foreground/[0.08] h-4 min-w-4 shrink-0 cursor-pointer justify-center border-transparent px-1.5 text-[10px] leading-none tabular-nums"
          onClick={onToggle}
        >
          {count}
        </Badge>
      </div>
      {open && (
        <div data-sidebar-section-body className="mt-0.5 min-h-0 flex-1 overflow-y-auto pb-1">
          {children}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { t } = useAppTranslation();
  const forgeWords = (
    kind: ForgeKind | null | undefined,
    options: { plural?: boolean; capitalize?: boolean } = {}
  ) => {
    const merge = kind === "gitlab";
    if (options.capitalize)
      return t(
        merge
          ? "gitRepo.sidebar.forge.mergeRequestsPlural"
          : "gitRepo.sidebar.forge.pullRequestsPlural"
      );
    if (options.plural)
      return t(
        merge
          ? "gitRepo.sidebar.forge.mergeRequestsLower"
          : "gitRepo.sidebar.forge.pullRequestsLower"
      );
    return t(
      merge
        ? "gitRepo.sidebar.forge.mergeRequestSingular"
        : "gitRepo.sidebar.forge.pullRequestSingular"
    );
  };

  const repo = useRepo((s) => s.repo);
  const branches = useRepo((s) => s.branches);
  const tags = useRepo((s) => s.tags);
  const stashes = useRepo((s) => s.stashes);
  const remotes = useRepo((s) => s.remotes);
  const submodules = useRepo((s) => s.submodules);
  const worktrees = useRepo((s) => s.worktrees);
  const status = useRepo((s) => s.status);
  const refresh = useRepo((s) => s.refresh);
  const repoRefreshing = useRepo((s) => s.refreshing);
  const graphReload = useGraph((s) => s.reload);
  const setFilters = useGraph((s) => s.setFilters);
  const filters = useGraph((s) => s.filters);
  const openDialog = useUi((s) => s.openDialog);
  const sidebarSections = useUi((s) => s.sidebarSections);
  const setSidebarSection = useUi((s) => s.setSidebarSection);
  const collapseEpoch = useUi((s) => s.sidebarCollapseEpoch);
  const sectionDefaults: Record<(typeof SIDEBAR_SECTIONS)[number], boolean> = {
    branches: true,
    worktrees: true,
    pullRequests: true,
    remotes: false,
    tags: false,
    stashes: stashes.length > 0,
    submodules: false,
  };
  const sectionOpen = (id: (typeof SIDEBAR_SECTIONS)[number]) =>
    sidebarSections[id] ?? sectionDefaults[id];
  const section = (id: (typeof SIDEBAR_SECTIONS)[number]) => ({
    open: sectionOpen(id),
    onToggle: () => setSidebarSection(id, !sectionOpen(id)),
  });
  const [query, setQuery] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  useEffect(() => {
    const handle = window.setTimeout(() => setFilterQuery(query), 150);
    return () => window.clearTimeout(handle);
  }, [query]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dropAction, setDropAction] = useState<{
    source: string;
    target: string;
    canFf?: boolean;
  } | null>(null);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; branch: BranchInfo } | null>(
    null
  );
  const [branchMenuFf, setBranchMenuFf] = useState<boolean | null>(null);
  const [subMenu, setSubMenu] = useState<{ x: number; y: number; sub: SubmoduleInfo } | null>(null);
  const [remoteMenu, setRemoteMenu] = useState<{ x: number; y: number; remote: RemoteInfo } | null>(
    null
  );
  const [worktreeMenu, setWorktreeMenu] = useState<{
    x: number;
    y: number;
    worktree: WorktreeInfo;
  } | null>(null);
  const [stashMenu, setStashMenu] = useState<{ x: number; y: number; stash: StashInfo } | null>(
    null
  );
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; tag: TagInfo } | null>(null);
  const [prMenu, setPrMenu] = useState<{ x: number; y: number; pr: PullRequestInfo } | null>(null);
  const [editRemote, setEditRemote] = useState<{
    original: string | null;
    name: string;
    url: string;
  } | null>(null);
  const [savingRemote, setSavingRemote] = useState(false);

  const path = repo?.path ?? "";

  const openSubmodule = (sub: SubmoduleInfo) => {
    void useRepo
      .getState()
      .open(`${path}/${sub.path}`)
      .catch(() => toast.error(t("gitRepo.sidebar.toast.submoduleOpen", { path: sub.path })));
  };

  const heldBy = useMemo(() => {
    const map = new Map<string, WorktreeInfo>();
    for (const wt of worktrees) if (wt.branch && !wt.isCurrent) map.set(wt.branch, wt);
    return map;
  }, [worktrees]);
  const worktreeDirty = (wt: WorktreeInfo) =>
    wt.isCurrent ? (status?.files.length ?? 0) > 0 : wt.isDirty === true;
  const openWorktree = (wt: WorktreeInfo) => {
    if (wt.isCurrent || wt.isMissing) return;
    void useRepo
      .getState()
      .open(wt.path)
      .catch((error) =>
        toast.error(
          t("gitRepo.sidebar.toast.worktreeOpen", {
            name: wt.name,
            error: (error as { message?: string }).message ?? String(error),
          })
        )
      );
  };

  const refreshAll = async () => {
    await refresh();
    await graphReload(path);
  };

  const act = async (
    label: string,
    op: () => Promise<unknown>,
    undoable?: { kind: UndoKind; extra?: Record<string, string> }
  ) => {
    try {
      const result = undoable
        ? await useUndo.getState().tracked({
            path,
            kind: undoable.kind,
            label,
            extra: undoable.extra,
            action: op,
            shouldRecord: outcomeOk,
          })
        : await op();
      toastOutcome(
        result as { status?: string; message?: string } | undefined,
        t("gitRepo.sidebar.toast.done", { label })
      );
      await refreshAll();
    } catch (error) {
      toast.error(
        t("gitRepo.sidebar.toast.failed", {
          label,
          error: (error as { message?: string }).message ?? String(error),
        })
      );
    }
  };

  const removeWorktree = async (wt: WorktreeInfo) => {
    if (wt.isMain) return;
    if (wt.isMissing) {
      await act(t("gitRepo.sidebar.label.worktreeForget", { name: wt.name }), () =>
        worktreeRemove(path, wt.name, false)
      );
      return;
    }
    const dirty = worktreeDirty(wt);
    const note = wt.branch
      ? t("gitRepo.sidebar.removeWorktree.branchNote", { branch: wt.branch })
      : t("gitRepo.sidebar.removeWorktree.note");
    const ok = await confirmDialog({
      title: t("gitRepo.sidebar.removeWorktree.title", { name: wt.name }),
      description: dirty
        ? t("gitRepo.sidebar.removeWorktree.dirty", { note })
        : t("gitRepo.sidebar.removeWorktree.clean", { note }),
      path: wt.path,
      confirmLabel: dirty
        ? t("gitRepo.sidebar.removeWorktree.confirmDirty")
        : t("gitRepo.sidebar.removeWorktree.confirm"),
      destructive: true,
    });
    if (!ok) return;
    if (!wt.isCurrent) {
      await act(t("gitRepo.sidebar.label.worktreeRemove", { name: wt.name }), () =>
        worktreeRemove(path, wt.name, dirty)
      );
      return;
    }
    const main = worktrees.find((w) => w.isMain);
    if (!main) return;
    try {
      await useRepo.getState().open(main.path);
    } catch (error) {
      toast.error(
        t("gitRepo.sidebar.toast.worktreeSwitch", {
          name: main.name,
          error: (error as { message?: string }).message ?? String(error),
        })
      );
      return;
    }
    closeRepoTabs([wt.path]);
    killTerminalSession(wt.path);
    try {
      await worktreeRemove(main.path, wt.name, dirty);
      toast.success(t("gitRepo.sidebar.toast.worktreeRemoved", { name: wt.name }));
      await useRepo.getState().refresh();
      await graphReload(main.path);
    } catch (error) {
      toast.error(
        t("gitRepo.sidebar.toast.failed", {
          label: t("gitRepo.sidebar.label.worktreeRemove", { name: wt.name }),
          error: (error as { message?: string }).message ?? String(error),
        })
      );
    }
  };

  const dropMerge = async (source: string, target: string, noFf: boolean) => {
    setDropAction(null);
    try {
      const info = await repoInfo(path);
      if (info.headBranch !== target) {
        await useUndo.getState().tracked({
          path,
          kind: "checkout",
          label: t("gitRepo.sidebar.label.checkout", { name: target }),
          action: () => branchCheckout(path, target),
        });
      }
      await act(
        t("gitRepo.sidebar.label.mergeInto", { source, target }),
        () => branchMerge(path, source, noFf),
        {
          kind: "merge",
        }
      );
    } catch (error) {
      toast.error(
        t("gitRepo.sidebar.toast.mergeFailed", {
          error: (error as { message?: string }).message ?? String(error),
        })
      );
    }
  };

  const dropRebase = async (source: string, target: string) => {
    setDropAction(null);
    try {
      const info = await repoInfo(path);
      if (info.headBranch !== source) {
        await useUndo.getState().tracked({
          path,
          kind: "checkout",
          label: t("gitRepo.sidebar.label.checkout", { name: source }),
          action: () => branchCheckout(path, source),
        });
      }
      await act(
        t("gitRepo.sidebar.label.rebaseOnto", { source, target }),
        () => branchRebase(path, target),
        {
          kind: "rebase",
        }
      );
    } catch (error) {
      toast.error(
        t("gitRepo.sidebar.toast.rebaseFailed", {
          error: (error as { message?: string }).message ?? String(error),
        })
      );
    }
  };

  const forgeRepoPath = useForge((s) => s.repoPath);
  const forgeRemote = useForge((s) => s.remote);
  const forgeRemoteName = useForge((s) => s.remoteName);
  const forgeAccount = useForge((s) => s.hasAccount);
  const forgePrs = useForge((s) => s.prs);
  const forgeLoading = useForge((s) => s.loading);
  const forgeError = useForge((s) => s.error);
  const forgeErrorDetail = useForge((s) => s.errorDetail);
  const forgeLoadedAt = useForge((s) => s.loadedAt);
  const showPullRequests = useGitSettings((s) => s.showPullRequests);

  const checkoutPullRequest = (pr: PullRequestInfo) => {
    const spec = forgeRemote ? pullRequestCheckoutSpec(forgeRemote.kind, pr) : null;
    if (!spec) {
      toast.error(
        t("gitRepo.sidebar.toast.cannotCheckout", { noun: forgeWords(forgeRemote?.kind) })
      );
      return;
    }
    void act(
      t("gitRepo.sidebar.label.checkoutPr", { number: pr.number }),
      () =>
        prCheckout(path, forgeRemoteName ?? "origin", spec.sourceRef, spec.localBranch, spec.track),
      { kind: "checkout" }
    );
  };

  const q = filterQuery.trim().toLowerCase();
  const locals = useMemo(
    () => branches.filter((b) => !b.isRemote && (!q || b.name.toLowerCase().includes(q))),
    [branches, q]
  );
  const remoteBranches = useMemo(
    () => branches.filter((b) => b.isRemote && (!q || b.name.toLowerCase().includes(q))),
    [branches, q]
  );
  const filteredTags = useMemo(
    () => tags.filter((tag) => !q || tag.name.toLowerCase().includes(q)),
    [tags, q]
  );
  const filteredWorktrees = useMemo(
    () =>
      worktrees.filter(
        (w) => !q || w.name.toLowerCase().includes(q) || (w.branch ?? "").toLowerCase().includes(q)
      ),
    [worktrees, q]
  );
  const filteredPrs = useMemo(
    () =>
      forgePrs.filter(
        (pr) =>
          !q ||
          pr.title.toLowerCase().includes(q) ||
          pr.sourceBranch.toLowerCase().includes(q) ||
          `#${pr.number}`.includes(q)
      ),
    [forgePrs, q]
  );

  const localTree = useMemo(() => buildBranchTree(locals), [locals]);
  const remoteTree = useMemo(() => buildBranchTree(remoteBranches), [remoteBranches]);

  const noFilterMatches =
    q !== "" &&
    locals.length === 0 &&
    remoteBranches.length === 0 &&
    filteredTags.length === 0 &&
    stashes.length === 0;
  const hasRemoteBranches = branches.some((b) => b.isRemote);

  const submitEditRemote = async () => {
    const edit = editRemote;
    if (!edit || !edit.name.trim() || !edit.url.trim() || savingRemote) return;
    setSavingRemote(true);
    const original = edit.original;
    if (original === null) {
      const name = edit.name.trim();
      await act(t("gitRepo.sidebar.label.addRemote", { name }), async () => {
        await remoteAdd(path, name, edit.url);
        return remoteFetch(path, name, true, false);
      });
    } else {
      await act(t("gitRepo.sidebar.label.updateRemote", { name: original }), () =>
        remoteEdit(path, original, edit.name, edit.url)
      );
    }
    setSavingRemote(false);
    setEditRemote(null);
  };
  const openAddRemote = () =>
    setEditRemote({ original: null, name: remotes.length === 0 ? "origin" : "", url: "" });

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  useEffect(() => {
    const head = branches.find((b) => b.isHead);
    if (!head) return;
    const paths = ancestorFolders(head.name);
    if (paths.length > 0) {
      setExpandedFolders((prev) =>
        paths.every((p) => prev.has(p)) ? prev : new Set([...prev, ...paths])
      );
    }
  }, [branches]);
  useEffect(() => {
    if (collapseEpoch > 0) setExpandedFolders(new Set());
  }, [collapseEpoch]);
  const anySectionOpen = SIDEBAR_SECTIONS.some(sectionOpen);
  const showPullRequestSection = Boolean(
    forgeRemote && showPullRequests && forgeRepoPath === repo?.path
  );
  const visibleSections: (typeof SIDEBAR_SECTIONS)[number][] = [
    "branches",
    "worktrees",
    ...(showPullRequestSection ? (["pullRequests"] as const) : []),
    "remotes",
    "tags",
    "stashes",
    ...(submodules.length > 0 ? (["submodules"] as const) : []),
  ];
  const lastOpenSection = [...visibleSections].reverse().find(sectionOpen) ?? null;
  const spacerAfter = (id: (typeof SIDEBAR_SECTIONS)[number]) =>
    lastOpenSection === id ? <div key={`spacer:${id}`} className="min-h-0 flex-1" /> : null;
  const collapseAll = () => {
    useUi.getState().collapseSidebarSections(SIDEBAR_SECTIONS);
    setExpandedFolders(new Set());
  };
  const toggleFolder = (folderPath: string) =>
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });

  const branchMenuSource = branchMenu?.branch.isHead ? null : (branchMenu?.branch.name ?? null);
  useEffect(() => {
    setBranchMenuFf(null);
    if (!branchMenuSource) return;
    const head = useRepo.getState().repo?.headBranch;
    if (!head) {
      setBranchMenuFf(false);
      return;
    }
    let cancelled = false;
    void mergeCanFf(path, head, branchMenuSource)
      .then((ok) => !cancelled && setBranchMenuFf(ok))
      .catch(() => !cancelled && setBranchMenuFf(false));
    return () => {
      cancelled = true;
    };
  }, [path, branchMenuSource]);

  if (!repo) return null;

  const branchMenuLocalName = branchMenu
    ? branchMenu.branch.isRemote
      ? branchMenu.branch.name.split("/").slice(1).join("/")
      : branchMenu.branch.name
    : "";
  const branchMenuHeld = branchMenu ? heldBy.get(branchMenuLocalName) : undefined;

  const renderWorktree = (wt: WorktreeInfo) => {
    const dirty = worktreeDirty(wt);
    const subtitle = wt.isMissing
      ? t("gitRepo.sidebar.worktreeRow.folderMissing")
      : wt.isDetached
        ? t("gitRepo.sidebar.worktreeRow.detached", { oid: wt.headOid?.slice(0, 8) ?? "?" })
        : (wt.branch ?? t("gitRepo.sidebar.worktreeRow.noBranch"));
    return (
      <div
        key={wt.path}
        role="button"
        tabIndex={0}
        onClick={() => openWorktree(wt)}
        onKeyDown={(e) => {
          if (e.key === "Enter") openWorktree(wt);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setWorktreeMenu({ x: e.clientX, y: e.clientY, worktree: wt });
        }}
        className={cn(
          "group hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1 pl-7 text-sm",
          wt.isCurrent
            ? "text-primary cursor-default"
            : wt.isMissing
              ? "text-muted-foreground cursor-default"
              : "cursor-pointer"
        )}
        title={
          wt.isMissing
            ? t("gitRepo.sidebar.worktreeRow.titleMissing", { path: wt.path })
            : wt.isCurrent
              ? t("gitRepo.sidebar.worktreeRow.titleCurrent", { path: wt.path })
              : t("gitRepo.sidebar.worktreeRow.titleOpen", { path: wt.path })
        }
      >
        <HeadMark active={wt.isCurrent} />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">{wt.name}</span>
            {wt.isMain && (
              <Home
                className="text-muted-foreground/70 size-3 shrink-0"
                aria-label={t("gitRepo.sidebar.worktreeRow.main")}
              />
            )}
            {wt.isLocked && (
              <Lock
                className="text-muted-foreground/70 size-3 shrink-0"
                aria-label={t("gitRepo.sidebar.worktreeRow.locked")}
              />
            )}
            {wt.isMissing ? (
              <AlertTriangle
                className="text-destructive size-3 shrink-0"
                aria-label={t("gitRepo.sidebar.worktreeRow.missingAria")}
              />
            ) : dirty ? (
              <span
                className="bg-primary size-1.5 shrink-0 rounded-full"
                aria-label={t("gitRepo.sidebar.worktreeRow.uncommitted")}
              />
            ) : null}
          </span>
          <span className="text-muted-foreground/70 truncate font-mono text-[10px]">
            {subtitle}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={t("gitRepo.sidebar.worktreeRow.actions", { name: wt.name })}
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            setWorktreeMenu({ x: rect.left, y: rect.bottom + 4, worktree: wt });
          }}
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </div>
    );
  };

  const renderLocalBranch = (branch: BranchInfo, label: string, depth: number) => (
    <div
      key={branch.name}
      draggable
      onDragStart={(e) => {
        setDragging(branch.name);
        e.dataTransfer.setData("text/git-branch", branch.name);
        e.dataTransfer.effectAllowed = "link";
      }}
      onDragEnd={() => {
        setDragging(null);
        setDropTarget(null);
      }}
      onDragOver={(e) => {
        const source = dragging;
        if (source && source !== branch.name) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "link";
          setDropTarget((t) => (t === branch.name ? t : branch.name));
        }
      }}
      onDragLeave={() => setDropTarget((t) => (t === branch.name ? null : t))}
      onDrop={(e) => {
        e.preventDefault();
        const source = e.dataTransfer.getData("text/git-branch");
        setDropTarget(null);
        setDragging(null);
        if (source && source !== branch.name) {
          const target = branch.name;
          setDropAction({ source, target });
          void mergeCanFf(path, target, source)
            .then((canFf) => {
              setDropAction((cur) =>
                cur && cur.source === source && cur.target === target ? { ...cur, canFf } : cur
              );
            })
            .catch(() => undefined);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setBranchMenu({ x: e.clientX, y: e.clientY, branch });
      }}
      style={{ paddingLeft: 28 + depth * 14 }}
      className={cn(
        "group hover:bg-accent relative flex cursor-grab items-center gap-2 rounded-md px-2 py-1 text-sm active:cursor-grabbing",
        filters.branch === branch.name && "bg-accent",
        branch.isHead &&
          "text-primary before:bg-primary font-medium before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full",
        branch.isHead &&
          (filters.branch === branch.name
            ? "bg-primary/20 hover:bg-primary/25"
            : "bg-primary/10 hover:bg-primary/15"),
        dragging === branch.name && "opacity-40",
        dropTarget === branch.name && "bg-primary/10 ring-primary/60 ring-1 ring-inset"
      )}
      title={t("gitRepo.sidebar.branch.dragHint", { name: branch.name })}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onDoubleClick={() => {
          const held = heldBy.get(branch.name);
          if (held) openWorktree(held);
          else
            void act(
              t("gitRepo.sidebar.label.checkout", { name: branch.name }),
              () => branchCheckout(path, branch.name),
              {
                kind: "checkout",
              }
            );
        }}
        onClick={() =>
          setFilters(path, { branch: filters.branch === branch.name ? "" : branch.name })
        }
        title={
          heldBy.has(branch.name)
            ? t("gitRepo.sidebar.branch.heldHint", {
                name: branch.name,
                worktree: heldBy.get(branch.name)?.name ?? "",
              })
            : t("gitRepo.sidebar.branch.clickHint", { name: branch.name })
        }
      >
        <HeadMark active={branch.isHead} />
        <span className="min-w-0 truncate">{label}</span>
        {heldBy.has(branch.name) && (
          <FolderTree
            className="text-muted-foreground/70 size-3 shrink-0"
            aria-label={t("gitRepo.sidebar.branch.heldAria", {
              worktree: heldBy.get(branch.name)?.name ?? "",
            })}
          />
        )}
        {branch.ahead > 0 && <Badge variant="default">↑{capCount(branch.ahead)}</Badge>}
        {branch.behind > 0 && <Badge variant="outline">↓{capCount(branch.behind)}</Badge>}
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={t("gitRepo.sidebar.worktreeRow.actions", { name: branch.name })}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          setBranchMenu({ x: rect.left, y: rect.bottom + 4, branch });
        }}
      >
        <MoreHorizontal className="size-3.5" />
      </Button>
    </div>
  );

  const renderRemoteBranch = (branch: BranchInfo, label: string, depth: number) => (
    <div
      key={branch.name}
      draggable
      onDragStart={(e) => {
        setDragging(branch.name);
        e.dataTransfer.setData("text/git-branch", branch.name);
        e.dataTransfer.effectAllowed = "link";
      }}
      onDragEnd={() => {
        setDragging(null);
        setDropTarget(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setBranchMenu({ x: e.clientX, y: e.clientY, branch });
      }}
      style={{ paddingLeft: 28 + depth * 14 }}
      className={cn(
        "group text-muted-foreground hover:bg-accent flex cursor-grab items-center gap-2 rounded-md px-2 py-1 text-sm active:cursor-grabbing",
        dragging === branch.name && "opacity-40"
      )}
      title={t("gitRepo.sidebar.branch.dragHintRemote", { name: branch.name })}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onDoubleClick={() =>
          void act(
            t("gitRepo.sidebar.label.checkout", { name: branch.name }),
            () => branchCheckout(path, branch.name),
            {
              kind: "checkout",
            }
          )
        }
        title={t("gitRepo.sidebar.branch.remoteCheckoutHint", {
          name: branch.name,
          local: branch.name.split("/").slice(1).join("/"),
        })}
      >
        <HeadMark active={false} />
        <span className="min-w-0 truncate">{label}</span>
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={t("gitRepo.sidebar.worktreeRow.actions", { name: branch.name })}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          setBranchMenu({ x: rect.left, y: rect.bottom + 4, branch });
        }}
      >
        <MoreHorizontal className="size-3.5" />
      </Button>
    </div>
  );

  const renderTree = (
    nodes: BranchTreeNode[],
    depth: number,
    kind: "local" | "remote"
  ): ReactNode =>
    nodes.map((node) => {
      if (node.branch) {
        return kind === "local"
          ? renderLocalBranch(node.branch, node.key, depth)
          : renderRemoteBranch(node.branch, node.key, depth);
      }
      const expanded = expandedFolders.has(node.path);
      const remote =
        kind === "remote" && depth === 0 ? remotes.find((r) => r.name === node.key) : undefined;
      return (
        <div key={`folder:${node.path}`}>
          <div
            className="group hover:bg-accent flex items-center rounded-md"
            onContextMenu={
              remote
                ? (e) => {
                    e.preventDefault();
                    setRemoteMenu({ x: e.clientX, y: e.clientY, remote });
                  }
                : undefined
            }
          >
            <button
              className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-sm"
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => toggleFolder(node.path)}
              title={
                remote
                  ? t("gitRepo.sidebar.branch.remoteTitle", { name: remote.name, url: remote.url })
                  : node.path
              }
            >
              <ChevronRight
                className={cn(
                  "text-muted-foreground/70 size-3.5 shrink-0 transition-transform duration-150",
                  expanded && "rotate-90"
                )}
              />
              {remote ? (
                <Cloud
                  className={cn(
                    "size-3.5 shrink-0",
                    expanded ? "text-primary/70" : "text-muted-foreground/70"
                  )}
                />
              ) : expanded ? (
                <FolderOpen className="text-primary/70 size-3.5 shrink-0" />
              ) : (
                <Folder className="text-muted-foreground/70 size-3.5 shrink-0" />
              )}
              <span className="min-w-0 truncate">{node.key}</span>
              <span className="text-muted-foreground/70 text-[10px]">{leafCount(node)}</span>
            </button>
            {remote && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="mr-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t("gitRepo.sidebar.branch.remoteActions", { name: remote.name })}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setRemoteMenu({ x: rect.left, y: rect.bottom + 4, remote });
                }}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            )}
          </div>
          {expanded && renderTree(node.children, depth + 1, kind)}
        </div>
      );
    });

  const renderBranchlessRemote = (remote: RemoteInfo) => (
    <div
      key={`remote:${remote.name}`}
      className="group hover:bg-accent flex items-center rounded-md"
      onContextMenu={(e) => {
        e.preventDefault();
        setRemoteMenu({ x: e.clientX, y: e.clientY, remote });
      }}
    >
      <div
        className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-sm"
        style={{ paddingLeft: 10 }}
        title={t("gitRepo.sidebar.branch.remoteNoBranches", { name: remote.name, url: remote.url })}
      >
        <span className="size-3.5 shrink-0" />
        <Cloud className="text-muted-foreground/70 size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{remote.name}</span>
        <span className="text-muted-foreground/70 text-[10px]">0</span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="mr-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={t("gitRepo.sidebar.branch.remoteActions", { name: remote.name })}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          setRemoteMenu({ x: rect.left, y: rect.bottom + 4, remote });
        }}
      >
        <MoreHorizontal className="size-3.5" />
      </Button>
    </div>
  );

  return (
    <aside
      className="bg-card flex h-full flex-col"
      aria-label={t("gitRepo.sidebar.rail.ariaLabel")}
    >
      <div className="flex items-center gap-1 p-2">
        <div className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground/70 absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("gitRepo.sidebar.rail.filterPlaceholder")}
            className="bg-accent h-7 border-transparent pl-8 text-xs"
          />
        </div>
        <Hint label={t("gitRepo.sidebar.rail.collapseAll")}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground/70 hover:text-foreground shrink-0"
            aria-label={t("gitRepo.sidebar.rail.collapseAll")}
            disabled={!anySectionOpen && expandedFolders.size === 0}
            onClick={collapseAll}
          >
            <ChevronsDownUp className="size-3.5" />
          </Button>
        </Hint>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <Section
          {...section("branches")}
          icon={<GitBranch className="size-3.5" />}
          title={t("gitRepo.sidebar.sections.branches")}
          count={locals.length}
          action={
            <Hint label={t("gitRepo.sidebar.actions.newBranch")}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("gitRepo.sidebar.actions.newBranch")}
                onClick={() => openDialog("createBranch")}
              >
                <Plus className="size-3.5" />
              </Button>
            </Hint>
          }
        >
          {repoRefreshing && locals.length === 0 && (
            <div className="flex flex-col gap-1.5 py-1 pr-3 pl-7">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-accent h-4 animate-pulse rounded" />
              ))}
            </div>
          )}
          {q
            ? locals
                .slice(0, FLAT_FILTER_CAP)
                .map((branch) => renderLocalBranch(branch, branch.name, 0))
            : renderTree(localTree, 0, "local")}
          {q && locals.length > FLAT_FILTER_CAP && (
            <div className="text-muted-foreground/70 px-2 py-1 pl-7 text-xs">
              {t("gitRepo.sidebar.list.more", { count: locals.length - FLAT_FILTER_CAP })}
            </div>
          )}
          {noFilterMatches && (
            <div className="text-muted-foreground/70 px-2 py-1 pl-7 text-xs">
              {t("gitRepo.sidebar.list.noRefsMatch")}
            </div>
          )}
        </Section>
        {spacerAfter("branches")}

        <Section
          {...section("worktrees")}
          icon={<FolderTree className="size-3.5" />}
          title={t("gitRepo.sidebar.sections.worktrees")}
          count={worktrees.length}
          action={
            <span className="flex items-center">
              {worktrees.some((w) => w.isMissing) && (
                <Hint label={t("gitRepo.sidebar.actions.pruneHint")}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("gitRepo.sidebar.actions.pruneAria")}
                    onClick={() =>
                      void act(t("gitRepo.sidebar.label.worktreePrune"), () => worktreePrune(path))
                    }
                  >
                    <Eraser className="size-3.5" />
                  </Button>
                </Hint>
              )}
              <Hint label={t("gitRepo.sidebar.actions.newWorktree")}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("gitRepo.sidebar.actions.newWorktree")}
                  onClick={() => openDialog("createWorktree")}
                >
                  <Plus className="size-3.5" />
                </Button>
              </Hint>
            </span>
          }
        >
          {repoRefreshing && worktrees.length === 0 && (
            <div className="flex flex-col gap-1.5 py-1 pr-3 pl-7">
              {[0, 1].map((i) => (
                <div key={i} className="bg-accent h-4 animate-pulse rounded" />
              ))}
            </div>
          )}
          {!repoRefreshing && worktrees.length <= 1 && (
            <EmptyCard
              icon={<FolderTree />}
              title={t("gitRepo.sidebar.empty.worktreesTitle")}
              description={t("gitRepo.sidebar.empty.worktreesDescription")}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => openDialog("createWorktree")}
                >
                  <Plus className="size-3.5" /> {t("gitRepo.sidebar.actions.newWorktree")}
                </Button>
              }
            />
          )}
          {worktrees.length > 1 && filteredWorktrees.map(renderWorktree)}
          {worktrees.length > 1 && q && filteredWorktrees.length === 0 && (
            <div className="text-muted-foreground/70 px-2 py-1 pl-7 text-xs">
              {t("gitRepo.sidebar.list.noWorktreesMatch")}
            </div>
          )}
        </Section>
        {spacerAfter("worktrees")}

        {showPullRequestSection && forgeRemote && (
          <>
            <Section
              {...section("pullRequests")}
              icon={<GitPullRequest className="size-3.5" />}
              title={forgeWords(forgeRemote.kind, { plural: true, capitalize: true })}
              count={filteredPrs.length}
              action={
                <span className="flex items-center">
                  <Hint label={t("gitRepo.sidebar.actions.refreshPrs")}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("gitRepo.sidebar.actions.refreshPrs")}
                      onClick={() => void useForge.getState().load(true)}
                    >
                      <RefreshCw className={cn("size-3.5", forgeLoading && "animate-spin")} />
                    </Button>
                  </Hint>
                  <Hint label={t("gitRepo.sidebar.actions.createPr")}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("gitRepo.sidebar.actions.createPr")}
                      onClick={() => openDialog("createPullRequest")}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </Hint>
                </span>
              }
            >
              {!forgeAccount && forgeLoadedAt !== null && (
                <button
                  className="text-muted-foreground hover:bg-accent w-full rounded-md px-2 py-1 pl-7 text-left text-xs [overflow-wrap:anywhere]"
                  onClick={() => openDialog("settings")}
                >
                  {t("gitRepo.sidebar.pr.connect", {
                    host: forgeRemote.host,
                    noun: forgeWords(forgeRemote.kind, { plural: true }),
                  })}
                </button>
              )}
              {forgeAccount && forgeError && (
                <button
                  className="text-muted-foreground hover:bg-accent w-full rounded-md px-2 py-1 pl-7 text-left text-xs [overflow-wrap:anywhere]"
                  title={forgeErrorDetail ?? forgeError}
                  onClick={() => void useForge.getState().load(true)}
                >
                  {forgeError}
                  <span className="text-primary mt-0.5 block">{t("gitRepo.sidebar.pr.retry")}</span>
                </button>
              )}
              {forgeAccount && !forgeError && filteredPrs.length === 0 && !forgeLoading && (
                <div className="text-muted-foreground/70 px-2 py-1 pl-7 text-xs">
                  {t("gitRepo.sidebar.pr.none", {
                    noun: forgeWords(forgeRemote.kind, { plural: true }),
                  })}
                </div>
              )}
              {forgeLoading && filteredPrs.length === 0 && (
                <div className="text-muted-foreground/70 flex items-center gap-2 px-2 py-1 pl-7 text-xs">
                  <RefreshCw className="size-3.5 shrink-0 animate-spin" />
                  {t("gitRepo.sidebar.pr.loading")}
                </div>
              )}
              {filteredPrs.map((pr) => (
                <div
                  key={pr.number}
                  className="group hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1 pl-7 text-sm"
                  title={t("gitRepo.sidebar.pr.rowTitle", {
                    number: pr.number,
                    title: pr.title,
                    author: pr.author,
                    source: pr.sourceBranch,
                    target: pr.targetBranch,
                  })}
                  onDoubleClick={() => checkoutPullRequest(pr)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPrMenu({ x: e.clientX, y: e.clientY, pr });
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="text-muted-foreground/70">#{pr.number}</span> {pr.title}
                  </span>
                  {pr.isDraft && (
                    <Badge variant="secondary">{t("gitRepo.sidebar.list.draft")}</Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t("gitRepo.sidebar.pr.actions", { number: pr.number })}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setPrMenu({ x: rect.left, y: rect.bottom + 4, pr });
                    }}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </div>
              ))}
            </Section>
            {spacerAfter("pullRequests")}
          </>
        )}

        <Section
          {...section("remotes")}
          icon={<Cloud className="size-3.5" />}
          title={t("gitRepo.sidebar.sections.remotes")}
          count={remoteBranches.length}
          action={
            <Hint label={t("gitRepo.sidebar.actions.addRemote")}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("gitRepo.sidebar.actions.addRemote")}
                onClick={openAddRemote}
              >
                <Plus className="size-3.5" />
              </Button>
            </Hint>
          }
        >
          {remotes.length === 0 && !hasRemoteBranches && !repoRefreshing && (
            <EmptyCard
              icon={<Cloud />}
              title={t("gitRepo.sidebar.empty.remotesTitle")}
              description={t("gitRepo.sidebar.empty.remotesDescription")}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full justify-center"
                  onClick={openAddRemote}
                >
                  <Plus className="size-3.5" /> {t("gitRepo.sidebar.actions.addRemote")}
                </Button>
              }
            />
          )}
          {q
            ? remoteBranches
                .slice(0, FLAT_FILTER_CAP)
                .map((branch) => renderRemoteBranch(branch, branch.name, 0))
            : renderTree(remoteTree, 0, "remote")}
          {q && remoteBranches.length > FLAT_FILTER_CAP && (
            <div className="text-muted-foreground/70 px-2 py-1 pl-7 text-xs">
              {t("gitRepo.sidebar.list.more", { count: remoteBranches.length - FLAT_FILTER_CAP })}
            </div>
          )}
          {!q &&
            remotes
              .filter((r) => !remoteTree.some((node) => !node.branch && node.key === r.name))
              .map(renderBranchlessRemote)}
        </Section>
        {spacerAfter("remotes")}

        <Section
          icon={<TagIcon className="size-3.5" />}
          title={t("gitRepo.sidebar.sections.tags")}
          count={filteredTags.length}
          {...section("tags")}
          action={
            <Hint label={t("gitRepo.sidebar.actions.newTag")}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("gitRepo.sidebar.actions.newTag")}
                onClick={() => openDialog("createTag")}
              >
                <Plus className="size-3.5" />
              </Button>
            </Hint>
          }
        >
          {tags.length === 0 && !repoRefreshing && (
            <EmptyCard
              icon={<TagIcon />}
              title={t("gitRepo.sidebar.empty.tagsTitle")}
              description={t("gitRepo.sidebar.empty.tagsDescription")}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => openDialog("createTag")}
                >
                  <Plus className="size-3.5" /> {t("gitRepo.sidebar.actions.newTag")}
                </Button>
              }
            />
          )}
          {filteredTags.map((tag) => (
            <div
              key={tag.name}
              className="group hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 pl-7 text-sm"
              onClick={() => useGraph.getState().select(tag.targetOid)}
              onContextMenu={(e) => {
                e.preventDefault();
                setTagMenu({ x: e.clientX, y: e.clientY, tag });
              }}
            >
              <span
                className="min-w-0 flex-1 truncate"
                title={t("gitRepo.sidebar.list.tagHint", { message: tag.message ?? tag.name })}
              >
                {tag.name}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t("gitRepo.sidebar.worktreeRow.actions", { name: tag.name })}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setTagMenu({ x: rect.left, y: rect.bottom + 4, tag });
                }}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </div>
          ))}
        </Section>
        {spacerAfter("tags")}

        <Section
          icon={<Archive className="size-3.5" />}
          title={t("gitRepo.sidebar.sections.stashes")}
          count={stashes.length}
          {...section("stashes")}
          action={
            <Hint label={t("gitRepo.sidebar.actions.newStash")}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("gitRepo.sidebar.actions.newStash")}
                onClick={() => openDialog("createStash")}
              >
                <Plus className="size-3.5" />
              </Button>
            </Hint>
          }
        >
          {stashes.length === 0 && !repoRefreshing && (
            <EmptyCard
              icon={<Archive />}
              title={t("gitRepo.sidebar.empty.stashesTitle")}
              description={t("gitRepo.sidebar.empty.stashesDescription")}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full justify-center"
                  onClick={() => openDialog("createStash")}
                >
                  <Plus className="size-3.5" /> {t("gitRepo.sidebar.empty.stashChanges")}
                </Button>
              }
            />
          )}
          {stashes.map((stash) => (
            <div
              key={stash.oid}
              className="group hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 pl-7 text-sm"
              onClick={() => useGraph.getState().select(stash.oid)}
              onContextMenu={(e) => {
                e.preventDefault();
                setStashMenu({ x: e.clientX, y: e.clientY, stash });
              }}
            >
              <span
                className="min-w-0 flex-1 truncate"
                title={t("gitRepo.sidebar.list.stashHint", { message: stash.message })}
              >
                {stash.message}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={t("gitRepo.sidebar.list.stashActions")}
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setStashMenu({ x: rect.left, y: rect.bottom + 4, stash });
                }}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </div>
          ))}
        </Section>
        {spacerAfter("stashes")}

        {submodules.length > 0 && (
          <>
            <Section
              {...section("submodules")}
              icon={<Boxes className="size-3.5" />}
              title={t("gitRepo.sidebar.sections.submodules")}
              count={submodules.length}
            >
              {submodules.map((sub) => (
                <div
                  key={sub.name}
                  className="group text-muted-foreground hover:bg-accent flex cursor-default items-center gap-2 rounded-md px-2 py-1 pl-7 text-sm"
                  title={sub.url ?? sub.path}
                  onDoubleClick={() => openSubmodule(sub)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSubMenu({ x: e.clientX, y: e.clientY, sub });
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{sub.path}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t("gitRepo.sidebar.worktreeRow.actions", { name: sub.name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setSubMenu({ x: rect.left, y: rect.bottom + 4, sub });
                    }}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </Button>
                </div>
              ))}
            </Section>
            {spacerAfter("submodules")}
          </>
        )}
      </div>

      {subMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setSubMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: subMenu.x, top: subMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="max-w-64 truncate font-mono">
              {subMenu.sub.path}
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => openSubmodule(subMenu.sub)}>
              <FolderGit2 /> {t("gitRepo.sidebar.menu.openAsRepository")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const sub = subMenu.sub;
                void act(t("gitRepo.sidebar.label.submoduleUpdate", { name: sub.name }), () =>
                  submoduleUpdate(path, sub.name)
                );
              }}
            >
              <ListRestart /> {t("gitRepo.sidebar.menu.updateSubmodule")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(`${path}/${subMenu.sub.path}`);
                toast.success(t("gitRepo.sidebar.toast.pathCopied"));
              }}
            >
              <Copy /> {t("gitRepo.sidebar.menu.copyPath")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {prMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setPrMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: prMenu.x, top: prMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="max-w-64 truncate">
              #{prMenu.pr.number} {prMenu.pr.title}
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => checkoutPullRequest(prMenu.pr)}>
              <Check /> {t("gitRepo.sidebar.menu.checkout")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void openUrl(prMenu.pr.url)}>
              <Cloud /> {t("gitRepo.sidebar.menu.openInBrowser")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(prMenu.pr.url);
                toast.success(t("gitRepo.sidebar.toast.urlCopied"));
              }}
            >
              <Copy /> {t("gitRepo.sidebar.menu.copyUrl")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {tagMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setTagMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: tagMenu.x, top: tagMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="max-w-64 truncate font-mono">
              {tagMenu.tag.name}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => {
                const tag = tagMenu.tag;
                void act(
                  t("gitRepo.sidebar.label.checkout", { name: tag.name }),
                  () => checkoutDetached(path, tag.name),
                  {
                    kind: "checkout",
                  }
                );
              }}
            >
              <Check /> {t("gitRepo.sidebar.menu.checkoutDetached")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const tag = tagMenu.tag;
                void act(t("gitRepo.sidebar.label.tagPush", { name: tag.name }), () =>
                  remotePushTag(path, remotes[0]?.name ?? "origin", tag.name)
                );
              }}
            >
              <Cloud /> {t("gitRepo.sidebar.menu.pushToRemote")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                const tag = tagMenu.tag;
                void act(t("gitRepo.sidebar.label.tagDelete", { name: tag.name }), () =>
                  tagDelete(path, tag.name)
                );
              }}
            >
              <Trash2 /> {t("gitRepo.sidebar.menu.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {stashMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setStashMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: stashMenu.x, top: stashMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="max-w-72 truncate">
              {stashMenu.stash.message}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => {
                const stash = stashMenu.stash;
                void act(t("gitRepo.sidebar.label.stashApply"), () =>
                  stashApply(path, stash.index)
                );
              }}
            >
              <Play /> {t("gitRepo.sidebar.menu.apply")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const stash = stashMenu.stash;
                void act(t("gitRepo.sidebar.label.stashPop"), () => stashPop(path, stash.index));
              }}
            >
              <Undo2 /> {t("gitRepo.sidebar.menu.pop")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                const stash = stashMenu.stash;
                void act(t("gitRepo.sidebar.label.stashDrop"), () => stashDrop(path, stash.index));
              }}
            >
              <Trash2 /> {t("gitRepo.sidebar.menu.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {worktreeMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setWorktreeMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: worktreeMenu.x, top: worktreeMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="max-w-72 truncate font-mono">
              {worktreeMenu.worktree.path}
            </DropdownMenuLabel>
            <DropdownMenuItem
              disabled={worktreeMenu.worktree.isCurrent || worktreeMenu.worktree.isMissing}
              onClick={() => openWorktree(worktreeMenu.worktree)}
            >
              <FolderTree />{" "}
              {worktreeMenu.worktree.isCurrent
                ? t("gitRepo.sidebar.menu.openInThisTab")
                : t("gitRepo.sidebar.menu.switchToWorktree")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={worktreeMenu.worktree.isMissing}
              onClick={() => void revealPath(worktreeMenu.worktree.path)}
            >
              <FolderOpen />{" "}
              {isMac
                ? t("gitRepo.sidebar.menu.reveal")
                : t("gitRepo.sidebar.menu.showInFileManager")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(worktreeMenu.worktree.path);
                toast.success(t("gitRepo.sidebar.toast.pathCopied"));
              }}
            >
              <Copy /> {t("gitRepo.sidebar.menu.copyPath")}
            </DropdownMenuItem>
            {!worktreeMenu.worktree.isMain && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => void removeWorktree(worktreeMenu.worktree)}
                >
                  {worktreeMenu.worktree.isMissing ? (
                    <>
                      <Eraser /> {t("gitRepo.sidebar.menu.forgetMissing")}
                    </>
                  ) : (
                    <>
                      <Trash2 /> {t("gitRepo.sidebar.menu.removeWorktree")}
                    </>
                  )}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {remoteMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setRemoteMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: remoteMenu.x, top: remoteMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="max-w-64 truncate font-mono">
              {remoteMenu.remote.name}
            </DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => {
                const r = remoteMenu.remote;
                void act(t("gitRepo.sidebar.label.fetchRemote", { name: r.name }), () =>
                  remoteFetch(path, r.name, true, true)
                );
              }}
            >
              <ArrowDownToLine />{" "}
              {t("gitRepo.sidebar.label.fetchRemote", { name: remoteMenu.remote.name })}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={remoteWebUrl(remoteMenu.remote.url) === null}
              onClick={() => {
                const url = remoteWebUrl(remoteMenu.remote.url);
                if (url) void openUrl(url);
              }}
            >
              <Globe /> {t("gitRepo.sidebar.menu.openInBrowser")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const r = remoteMenu.remote;
                setEditRemote({ original: r.name, name: r.name, url: r.url });
              }}
            >
              <Pencil /> {t("gitRepo.sidebar.menu.editRemote")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                const r = remoteMenu.remote;
                void confirmDialog({
                  title: t("gitRepo.sidebar.removeRemote.title", { name: r.name }),
                  description: t("gitRepo.sidebar.removeRemote.description"),
                  confirmLabel: t("gitRepo.sidebar.removeRemote.confirm"),
                  destructive: true,
                }).then((ok) => {
                  if (ok)
                    void act(t("gitRepo.sidebar.label.remoteRemove", { name: r.name }), () =>
                      remoteRemove(path, r.name)
                    );
                });
              }}
            >
              <Trash2 /> {t("gitRepo.sidebar.menu.removeRemote")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Dialog open={editRemote !== null} onOpenChange={(o) => !o && setEditRemote(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editRemote?.original === null
                ? t("gitRepo.sidebar.remoteForm.addTitle")
                : t("gitRepo.sidebar.remoteForm.editTitle")}
            </DialogTitle>
            <DialogDescription>
              {editRemote?.original === null
                ? t("gitRepo.sidebar.remoteForm.addDescription")
                : t("gitRepo.sidebar.remoteForm.editDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <label className="text-muted-foreground flex flex-col gap-1.5 text-xs">
              {t("gitRepo.sidebar.remoteForm.name")}
              <Input
                value={editRemote?.name ?? ""}
                onChange={(e) => setEditRemote((s) => (s ? { ...s, name: e.target.value } : s))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitEditRemote();
                }}
                placeholder={
                  remotes.length === 0
                    ? t("gitRepo.sidebar.remoteForm.namePlaceholderOrigin")
                    : t("gitRepo.sidebar.remoteForm.namePlaceholderUpstream")
                }
                autoFocus
              />
            </label>
            <label className="text-muted-foreground flex flex-col gap-1.5 text-xs">
              {t("gitRepo.sidebar.remoteForm.url")}
              <Input
                value={editRemote?.url ?? ""}
                onChange={(e) => setEditRemote((s) => (s ? { ...s, url: e.target.value } : s))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitEditRemote();
                }}
                placeholder={t("gitRepo.sidebar.remoteForm.urlPlaceholder")}
                className="font-mono"
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setEditRemote(null)}>
              {t("gitRepo.sidebar.remoteForm.cancel")}
            </Button>
            <Button
              disabled={savingRemote || !editRemote?.name.trim() || !editRemote?.url.trim()}
              onClick={() => void submitEditRemote()}
            >
              {editRemote?.original === null
                ? t("gitRepo.sidebar.remoteForm.add")
                : t("gitRepo.sidebar.remoteForm.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {branchMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setBranchMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: branchMenu.x, top: branchMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="max-w-64 truncate font-mono">
              {branchMenu.branch.name}
            </DropdownMenuLabel>
            {branchMenuHeld ? (
              <DropdownMenuItem onClick={() => openWorktree(branchMenuHeld)}>
                <FolderTree />{" "}
                {t("gitRepo.sidebar.branchMenu.switchToWorktree", { name: branchMenuHeld.name })}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                disabled={branchMenu.branch.isHead}
                onClick={() =>
                  void act(
                    t("gitRepo.sidebar.label.checkout", { name: branchMenu.branch.name }),
                    () => branchCheckout(path, branchMenu.branch.name),
                    { kind: "checkout" }
                  )
                }
              >
                <Check /> {t("gitRepo.sidebar.branchMenu.checkout")}
              </DropdownMenuItem>
            )}
            {!branchMenu.branch.isHead && !branchMenuHeld && (
              <DropdownMenuItem
                onClick={() => openDialog("createWorktree", { branch: branchMenu.branch.name })}
              >
                <FolderTree /> {t("gitRepo.sidebar.branchMenu.openInNewWorktree")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              disabled={branchMenu.branch.isHead}
              onClick={() =>
                void act(
                  t("gitRepo.sidebar.label.branchMerge", { name: branchMenu.branch.name }),
                  () => branchMerge(path, branchMenu.branch.name, true),
                  { kind: "merge" }
                )
              }
            >
              <GitMerge /> {t("gitRepo.sidebar.branchMenu.mergeIntoCurrent")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={branchMenu.branch.isHead || branchMenuFf !== true}
              onClick={() =>
                void act(
                  t("gitRepo.sidebar.label.branchFastForward", { name: branchMenu.branch.name }),
                  () => branchMerge(path, branchMenu.branch.name, false),
                  { kind: "merge" }
                )
              }
            >
              <FastForward /> {t("gitRepo.sidebar.branchMenu.fastForward")}
            </DropdownMenuItem>
            {!branchMenu.branch.isRemote && (
              <DropdownMenuItem
                disabled={branchMenu.branch.isHead}
                onClick={() =>
                  void act(
                    t("gitRepo.sidebar.label.branchRebase", { name: branchMenu.branch.name }),
                    () => branchRebase(path, branchMenu.branch.name),
                    { kind: "rebase" }
                  )
                }
              >
                <ListRestart /> {t("gitRepo.sidebar.branchMenu.rebase")}
              </DropdownMenuItem>
            )}
            {!branchMenu.branch.isRemote && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!branchMenu.branch.upstream}
                  onClick={() =>
                    void act(
                      t("gitRepo.sidebar.label.branchPull", { name: branchMenu.branch.name }),
                      () => remotePullBranch(path, branchMenu.branch.name)
                    )
                  }
                >
                  <ArrowDownToLine /> {t("gitRepo.sidebar.branchMenu.pull")}
                  {branchMenu.branch.behind > 0 && (
                    <Badge variant="outline">↓{capCount(branchMenu.branch.behind)}</Badge>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void act(
                      t("gitRepo.sidebar.label.branchPush", { name: branchMenu.branch.name }),
                      () =>
                        remotePush(
                          path,
                          remotes[0]?.name ?? "origin",
                          branchMenu.branch.name,
                          false,
                          false,
                          true
                        )
                    )
                  }
                >
                  <ArrowUpFromLine /> {t("gitRepo.sidebar.branchMenu.push")}
                  {branchMenu.branch.ahead > 0 && (
                    <Badge variant="default">↑{capCount(branchMenu.branch.ahead)}</Badge>
                  )}
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => openDialog("createBranch", branchMenu.branch.targetOid)}
            >
              <GitBranchPlus /> {t("gitRepo.sidebar.branchMenu.createHere")}
            </DropdownMenuItem>
            {!branchMenu.branch.isRemote && (
              <>
                <DropdownMenuItem onClick={() => openDialog("rename", branchMenu.branch.name)}>
                  <Pencil /> {t("gitRepo.sidebar.branchMenu.rename")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={branchMenu.branch.isHead}
                  onClick={() =>
                    void act(
                      t("gitRepo.sidebar.label.branchDelete", { name: branchMenu.branch.name }),
                      () => branchDelete(path, branchMenu.branch.name, false),
                      {
                        kind: "branchDelete",
                        extra: { branch: branchMenu.branch.name, oid: branchMenu.branch.targetOid },
                      }
                    )
                  }
                >
                  <Trash2 /> {t("gitRepo.sidebar.branchMenu.delete")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Dialog open={dropAction !== null} onOpenChange={(o) => !o && setDropAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Badge variant="outline" className="max-w-44 min-w-0">
                <span className="truncate">{dropAction?.source}</span>
              </Badge>
              <MoveRight className="text-muted-foreground/70 size-3.5 shrink-0" />
              <Badge variant="secondary" className="max-w-44 min-w-0">
                <span className="truncate">{dropAction?.target}</span>
              </Badge>
            </DialogTitle>
            <DialogDescription>
              {dropAction && useRepo.getState().repo?.headBranch !== dropAction.target
                ? t("gitRepo.sidebar.drop.checkoutFirst", { target: dropAction.target })
                : t("gitRepo.sidebar.drop.choose")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Button
              className="h-auto justify-start py-2 whitespace-normal"
              onClick={() =>
                dropAction && void dropMerge(dropAction.source, dropAction.target, true)
              }
            >
              <GitMerge className="shrink-0" />
              <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
                <span className="max-w-full truncate">
                  {t("gitRepo.sidebar.drop.merge", {
                    source: dropAction?.source,
                    target: dropAction?.target,
                  })}
                </span>
                <span className="text-[11px] font-normal opacity-75">
                  {t("gitRepo.sidebar.drop.mergeHint", { target: dropAction?.target })}
                </span>
              </span>
            </Button>
            {dropAction?.canFf && (
              <Button
                variant="secondary"
                className="h-auto justify-start py-2 whitespace-normal"
                onClick={() => void dropMerge(dropAction.source, dropAction.target, false)}
              >
                <FastForward className="shrink-0" />
                <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
                  <span className="max-w-full truncate">
                    {t("gitRepo.sidebar.drop.fastForward", {
                      target: dropAction.target,
                      source: dropAction.source,
                    })}
                  </span>
                  <span className="text-muted-foreground text-[11px] font-normal">
                    {t("gitRepo.sidebar.drop.fastForwardHint")}
                  </span>
                </span>
              </Button>
            )}
            {dropAction && !branches.find((b) => b.name === dropAction.source)?.isRemote && (
              <Button
                variant="secondary"
                className="h-auto justify-start py-2 whitespace-normal"
                onClick={() => void dropRebase(dropAction.source, dropAction.target)}
              >
                <ListRestart className="shrink-0" />
                <span className="flex min-w-0 flex-col items-start gap-0.5 text-left">
                  <span className="max-w-full truncate">
                    {t("gitRepo.sidebar.drop.rebase", {
                      source: dropAction.source,
                      target: dropAction.target,
                    })}
                  </span>
                  <span className="text-muted-foreground text-[11px] font-normal">
                    {t("gitRepo.sidebar.drop.rebaseHint", {
                      source: dropAction.source,
                      target: dropAction.target,
                    })}
                  </span>
                </span>
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDropAction(null)}>
              {t("gitRepo.sidebar.drop.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
