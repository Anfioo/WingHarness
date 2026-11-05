import { create } from "zustand";
import { toast } from "sonner";
import i18n from "@/i18n";
import { toastOutcome } from "@/features/git/toast-outcome";
import { useGitView } from "./git-view-store";
import { useProjectRepo } from "./project-repo-store";

/**
 * One entry a context menu offers, and the work it does.
 *
 * The runner below is the only place a Git command is awaited from the project
 * page, so busy state, refreshes and outcome wording stay identical across the
 * branch, commit and file menus.
 */
export interface GitAction {
  id: string;
  label: string;
  run: () => Promise<unknown>;
  disabled?: boolean;
  /** Already-translated reason the action is unavailable, shown as the item's tooltip. */
  disabledReason?: string;
  /** Toast shown when the action resolves without an `OpOutcome`. */
  success?: string;
  /** Destructive actions must be confirmed by the caller before `run` is reached. */
  destructive?: boolean;
}

interface GitActionsState {
  /** The id of the action in flight, or null when nothing is running. */
  busy: string | null;
  begin: (id: string) => void;
  end: () => void;
}

export const useGitActions = create<GitActionsState>((set) => ({
  busy: null,
  begin: (busy) => set({ busy }),
  end: () => set({ busy: null }),
}));

function asOutcome(value: unknown): { status: string; message?: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const status = (value as { status?: unknown }).status;
  if (typeof status !== "string") return null;
  return value as { status: string; message?: string };
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Rebase and cherry-pick report a conflict through the error code, not an outcome. */
function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "conflict"
  );
}

/**
 * Runs one menu action: one at a time, conflicts reported as a state that needs
 * resolving rather than a failure, then every view re-reads the working copy.
 */
export async function runGitAction(action: GitAction): Promise<void> {
  const store = useGitActions.getState();
  if (store.busy !== null) return;
  store.begin(action.id);

  let succeeded = false;
  try {
    const outcome = asOutcome(await action.run());
    const successText = action.success ?? action.label;
    if (outcome?.status === "conflicts") {
      // Conflicts are a stopping point, not an error: the commit view is where
      // this page resolves them.
      useGitView.getState().openChanges();
      toast.warning(outcome.message || i18n.t("projectGit.mergeConflicts"));
    } else if (outcome) {
      toastOutcome(outcome, successText);
      succeeded = outcome.status !== "failed";
    } else {
      toast.success(successText);
      succeeded = true;
    }
  } catch (error) {
    // A plan that would conflict is refused before anything moves: warn about it
    // instead of reporting a failure the reader cannot act on.
    if (isConflict(error)) toast.warning(errorText(error));
    else toast.error(errorText(error));
  } finally {
    useGitActions.getState().end();
  }

  if (!succeeded) return;
  await refreshGitViews();
}

/** Re-reads the working copy after a command that ran outside `runGitAction`. */
export async function refreshGitViews(): Promise<void> {
  useGitView.getState().requestRefresh();
  await useProjectRepo
    .getState()
    .refresh()
    .catch(() => undefined);
}
