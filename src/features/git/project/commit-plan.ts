/** Commit tool window model: change groups, inclusion rules, and the index plan (pure). */
import type { FileStatus } from "@/lib/git-core";
import { effectiveKind } from "@/lib/editor/vcs-decorations";

export type GroupId = "conflicts" | "changes" | "unversioned";

/**
 * What a file's checkbox means for the next commit:
 * `all` stages every unstaged change first; `none` keeps the file out, unstaging it
 * if it was in the index; `staged` commits only what the index already holds;
 * `hunks` commits selected blocks, which this phase falls back to `all` for.
 */
export type CheckState = "all" | "none" | "staged" | "hunks";

export interface CommitPlan {
  /** Files to add to the index before committing. */
  stage: string[];
  /** Files to take out of the index before committing. */
  unstage: string[];
  /** Files whose changes end up in the commit. */
  included: FileStatus[];
  /** Files the check left with only some blocks chosen. */
  partial: string[];
}

export function groupOf(file: FileStatus): GroupId | null {
  const kind = effectiveKind(file);
  if (!kind || kind === "ignored") return null;
  if (kind === "conflicted") return "conflicts";
  if (kind === "untracked") return "unversioned";
  return "changes";
}

/** A file whose index entry and working copy both hold changes. */
export function isPartiallyStaged(file: FileStatus): boolean {
  return (
    !!file.staged &&
    !!file.unstaged &&
    file.unstaged !== "untracked" &&
    file.unstaged !== "conflicted" &&
    file.staged !== "conflicted"
  );
}

/**
 * Whether a file starts ticked: conflicts and unversioned files are opt-in, and a
 * file that is already staged only commits the staged half unless asked otherwise.
 */
export function initialCheck(file: FileStatus): CheckState {
  if (groupOf(file) !== "changes") return "none";
  return isPartiallyStaged(file) ? "staged" : "all";
}

export function checkOf(file: FileStatus, checks: ReadonlyMap<string, CheckState>): CheckState {
  return checks.get(file.path) ?? initialCheck(file);
}

export function aggregateCheck(
  files: readonly FileStatus[],
  checks: ReadonlyMap<string, CheckState>
): { checked: boolean; indeterminate: boolean; on: number } {
  let on = 0;
  let partial = false;
  for (const file of files) {
    const check = checkOf(file, checks);
    if (check !== "none") on += 1;
    if (check === "staged" || check === "hunks") partial = true;
  }
  return {
    checked: on > 0 && on === files.length && !partial,
    indeterminate: (on > 0 && on < files.length) || partial,
    on,
  };
}

/**
 * What to stage and unstage so the index holds exactly the ticked files.
 *
 * The commit itself takes the whole index, so unticking a file that is already
 * staged has to unstage it — leaving it there would commit it anyway.
 */
export function planCommit(
  status: readonly FileStatus[],
  checks: ReadonlyMap<string, CheckState>
): CommitPlan {
  const plan: CommitPlan = { stage: [], unstage: [], included: [], partial: [] };
  for (const file of status) {
    if (!groupOf(file)) continue;
    const check = checkOf(file, checks);
    if (check === "none") {
      if (file.staged && file.staged !== "conflicted") {
        plan.unstage.push(file.path);
        // A staged rename is a deletion plus an addition: keeping only the
        // addition staged would commit half of it.
        if (file.origPath) plan.unstage.push(file.origPath);
      }
      continue;
    }
    if (check === "all" && file.unstaged && file.unstaged !== "conflicted") {
      plan.stage.push(file.path);
    }
    if (check === "staged" && !file.staged) continue;
    if (check === "hunks") plan.partial.push(file.path);
    plan.included.push(file);
  }
  return plan;
}

/** Toggling one checkbox: anything included goes out, anything out comes in. */
export function toggledCheck(current: CheckState): CheckState {
  return current === "none" ? "all" : "none";
}
