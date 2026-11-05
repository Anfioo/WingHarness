import { buildChangeTree, type ChangeNode } from "@/lib/svn-core/change-tree";
import type { SvnStatus } from "@/lib/svn-core/types";
import type { ChangeTreeRow } from "@/components/svn-workspace/file-tree";

/** The active filter. `modified` is the reference's "Changes" grouping. */
export type ChangeFilter =
  | "all"
  | "modified"
  | "added"
  | "deleted"
  | "unversioned"
  | "conflicted"
  | "missing";

export const CHANGE_FILTERS: ChangeFilter[] = [
  "all",
  "modified",
  "added",
  "deleted",
  "unversioned",
  "conflicted",
  "missing",
];

const CHANGED = new Set(["modified", "added", "deleted", "replaced"]);

export function matchesFilter(entry: SvnStatus, filter: ChangeFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "modified":
      return CHANGED.has(entry.statusCode) || entry.propStatus === "modified";
    case "added":
      return entry.statusCode === "added";
    case "deleted":
      return entry.statusCode === "deleted";
    case "unversioned":
      return entry.statusCode === "unversioned";
    case "conflicted":
      return entry.statusCode === "conflicted" || entry.propStatus === "conflicted";
    case "missing":
      return entry.statusCode === "missing";
  }
}

/** How many entries a filter chip should show. */
export function countFilter(entries: SvnStatus[], filter: ChangeFilter): number {
  let count = 0;
  for (const entry of entries) if (matchesFilter(entry, filter)) count += 1;
  return count;
}

/** Case-insensitive path search; an empty query is the identity. */
export function searchEntries(entries: SvnStatus[], query: string): SvnStatus[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.path.toLowerCase().includes(needle));
}

/**
 * Flatten the change tree into the lines the virtualizer renders. Directories
 * that are themselves changed entries stay in the list (their checkbox still
 * cascades over the subtree). While searching, collapsed directories are
 * ignored so a match is never hidden behind a folded parent.
 */
export function flattenRows(
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
      if (hasChildren && (searching || !collapsed.has(child.path))) {
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 0);
  return rows;
}

/** The file paths between two row indices, inclusive — the shift-click range. */
export function filePathsBetween(rows: ChangeTreeRow[], a: number, b: number): string[] {
  const start = Math.max(0, Math.min(a, b));
  const end = Math.min(rows.length - 1, Math.max(a, b));
  const paths: string[] = [];
  for (let i = start; i <= end; i += 1) {
    if (rows[i].kind === "file") paths.push(rows[i].path);
  }
  return paths;
}

/** Turn a directory/file checkbox: add every target when checked, remove when not. */
export function applyToggle(selection: string[], targets: string[], checked: boolean): string[] {
  const set = new Set(selection);
  for (const target of targets) {
    if (checked) set.add(target);
    else set.delete(target);
  }
  return [...set];
}

export function allSelected(selection: Set<string>, targets: string[]): boolean {
  return targets.length > 0 && targets.every((path) => selection.has(path));
}

/** Union of the current selection and the given paths, order-stable. */
export function unionPaths(selection: string[], paths: string[]): string[] {
  const set = new Set(selection);
  for (const path of paths) set.add(path);
  return [...set];
}
