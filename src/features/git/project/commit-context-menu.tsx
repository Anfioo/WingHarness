import { toast } from "sonner";
import {
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronUp,
  Combine,
  Copy,
  FolderTree,
  GitBranchPlus,
  GitCompare,
  ListOrdered,
  ListRestart,
  Pencil,
  RotateCcw,
  Tag as TagIcon,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  checkoutDetached,
  cherryPick,
  cherryPickMany,
  commitRevert,
  resetTo,
  remotePush,
} from "@/commands";
import { confirmDialog } from "@/components/confirm";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { CommitInfo } from "@/lib/git-core";
import { ProjectContextMenu, type MenuPoint, type ProjectMenuItem } from "./context-menu";
import { runGitAction } from "./actions";

interface CommitContextMenuProps {
  repo: string | null;
  point: MenuPoint | null;
  /** The commit that was right-clicked; always part of `selected`. */
  primary: CommitInfo | null;
  selected: readonly CommitInfo[];
  commits: readonly CommitInfo[];
  currentBranch: string | null;
  /** The ref the log is filtered to, null for every ref. */
  branch: string | null;
  onClose: () => void;
  onReset: (commit: CommitInfo) => void;
  onReword: (commit: CommitInfo) => void;
  onFixup: (commit: CommitInfo) => void;
  onSquash: (commit: CommitInfo) => void;
  onDrop: (commits: CommitInfo[]) => void;
  onInteractiveRebase: (commit: CommitInfo) => void;
  onNewBranch: (commit: CommitInfo) => void;
  onNewTag: (commit: CommitInfo) => void;
  onGoTo: (oid: string) => void;
  onShowRevision: (commit: CommitInfo) => void;
  onCompareWithWorktree: (commit: CommitInfo) => void;
}

