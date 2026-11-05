import { useState } from "react";
import { save as pickSaveFile } from "@tauri-apps/plugin-dialog";
import type { TFunction } from "i18next";
import { toast } from "sonner";
import {
  Copy,
  Download,
  ExternalLink,
  FileCode,
  FileDiff,
  FolderOpen,
  GitCompare,
  History,
  ListRestart,
  Pencil,
  Scissors,
  Trash2,
  Undo2,
  FilePlus2,
} from "lucide-react";
import {
  cherryPickPaths,
  commitDropPaths,
  commitExtractPaths,
  openPath,
  patchSave,
  restoreFromRev,
  revealPath,
} from "@/commands";
import { confirmDialog } from "@/components/confirm";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { basename, isMac } from "@/features/git/utils";
import { ProjectContextMenu, type MenuPoint, type ProjectMenuItem } from "./context-menu";
import { errorText, runGitAction } from "./actions";
import { InputDialog, type InputDialogState } from "./dialogs/input-dialog";
import type { ProjectTabOpeners } from "./tab-openers";

/** One file row a menu can be opened on, from the working copy or from a revision. */
export interface FileMenuRow {
  path: string;
  /** The previous path when the row is a rename. */
  oldPath?: string | null;
  /** The revision the row belongs to, null for the working copy. */
  oid: string | null;
  /** That revision's parent, when it has one. */
  parentOid?: string | null;
  /** Working copy only: the change is in the index rather than the worktree. */
  staged?: boolean;
  /** The revision does not hold the file any more (it was deleted there). */
  deleted?: boolean;
}

export interface FileMenuTarget {
  point: MenuPoint;
  row: FileMenuRow;
}

/** The file's full Windows path inside the working copy. */
export function fileAbsolutePath(repo: string, file: string): string {
  return `${repo.replace(/[\\/]+$/, "")}\\${file.replaceAll("/", "\\")}`;
}

/** Copies the repository-relative path, with the toast every caller shows. */
export function copyFilePath(path: string, t: TFunction): void {
  void navigator.clipboard.writeText(path);
  toast.success(t("projectGit.toast.pathCopied"));
}

const modifier = isMac ? "⌘" : "Ctrl";

/**
 * What a changed file offers when right-clicked, in the commit detail and in the
 * working copy alike.
 *
 * The component is always mounted by its parents so the message dialog the
 * extract action opens survives the menu closing.
 */
export function FileContextMenu({
  repo,
  target,
  headOid,
  openers,
  onClose,
  extraItems,
}: {
  repo: string | null;
  target: FileMenuTarget | null;
  /** HEAD's commit, for the working-copy rows; null when the branch is unborn. */
  headOid: string | null;
  openers: ProjectTabOpeners;
  onClose: () => void;
  /** Items the caller offers on top of the shared ones, e.g. staging a file. */
  extraItems?: Array<ProjectMenuItem | null | false>;
}) {
  const { t } = useAppTranslation();
  const [input, setInput] = useState<InputDialogState | null>(null);

  const items =
    repo && target
      ? [...(extraItems ?? []), ...buildItems(repo, target.row, headOid, openers, t, setInput)]
      : [];

  return (
    <>
      {repo && target && (
        <ProjectContextMenu
          point={target.point}
          title={target.row.path}
          items={items}
          onClose={onClose}
        />
      )}
      <InputDialog request={input} onClose={() => setInput(null)} />
    </>
  );
}

/** Restores a path from a revision after asking, since it overwrites the working copy. */
export function runRestoreFile(
  repo: string,
  path: string,
  rev: string,
  t: TFunction
): Promise<void> {
  return (async () => {
    const confirmed = await confirmDialog({
      title: t("projectGit.confirm.restoreFile.title"),
      description: t("projectGit.confirm.restoreFile.description"),
      path,
      confirmLabel: t("projectGit.confirm.restoreFile.confirm"),
      destructive: true,
    });
    if (!confirmed) return;
    await runGitAction({
      id: "file.restore",
      label: t("projectGit.menu.file.restore"),
      success: t("projectGit.toast.restored"),
      run: () => restoreFromRev(repo, rev, [path]),
    });
  })();
}

