/**
 * Working-copy writes from the project page's commit view.
 *
 * Every action goes through the console, refreshes the repository store and the
 * Git views, and reports through a toast, so the page never shows a stale index.
 */
import { toast } from "sonner";
import i18n from "@/i18n";
import { discardFile, discardStagedFile, stageFile, unstageFile } from "@/commands";
import { confirmDialog } from "@/components/confirm";
import { useProjectRepo } from "./project-repo-store";
import type { FileStatus } from "@/lib/git-core";
import { trackGit } from "./git-console";
import { useGitView } from "./git-view-store";

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-reads the repository store, and asks the log to reload once it is done. */
export async function refreshRepository(repo: string, full = false): Promise<void> {
  const state = useProjectRepo.getState();
  if (state.repo?.path === repo) {
    await (full ? state.refresh() : state.refreshStatus());
  }
  useGitView.getState().requestRefresh();
}

async function runFileOp(
  repo: string,
  command: string,
  run: () => Promise<void>
): Promise<boolean> {
  try {
    await trackGit(repo, command, run);
  } catch (error) {
    toast.error(`${i18n.t("projectGit.fileOpFailed")}: ${errorText(error)}`);
    return false;
  }
  await refreshRepository(repo);
  return true;
}

export function stageFileAction(repo: string, file: FileStatus): Promise<boolean> {
  return runFileOp(repo, `git add -- ${file.path}`, () => stageFile(repo, file.path));
}

export function unstageFileAction(repo: string, file: FileStatus): Promise<boolean> {
  return runFileOp(repo, `git reset HEAD -- ${file.path}`, () => unstageFile(repo, file.path));
}

function discardDescription(file: FileStatus): string {
  if (file.staged) {
    return i18n.t(
      file.staged === "new"
        ? "gitRepo.commit.discard.descStagedNew"
        : "gitRepo.commit.discard.descStaged"
    );
  }
  if (file.unstaged === "untracked") return i18n.t("gitRepo.commit.discard.descUntracked");
  return i18n.t("gitRepo.commit.discard.descUnstaged");
}

/**
 * Reverts a file after asking: staged changes go back to HEAD (which also drops
 * its unstaged edits), everything else only loses the working-tree change.
 */
export async function discardFileAction(repo: string, file: FileStatus): Promise<boolean> {
  const confirmed = await confirmDialog({
    title: i18n.t("gitRepo.commit.discard.title"),
    description: discardDescription(file),
    path: file.path,
    confirmLabel: i18n.t("gitRepo.commit.discard.confirm"),
    destructive: true,
  });
  if (!confirmed) return false;

  let applied = true;
  const command = file.staged
    ? `git checkout HEAD -- ${file.path}`
    : `git checkout -- ${file.path}`;
  try {
    applied = await trackGit(repo, command, () =>
      file.staged ? discardStagedFile(repo, file.path) : discardFile(repo, file.path)
    );
  } catch (error) {
    toast.error(i18n.t("gitRepo.commit.discard.failed", { message: errorText(error) }));
    return false;
  }
  await refreshRepository(repo);
  if (!applied) {
    toast.warning(i18n.t("gitRepo.commit.discard.leftoverFile", { path: file.path }));
    return false;
  }
  toast.success(i18n.t("gitRepo.commit.toast.discarded", { count: 1 }));
  return true;
}
