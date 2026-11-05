import { buildChangeTree, type ChangeNode } from "@/lib/svn-core/change-tree";
import type { SvnStatus } from "@/lib/svn-core";
import type { ChangeTreeRow } from "@/components/svn-workspace/file-tree";

/**
 * Pure helpers for the commit panel. Kept framework-free so the selection and
 * filtering rules are unit-testable and independent of the tree component.
 *
 * The reference's `CommittableView` derived its file list from the workspace
 * status list, excluding conflicts (those must be resolved first) and keeping
 * only statuses SVN can actually record in a commit:
 * `added` / `modified` / `deleted` / `replaced` / `unversioned`, plus any entry
 * whose property status changed.
 */

/** Statuses a commit can record directly. */
export const COMMITTABLE_STATUSES = new Set([
  "added",
  "modified",
  "deleted",
  "replaced",
  "unversioned",
]);

export type CommitFilterMode = "all" | "committable" | "unversioned";

/** A conflict, in content or in properties, blocks a partial commit. */
export function isConflicted(entry: SvnStatus): boolean {
  return entry.statusCode === "conflicted" || entry.propStatus === "conflicted";
}

export function isUnversioned(entry: SvnStatus): boolean {
  return entry.statusCode === "unversioned";
}

/** Whether a status list entry may be committed. */
export function isCommittable(entry: SvnStatus): boolean {
  return COMMITTABLE_STATUSES.has(entry.statusCode) || entry.propStatus === "modified";
}

/** Every committable entry that is not conflicted — the reference's `changedFiles`. */
export function committableEntries(list: SvnStatus[]): SvnStatus[] {
  return list.filter((entry) => isCommittable(entry) && !isConflicted(entry));
}

/** Conflicted entries — they are shown, but blocked from the commit. */
export function conflictedEntries(list: SvnStatus[]): SvnStatus[] {
  return list.filter(isConflicted);
}

/** Unversioned entries within a selection set. */
export function unversionedSelection(entries: SvnStatus[], selection: Set<string>): string[] {
  return entries
    .filter((entry) => isUnversioned(entry) && selection.has(entry.path))
    .map((entry) => entry.path);
}

export function defaultSelection(entries: SvnStatus[]): string[] {
  return entries.map((entry) => entry.path);
}

/** The visible entries for the active filter and search query, sorted like the
 *  reference: versioned files first, then unversioned, each alphabetically. */
export function filterCommitEntries(
  entries: SvnStatus[],
  mode: CommitFilterMode,
  query: string
): SvnStatus[] {
  const needle = query.trim().toLowerCase();
  let files = entries;
  if (needle) files = files.filter((entry) => entry.path.toLowerCase().includes(needle));
  if (mode === "committable") files = files.filter((entry) => !isUnversioned(entry));
  else if (mode === "unversioned") files = files.filter(isUnversioned);

  return [...files].sort((a, b) => {
    const aUntracked = isUnversioned(a) ? 1 : 0;
    const bUntracked = isUnversioned(b) ? 1 : 0;
    if (aUntracked !== bUntracked) return aUntracked - bUntracked;
    return a.path.localeCompare(b.path);
  });
}

export function countMode(entries: SvnStatus[], mode: CommitFilterMode): number {
  if (mode === "committable") return entries.filter((entry) => !isUnversioned(entry)).length;
  if (mode === "unversioned") return entries.filter(isUnversioned).length;
  return entries.length;
}

/**
 * Flatten the change tree into the virtualized rows the shared `FileTree`
 * renders. While searching, collapsed directories are ignored so a match is
 * never hidden behind a folded parent.
 */
export function flattenCommitRows(
  entries: SvnStatus[],
  collapsed: Set<string>,
  searching: boolean
): ChangeTreeRow[] {
  const roots = buildChangeTree(entries, "");
  const root = roots[0];
  if (!root) return [];

  const rows: ChangeTreeRow[] = [];
  const walk = (node: ChangeNode, depth: number) => {
    for (const child of node.children) {
      const hasChildren = child.children.length > 0;
      rows.push({
        kind: hasChildren ? "dir" : "file",
        path: child.path,
        label: child.label,
        depth,
        entry: child.entry,
        targets: child.targets,
      });
      if (hasChildren && (searching || !collapsed.has(child.path))) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Whether every target of a row is currently selected. */
export function rowChecked(selection: Set<string>, targets: string[]): boolean {
  return targets.length > 0 && targets.every((path) => selection.has(path));
}

/** Add or remove a set of paths, returning a new selection array. */
export function applyToggle(selection: string[], targets: string[], checked: boolean): string[] {
  const set = new Set(selection);
  for (const target of targets) {
    if (checked) set.add(target);
    else set.delete(target);
  }
  return [...set];
}