/** Drops one path's change out of a commit, rewriting the history above it. */
export function runDropFileChanges(
  repo: string,
  path: string,
  oid: string,
  t: TFunction
): Promise<void> {
  return (async () => {
    const confirmed = await confirmDialog({
      title: t("projectGit.confirm.dropChanges.title"),
      description: t("projectGit.confirm.dropChanges.description"),
      path,
      confirmLabel: t("projectGit.confirm.dropChanges.confirm"),
      destructive: true,
    });
    if (!confirmed) return;
    await runGitAction({
      id: "file.drop",
      label: t("projectGit.menu.file.dropChanges"),
      run: () => commitDropPaths(repo, oid, [path]),
    });
  })();
}

function buildItems(
  repo: string,
  row: FileMenuRow,
  headOid: string | null,
  openers: ProjectTabOpeners,
  t: TFunction,
  setInput: (request: InputDialogState | null) => void
): Array<ProjectMenuItem | null | false> {
  const revision = row.oid;
  const parent = row.parentOid ?? null;
  const fullPath = fileAbsolutePath(repo, row.path);

  const openDiff = (forceNew: boolean) =>
    openers.openDiff({
      oid: revision,
      path: row.path,
      oldPath: row.oldPath ?? null,
      staged: revision === null && row.staged === true,
      forceNew,
    });

  const editSource = () => {
    void (async () => {
      if (!row.deleted && (await openers.openFile(fullPath))) return;
      const fallback = revision ?? headOid;
      if (fallback) openers.openRevisionFile(fallback, row.path);
      else toast.error(t("projectGit.editorUnavailable"));
    })();
  };

  const restore = (rev: string) => void runRestoreFile(repo, row.path, rev, t);

  const createPatch = () => {
    if (!revision || !parent) return;
    void (async () => {
      const destination = await pickSaveFile({
        defaultPath: `${basename(row.path)}.patch`,
        filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
      });
      if (!destination) return;
      try {
        await patchSave(repo, parent, revision, destination);
        toast.success(t("projectGit.toast.patchSaved"));
      } catch (error) {
        toast.error(`${t("projectGit.toast.patchFailed")}: ${errorText(error)}`);
      }
    })();
  };

  const extract = () => {
    if (!revision) return;
    setInput({
      title: t("projectGit.dialog.extract.title"),
      description: t("projectGit.dialog.extract.description", { path: row.path }),
      label: t("projectGit.dialog.extract.label"),
      initialValue: basename(row.path),
      multiline: true,
      confirmLabel: t("projectGit.dialog.extract.submit"),
      submit: (message) =>
        runGitAction({
          id: "file.extract",
          label: t("projectGit.menu.file.extractToCommit"),
          run: () => commitExtractPaths(repo, revision, [row.path], message),
        }),
    });
  };

  const drop = () => {
    if (revision) void runDropFileChanges(repo, row.path, revision, t);
  };

  const copyPath = () => copyFilePath(row.path, t);

  const openWorkingFile = () => {
    void openPath(fullPath).catch((error: unknown) =>
      toast.error(`${t("gitRepo.inspector.fileMenu.openFailed")}: ${errorText(error)}`)
    );
  };

  const revealFile = () => {
    void revealPath(fullPath).catch((error: unknown) =>
      toast.error(`${t("gitRepo.inspector.fileMenu.revealFailed")}: ${errorText(error)}`)
    );
  };

  const common: Array<ProjectMenuItem | null | false> = [
    {
      id: "file.diff",
      label: t("projectGit.menu.file.diff"),
      icon: <FileDiff />,
      shortcut: `${modifier}+D`,
      // Suppressed when the caller offers nothing above it.
      separatorBefore: true,
      onSelect: () => openDiff(false),
    },
    {
      id: "file.diffNewTab",
      label: t("projectGit.menu.file.diffNewTab"),
      icon: <FilePlus2 />,
      onSelect: () => openDiff(true),
    },
    {
      id: "file.editSource",
      label: t("projectGit.menu.file.editSource"),
      icon: <Pencil />,
      shortcut: "F4",
      onSelect: editSource,
    },
    {
      id: "file.history",
      label: t("projectGit.menu.file.history"),
      icon: <History />,
      onSelect: () => openers.openFileHistory(row.path, revision ?? undefined),
    },
    {
      id: "file.copyPath",
      label: t("projectGit.menu.file.copyPath"),
      icon: <Copy />,
      separatorBefore: true,
      onSelect: copyPath,
    },
    {
      id: "file.reveal",
      label: t("gitRepo.inspector.fileMenu.reveal"),
      icon: <FolderOpen />,
      onSelect: revealFile,
    },
    {
      id: "file.open",
      label: t("gitRepo.inspector.fileMenu.openExternal"),
      icon: <ExternalLink />,
      onSelect: openWorkingFile,
    },
  ];

  if (!revision) {
    return [
      ...common.slice(0, 3),
      {
        id: "file.compareWorktree",
        label: t("projectGit.menu.file.compareWorktree"),
        icon: <GitCompare />,
        disabled: headOid === null,
        disabledReason: t("projectGit.error.notAtHead"),
        onSelect: () => headOid && openers.openCompare(headOid, null, row.path),
      },
      {
        id: "file.openRepoVersion",
        label: t("projectGit.menu.file.openRepoVersion"),
        icon: <FileCode />,
        disabled: headOid === null,
        disabledReason: t("projectGit.error.notAtHead"),
        onSelect: () => headOid && openers.openRevisionFile(headOid, row.path),
      },
      {
        id: "file.restore",
        label: t("projectGit.menu.file.restore"),
        icon: <Undo2 />,
        separatorBefore: true,
        destructive: true,
        shortcut: "Del",
        disabled: headOid === null,
        disabledReason: t("projectGit.error.notAtHead"),
        onSelect: () => headOid && restore(headOid),
      },
      ...common.slice(3),
    ];
  }

  return [
    ...common.slice(0, 2),
    {
      id: "file.changesFromParent",
      label: t("projectGit.menu.file.changesFromParent"),
      icon: <GitCompare />,
      disabled: parent === null,
      disabledReason: t("projectGit.error.noParentCommit"),
      onSelect: () => parent && openDiff(false),
    },
    {
      id: "file.compareWithLocal",
      label: t("projectGit.menu.file.compareWithLocal"),
      icon: <GitCompare />,
      onSelect: () => openers.openCompare(revision, null, row.path),
    },
    {
      id: "file.comparePrevWithLocal",
      label: t("projectGit.menu.file.comparePrevWithLocal"),
      icon: <GitCompare />,
      disabled: parent === null,
      disabledReason: t("projectGit.error.noParentCommit"),
      onSelect: () => parent && openers.openCompare(parent, null, row.path),
    },
    common[2],
    {
      id: "file.openRepoVersion",
      label: t("projectGit.menu.file.openRepoVersion"),
      icon: <FileCode />,
      onSelect: () => openers.openRevisionFile(revision, row.path),
    },
    {
      id: "file.restore",
      label: t("projectGit.menu.file.restore"),
      icon: <Undo2 />,
      separatorBefore: true,
      destructive: true,
      shortcut: "Del",
      onSelect: () => restore(revision),
    },
    {
      id: "file.getFromRevision",
      label: t("projectGit.menu.file.getFromRevision"),
      icon: <Undo2 />,
      disabled: parent === null,
      disabledReason: t("projectGit.error.noParentCommit"),
      onSelect: () => parent && restore(parent),
    },
    {
      id: "file.cherryPick",
      label: t("projectGit.menu.file.cherryPick"),
      icon: <ListRestart />,
      separatorBefore: true,
      onSelect: () =>
        void runGitAction({
          id: "file.cherryPick",
          label: t("projectGit.menu.file.cherryPick"),
          run: () => cherryPickPaths(repo, revision, [row.path], false),
        }),
    },
    {
      id: "file.extractToCommit",
      label: t("projectGit.menu.file.extractToCommit"),
      icon: <Scissors />,
      onSelect: extract,
    },
    {
      id: "file.dropChanges",
      label: t("projectGit.menu.file.dropChanges"),
      icon: <Trash2 />,
      destructive: true,
      onSelect: drop,
    },
    {
      id: "file.createPatch",
      label: t("projectGit.menu.file.createPatch"),
      icon: <Download />,
      separatorBefore: true,
      disabled: parent === null,
      disabledReason: t("projectGit.error.noParentCommit"),
      onSelect: createPatch,
    },
    common[3],
    ...common.slice(4),
  ];
}
