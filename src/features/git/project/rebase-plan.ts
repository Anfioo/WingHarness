import { rebaseCommits, rebaseInteractive } from "@/commands";
import type { CommitInfo, RebaseTodoAction, RebaseTodoEntry } from "@/lib/git-core";
import { refreshGitViews } from "./actions";

/** The full message a reword starts from: subject, a blank line, then the body. */
export function fullMessage(commit: CommitInfo): string {
  return commit.body ? `${commit.summary}\n\n${commit.body}` : commit.summary;
}

/**
 * Rewrites `base..HEAD` with the real range from git rather than the rows on
 * screen, so a commit picked in a filtered or partly loaded log is either in the
 * range or refused before anything moves.
 */
export async function executeRewrite(
  repo: string,
  base: string,
  actionOf: (oid: string) => RebaseTodoAction,
  options: { messages?: Map<string, string>; required?: string[]; missingMessage: string }
): Promise<void> {
  const range = await rebaseCommits(repo, base);
  const known = new Set(range.map((commit) => commit.oid));
  for (const oid of options.required ?? []) {
    if (!known.has(oid)) throw new Error(options.missingMessage);
  }
  if (range.length === 0) return;

  const todo: RebaseTodoEntry[] = [...range].reverse().map((commit) => {
    const action = actionOf(commit.oid);
    const entry: RebaseTodoEntry = { oid: commit.oid, action };
    const message = options.messages?.get(commit.oid);
    if (message && (action === "reword" || action === "squash")) entry.message = message;
    return entry;
  });
  await rebaseInteractive(repo, base, todo);
  await refreshGitViews();
}

/**
 * Folds `sources` into `target`: the plan is the whole `target~1..HEAD` range,
 * with the sources moved directly above the target and marked `fixup` or
 * `squash`. Moving them is what makes the fold land on the chosen commit rather
 * than on whatever happened to precede each source.
 */
export async function foldInto(
  repo: string,
  target: CommitInfo,
  sources: readonly CommitInfo[],
  action: "fixup" | "squash",
  missingMessage: string
): Promise<void> {
  const base = target.parents[0];
  if (!base) throw new Error(missingMessage);

  const range = await rebaseCommits(repo, base);
  const known = new Set(range.map((commit) => commit.oid));
  const sourceOids = new Set(sources.map((commit) => commit.oid));
  for (const oid of [target.oid, ...sourceOids]) {
    if (!known.has(oid)) throw new Error(missingMessage);
  }

  const oldestFirst = [...range].reverse();
  const folds = oldestFirst.filter((commit) => sourceOids.has(commit.oid));
  const rest = oldestFirst.filter((commit) => !sourceOids.has(commit.oid));
  const targetIndex = rest.findIndex((commit) => commit.oid === target.oid);
  if (targetIndex < 0 || folds.length === 0) throw new Error(missingMessage);
  rest.splice(targetIndex + 1, 0, ...folds);

  const todo: RebaseTodoEntry[] = rest.map((commit) => ({
    oid: commit.oid,
    action: sourceOids.has(commit.oid) ? action : "pick",
  }));
  await rebaseInteractive(repo, base, todo);
  await refreshGitViews();
}