/** What a commit in the log offers when right-clicked; batch actions when several are picked. */
export function CommitContextMenu({
  repo,
  point,
  primary,
  selected,
  commits,
  currentBranch,
  branch,
  onClose,
  onReset,
  onReword,
  onFixup,
  onSquash,
  onDrop,
  onInteractiveRebase,
  onNewBranch,
  onNewTag,
  onGoTo,
  onShowRevision,
  onCompareWithWorktree,
}: CommitContextMenuProps) {
  const { t } = useAppTranslation();
  if (!repo || !point || !primary) return null;

  const count = selected.length;
  const multi = count > 1;
  const rewriting = currentBranch !== null && (branch === null || branch === currentBranch);
  const rewriteReason =
    currentBranch === null
      ? t("projectGit.error.noCurrentBranch")
      : t("projectGit.error.rewriteCurrentBranch");
  const index = commits.findIndex((commit) => commit.oid === primary.oid);
  const candidates = index < 0 ? [] : commits.slice(index + 1);
  const hasMerge = selected.some((commit) => commit.parents.length > 1);
  const mergeReason = t("projectGit.error.noMergeInRange");

  const copyRevision = (oids: string[]) => {
    void navigator.clipboard.writeText(oids.join("\n"));
    toast.success(t("projectGit.toast.revisionCopied"));
  };

  if (multi) {
    const ordered = [...selected].reverse().map((commit) => commit.oid);
    return (
      <ProjectContextMenu
        point={point}
        title={primary.shortOid}
        onClose={onClose}
        items={[
          {
            id: "commit.cherryPick",
            label: t("projectGit.menu.commit.cherryPickMany", { count }),
            icon: <ListRestart />,
            onSelect: () =>
              void runGitAction({
                id: "commit.cherryPick",
                label: t("projectGit.menu.commit.cherryPickMany", { count }),
                run: () => cherryPickMany(repo, ordered, false),
              }),
          },
          {
            id: "commit.drop",
            label: t("projectGit.menu.commit.dropMany", { count }),
            icon: <Trash2 />,
            destructive: true,
            disabled: !rewriting || hasMerge,
            disabledReason: hasMerge ? mergeReason : rewriteReason,
            onSelect: () => onDrop([...selected]),
          },
          {
            id: "commit.squash",
            label: t("projectGit.menu.commit.squashInto"),
            icon: <Combine />,
            disabled: !rewriting || hasMerge || candidates.length === 0,
            disabledReason: hasMerge ? mergeReason : rewriteReason,
            onSelect: () => onSquash(primary),
          },
          {
            id: "commit.copyRevision",
            label: t("projectGit.menu.commit.copyRevision"),
            icon: <Copy />,
            separatorBefore: true,
            onSelect: () => copyRevision(selected.map((commit) => commit.oid)),
          },
        ]}
      />
    );
  }

  const parent = primary.parents[0] ?? null;
  const child = commits.find((commit) => commit.parents.includes(primary.oid))?.oid ?? null;
  const pushDisabled = currentBranch === null || (branch !== null && branch !== currentBranch);

  const items: Array<ProjectMenuItem | null | false> = [
    {
      id: "commit.checkout",
      label: t("projectGit.menu.commit.checkout"),
      icon: <Check />,
      onSelect: () =>
        void runGitAction({
          id: "commit.checkout",
          label: t("gitRepo.sidebar.label.checkout", { name: primary.shortOid }),
          run: () => checkoutDetached(repo, primary.oid),
        }),
    },
    {
      id: "commit.newBranch",
      label: t("projectGit.menu.commit.newBranch"),
      icon: <GitBranchPlus />,
      onSelect: () => onNewBranch(primary),
    },
    {
      id: "commit.newTag",
      label: t("projectGit.menu.commit.newTag"),
      icon: <TagIcon />,
      onSelect: () => onNewTag(primary),
    },
    {
      id: "commit.showRevision",
      label: t("projectGit.menu.commit.showRepoAtRevision"),
      icon: <FolderTree />,
      separatorBefore: true,
      onSelect: () => onShowRevision(primary),
    },
    {
      id: "commit.compareWithWorktree",
      label: t("projectGit.menu.commit.compareWithLocal"),
      icon: <GitCompare />,
      onSelect: () => onCompareWithWorktree(primary),
    },
    {
      id: "commit.reword",
      label: t("projectGit.menu.commit.reword"),
      icon: <Pencil />,
      separatorBefore: true,
      disabled: !rewriting || primary.parents.length > 1,
      disabledReason: rewriteReason,
      onSelect: () => onReword(primary),
    },
    {
      id: "commit.fixup",
      label: t("projectGit.menu.commit.fixup"),
      icon: <Combine />,
      disabled: !rewriting || primary.parents.length > 1 || candidates.length === 0,
      disabledReason: rewriteReason,
      onSelect: () => onFixup(primary),
    },
    {
      id: "commit.squash",
      label: t("projectGit.menu.commit.squashInto"),
      icon: <Combine />,
      disabled: !rewriting || primary.parents.length > 1 || candidates.length === 0,
      disabledReason: rewriteReason,
      onSelect: () => onSquash(primary),
    },
    {
      id: "commit.drop",
      label: t("projectGit.menu.commit.drop"),
      icon: <Trash2 />,
      destructive: true,
      disabled: !rewriting || primary.parents.length > 1,
      disabledReason: rewriteReason,
      onSelect: () => onDrop([primary]),
    },
    {
      id: "commit.interactiveRebase",
      label: t("projectGit.menu.commit.interactiveRebase"),
      icon: <ListOrdered />,
      disabled: !rewriting || primary.isHead,
      disabledReason: primary.isHead ? t("projectGit.error.nothingAbove") : rewriteReason,
      onSelect: () => onInteractiveRebase(primary),
    },
    {
      id: "commit.reset",
      label: t("projectGit.menu.commit.resetTo"),
      icon: <RotateCcw />,
      separatorBefore: true,
      disabled: currentBranch === null,
      disabledReason: t("projectGit.error.noCurrentBranch"),
      onSelect: () => onReset(primary),
    },
    {
      id: "commit.undo",
      label: t("projectGit.menu.commit.undo"),
      icon: <Undo2 />,
      disabled: !primary.isHead || parent === null,
      disabledReason: primary.isHead
        ? t("projectGit.error.noParentCommit")
        : t("projectGit.error.onlyHead"),
      onSelect: () =>
        void (async () => {
          const confirmed = await confirmDialog({
            title: t("projectGit.confirm.undoCommit.title", { oid: primary.shortOid }),
            description: t("projectGit.confirm.undoCommit.description"),
            confirmLabel: t("projectGit.confirm.undoCommit.confirm"),
            destructive: true,
          });
          if (!confirmed || !parent) return;
          await runGitAction({
            id: "commit.undo",
            label: t("projectGit.menu.commit.undo"),
            success: t("projectGit.toast.reset", { oid: primary.shortOid }),
            run: () => resetTo(repo, parent, "mixed"),
          });
        })(),
    },
    {
      id: "commit.revert",
      label: t("projectGit.menu.commit.revert"),
      icon: <Undo2 />,
      onSelect: () =>
        void runGitAction({
          id: "commit.revert",
          label: t("projectGit.menu.commit.revert"),
          run: () => commitRevert(repo, primary.oid),
        }),
    },
    {
      id: "commit.cherryPick",
      label: t("projectGit.menu.commit.cherryPick"),
      icon: <ListRestart />,
      separatorBefore: true,
      onSelect: () =>
        void runGitAction({
          id: "commit.cherryPick",
          label: t("projectGit.menu.commit.cherryPick"),
          run: () => cherryPick(repo, primary.oid, false),
        }),
    },
    {
      id: "commit.push",
      label: t("projectGit.menu.commit.pushUpToHere"),
      icon: <ArrowUpFromLine />,
      disabled: pushDisabled || currentBranch === null,
      disabledReason: t("projectGit.error.onlyCurrentBranchPush"),
      onSelect: () =>
        void runGitAction({
          id: "commit.push",
          label: t("projectGit.menu.commit.pushUpToHere"),
          run: () => remotePush(repo, "origin", currentBranch, false, false, true),
        }),
    },
    {
      id: "commit.goToParent",
      label: t("projectGit.menu.commit.goToParent"),
      icon: <ChevronUp />,
      separatorBefore: true,
      disabled: parent === null,
      disabledReason: t("projectGit.error.noParentCommit"),
      onSelect: () => parent && onGoTo(parent),
    },
    {
      id: "commit.goToChild",
      label: t("projectGit.menu.commit.goToChild"),
      icon: <ChevronDown />,
      disabled: child === null,
      disabledReason: t("projectGit.error.noChildCommit"),
      onSelect: () => child && onGoTo(child),
    },
    {
      id: "commit.copyRevision",
      label: t("projectGit.menu.commit.copyRevision"),
      icon: <Copy />,
      separatorBefore: true,
      onSelect: () => copyRevision([primary.oid]),
    },
    {
      id: "commit.copyMessage",
      label: t("projectGit.menu.commit.copyMessage"),
      icon: <Copy />,
      onSelect: () => {
        void navigator.clipboard.writeText(
          primary.body ? `${primary.summary}\n\n${primary.body}` : primary.summary
        );
        toast.success(t("projectGit.toast.commitMessageCopied"));
      },
    },
  ];

  return (
    <ProjectContextMenu point={point} title={primary.shortOid} items={items} onClose={onClose} />
  );
}
