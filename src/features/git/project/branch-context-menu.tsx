import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  FolderTree,
  GitBranchPlus,
  GitCompare,
  GitMerge,
  ListRestart,
  Pencil,
  Tag as TagIcon,
  Trash2,
} from "lucide-react";
import {
  branchCheckout,
  branchMerge,
  branchRebase,
  checkoutDetached,
  remotePull,
  remotePullBranch,
  remotePush,
  worktreeList,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { BranchInfo, TagInfo, WorktreeInfo } from "@/lib/git-core";
import { runGitAction } from "./actions";
import { ProjectContextMenu, type MenuPoint, type ProjectMenuItem } from "./context-menu";
import type { ProjectTabOpeners } from "./tab-openers";

export type BranchMenuTarget =
  | { point: MenuPoint; branch: BranchInfo }
  | { point: MenuPoint; tag: TagInfo };

interface BranchContextMenuProps {
  repo: string | null;
  target: BranchMenuTarget | null;
  currentBranch: string | null;
  openers: ProjectTabOpeners;
  onClose: () => void;
  onNewBranch: (source: { name: string; oid: string }) => void;
  onRename: (branch: BranchInfo) => void;
  onNewTag: (branch: BranchInfo) => void;
  onWorktree: (branch: BranchInfo) => void;
  onDeleteBranch: (branch: BranchInfo) => void;
  onDeleteTag: (tag: TagInfo) => void;
}

/** What a branch, remote branch or tag offers when right-clicked in the refs pane. */
export function BranchContextMenu({
  repo,
  target,
  currentBranch,
  openers,
  onClose,
  onNewBranch,
  onRename,
  onNewTag,
  onWorktree,
  onDeleteBranch,
  onDeleteTag,
}: BranchContextMenuProps) {
  const { t } = useAppTranslation();
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);

  useEffect(() => {
    if (!repo || !target || !("branch" in target)) {
      setWorktrees([]);
      return;
    }
    let cancelled = false;
    void worktreeList(repo)
      .then((list) => {
        if (!cancelled) setWorktrees(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repo, target]);

  const heldBy = useMemo(() => {
    const held = new Map<string, string>();
    for (const worktree of worktrees) {
      if (worktree.branch) held.set(worktree.branch, worktree.name);
    }
    return held;
  }, [worktrees]);

  if (!repo || !target) return null;

  const copyRevision = (oid: string) => {
    void navigator.clipboard.writeText(oid);
    toast.success(t("projectGit.toast.revisionCopied"));
  };

  const items: Array<ProjectMenuItem | null | false> =
    "branch" in target
      ? branchItems({
          t,
          repo,
          branch: target.branch,
          currentBranch,
          openers,
          heldBy,
          copyRevision,
          onNewBranch,
          onRename,
          onNewTag,
          onWorktree,
          onDeleteBranch,
        })
      : tagItems({ t, repo, tag: target.tag, copyRevision, onNewBranch, onDeleteTag });

  return (
    <ProjectContextMenu
      point={target.point}
      title={"branch" in target ? target.branch.name : target.tag.name}
      items={items}
      onClose={onClose}
    />
  );
}

interface ItemContext {
  t: ReturnType<typeof useAppTranslation>["t"];
  repo: string;
  copyRevision: (oid: string) => void;
}

function branchItems({
  t,
  repo,
  branch,
  currentBranch,
  openers,
  heldBy,
  copyRevision,
  onNewBranch,
  onRename,
  onNewTag,
  onWorktree,
  onDeleteBranch,
}: ItemContext & {
  branch: BranchInfo;
  currentBranch: string | null;
  openers: ProjectTabOpeners;
  heldBy: Map<string, string>;
  onNewBranch: (source: { name: string; oid: string }) => void;
  onRename: (branch: BranchInfo) => void;
  onNewTag: (branch: BranchInfo) => void;
  onWorktree: (branch: BranchInfo) => void;
  onDeleteBranch: (branch: BranchInfo) => void;
}): Array<ProjectMenuItem | null | false> {
  const local = !branch.isRemote;
  const localName = local ? branch.name : branch.name.split("/").slice(1).join("/");
  const held = heldBy.get(localName);
  const checkoutDisabled = branch.isHead || held !== undefined;
  const checkoutReason = branch.isHead
    ? t("projectGit.error.currentBranch")
    : t("projectGit.error.heldByWorktree");
  const remote = branch.upstream?.split("/")[0] ?? "origin";
  const pull = () =>
    branch.isHead ? remotePull(repo, remote, "merge") : remotePullBranch(repo, branch.name);

  return [
    {
      id: "branch.checkout",
      label: t("gitRepo.sidebar.branchMenu.checkout"),
      icon: <Check />,
      disabled: checkoutDisabled,
      disabledReason: checkoutReason,
      onSelect: () =>
        void runGitAction({
          id: "branch.checkout",
          label: t("gitRepo.sidebar.label.checkout", { name: branch.name }),
          run: () => branchCheckout(repo, branch.name),
        }),
    },
    {
      id: "branch.create",
      label: t("projectGit.menu.branch.createFrom", { name: branch.name }),
      icon: <GitBranchPlus />,
      onSelect: () => onNewBranch({ name: branch.name, oid: branch.targetOid }),
    },
    !branch.isHead &&
      currentBranch !== null && {
        id: "branch.compare",
        label: t("projectGit.menu.branch.compare", { name: currentBranch }),
        icon: <GitCompare />,
        onSelect: () => openers.openCompare(branch.name, currentBranch),
      },
    {
      id: "branch.compareWorktree",
      label: t("projectGit.menu.branch.compareWorktree"),
      icon: <GitCompare />,
      onSelect: () => openers.openCompare(branch.name, null),
    },
    currentBranch !== null &&
      !branch.isHead && {
        id: "branch.checkoutRebase",
        label: t("projectGit.menu.branch.checkoutAndRebase", { name: currentBranch }),
        icon: <ListRestart />,
        onSelect: () =>
          void runGitAction({
            id: "branch.checkoutRebase",
            label: t("gitRepo.sidebar.label.branchRebase", { name: currentBranch }),
            run: async () => {
              await branchCheckout(repo, branch.name);
              const outcome = await branchRebase(repo, currentBranch);
              return outcome.status === "conflicts"
                ? {
                    ...outcome,
                    message: t("projectGit.toast.rebaseConflicts", { name: branch.name }),
                  }
                : outcome;
            },
          }),
      },
    local &&
      !branch.isHead && {
        id: "branch.checkoutUpdate",
        label: t("projectGit.menu.branch.checkoutAndUpdate"),
        icon: <ArrowDownToLine />,
        disabled: !branch.upstream,
        disabledReason: t("projectGit.error.noUpstream"),
        onSelect: () =>
          void runGitAction({
            id: "branch.checkoutUpdate",
            label: t("gitRepo.sidebar.label.branchPull", { name: branch.name }),
            success: t("projectGit.toast.branchUpdated", { name: branch.name }),
            run: async () => {
              await branchCheckout(repo, branch.name);
              return remotePull(repo, remote, "merge");
            },
          }),
      },
    local && {
      id: "branch.update",
      label: t("projectGit.menu.branch.update"),
      icon: <ArrowDownToLine />,
      disabled: !branch.upstream,
      disabledReason: t("projectGit.error.noUpstream"),
      separatorBefore: true,
      onSelect: () =>
        void runGitAction({
          id: "branch.update",
          label: t("gitRepo.sidebar.label.branchPull", { name: branch.name }),
          success: t("projectGit.toast.branchUpdated", { name: branch.name }),
          run: pull,
        }),
    },
    !branch.isHead && {
      id: "branch.rebase",
      label: t("gitRepo.sidebar.branchMenu.rebase"),
      icon: <ListRestart />,
      disabled: currentBranch === null,
      disabledReason: t("projectGit.error.noCurrentBranch"),
      separatorBefore: true,
      onSelect: () =>
        void runGitAction({
          id: "branch.rebase",
          label: t("gitRepo.sidebar.label.branchRebase", { name: branch.name }),
          run: () => branchRebase(repo, branch.name),
        }),
    },
    !branch.isHead && {
      id: "branch.merge",
      label: t("gitRepo.sidebar.branchMenu.mergeIntoCurrent"),
      icon: <GitMerge />,
      disabled: currentBranch === null,
      disabledReason: t("projectGit.error.noCurrentBranch"),
      onSelect: () =>
        void runGitAction({
          id: "branch.merge",
          label: t("gitRepo.sidebar.label.branchMerge", { name: branch.name }),
          run: () => branchMerge(repo, branch.name, false),
        }),
    },
    !branch.isHead &&
      held === undefined && {
        id: "branch.worktree",
        label: t("projectGit.menu.branch.newWorktree", { name: branch.name }),
        icon: <FolderTree />,
        separatorBefore: true,
        onSelect: () => onWorktree(branch),
      },
    local && {
      id: "branch.push",
      label: t("gitRepo.sidebar.branchMenu.push"),
      icon: <ArrowUpFromLine />,
      onSelect: () =>
        void runGitAction({
          id: "branch.push",
          label: t("gitRepo.sidebar.label.branchPush", { name: branch.name }),
          run: () => remotePush(repo, remote, branch.name, false, false, true),
        }),
    },
    local && {
      id: "branch.rename",
      label: t("gitRepo.sidebar.branchMenu.rename"),
      icon: <Pencil />,
      separatorBefore: true,
      onSelect: () => onRename(branch),
    },
    local && {
      id: "branch.delete",
      label: t("gitRepo.sidebar.branchMenu.delete"),
      icon: <Trash2 />,
      destructive: true,
      disabled: checkoutDisabled,
      disabledReason: checkoutReason,
      onSelect: () => onDeleteBranch(branch),
    },
    {
      id: "branch.copyRevision",
      label: t("projectGit.menu.branch.copyRevision"),
      icon: <Copy />,
      separatorBefore: true,
      onSelect: () => copyRevision(branch.targetOid),
    },
    local && {
      id: "branch.newTag",
      label: t("projectGit.menu.branch.newTag"),
      icon: <TagIcon />,
      onSelect: () => onNewTag(branch),
    },
  ];
}

function tagItems({
  t,
  repo,
  tag,
  copyRevision,
  onNewBranch,
  onDeleteTag,
}: ItemContext & {
  tag: TagInfo;
  onNewBranch: (source: { name: string; oid: string }) => void;
  onDeleteTag: (tag: TagInfo) => void;
}): Array<ProjectMenuItem | null | false> {
  return [
    {
      id: "tag.checkout",
      label: t("projectGit.menu.branch.checkoutTag"),
      icon: <Check />,
      onSelect: () =>
        void runGitAction({
          id: "tag.checkout",
          label: t("gitRepo.sidebar.label.checkout", { name: tag.name }),
          run: () => checkoutDetached(repo, tag.name),
        }),
    },
    {
      id: "tag.branch",
      label: t("projectGit.menu.branch.newBranchFromTag"),
      icon: <GitBranchPlus />,
      onSelect: () => onNewBranch({ name: tag.name, oid: tag.targetOid }),
    },
    {
      id: "tag.delete",
      label: t("projectGit.menu.branch.deleteTag"),
      icon: <Trash2 />,
      destructive: true,
      separatorBefore: true,
      onSelect: () => onDeleteTag(tag),
    },
    {
      id: "tag.copyRevision",
      label: t("projectGit.menu.branch.copyRevision"),
      icon: <Copy />,
      separatorBefore: true,
      onSelect: () => copyRevision(tag.targetOid),
    },
  ];
}
