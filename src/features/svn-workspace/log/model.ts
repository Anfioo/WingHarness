import type { SvnInfo, SvnLogEntry, SvnLogPath } from "@/lib/svn-core/types";
import type { SvnDiffTarget } from "@/features/svn-workspace/store";

/**
 * Pure helpers for the log panel: revision normalization, date formatting, and
 * the mapping between a revision's repository-relative changed paths and the
 * working-copy-relative (or repository-URL) targets the diff and blame panels
 * expect. Kept out of the component so the rules are readable and testable.
 */

/** Clone + de-duplicate by revision, newest first, as the reference did. */
export function normalizeLogEntries(entries: SvnLogEntry[]): SvnLogEntry[] {
  const seen = new Set<number>();
  const unique: SvnLogEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.revision)) continue;
    seen.add(entry.revision);
    unique.push({ ...entry, changedPaths: [...(entry.changedPaths ?? [])] });
  }
  return unique.sort((a, b) => {
    if (b.revision !== a.revision) return b.revision - a.revision;
    return Date.parse(b.date || "") - Date.parse(a.date || "");
  });
}

/**
 * SVN timestamps carry microsecond fractions, which `Date` does not parse
 * everywhere; trim them to milliseconds before formatting, and fall back to the
 * raw string when the value is still unparseable.
 */
export function formatLogDate(value: string, locale: string): string {
  if (!value) return "";
  const trimmed = value.replace(/(\.\d{3})\d+/, "$1");
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale);
}

/** A repository path always starts with a single slash. */
export function toRepositoryPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/** The absolute repository URL of a changed path. */
export function changedPathUrl(path: string, repositoryRoot: string): string {
  return `${stripTrailingSlashes(repositoryRoot)}${toRepositoryPath(path)}`;
}

/**
 * Map a repository-relative changed path to a working-copy-relative path, using
 * the working copy's URL as the prefix. Returns `null` when the path lies
 * outside the working copy (or is the working-copy root itself), which is when
 * blame and "reveal" are not possible.
 */
export function workspaceRelativeForRepoPath(path: string, info: SvnInfo | null): string | null {
  if (!info?.url || !info.repositoryRoot) return null;
  const full = changedPathUrl(path, info.repositoryRoot);
  const base = stripTrailingSlashes(info.url);
  const fullLower = full.toLowerCase();
  const baseLower = base.toLowerCase();
  if (fullLower === baseLower) return null;
  if (!fullLower.startsWith(`${baseLower}/`)) return null;
  return full.slice(base.length + 1);
}

/** A diff target path is workspace-relative (revealable) rather than a URL. */
export function isWorkspaceRelativePath(path: string): boolean {
  return !path.includes("://") && !/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith("\\\\");
}

/**
 * The diff target for one changed path at a revision. The peg revision pins the
 * node's existence: a deletion must be pegged to the revision before it, so the
 * path still resolves in history. The range is `revision - 1 → revision`, which
 * shows exactly what that commit changed.
 */
export function changedPathDiffTarget(
  path: string,
  info: SvnInfo | null,
  revision: number,
  action: string
): SvnDiffTarget {
  const root = info?.repositoryRoot || "";
  const repositoryPath = toRepositoryPath(path);
  const peg = action === "D" && revision > 0 ? revision - 1 : revision;
  const oldRevision = revision > 0 ? revision - 1 : 0;
  return {
    path: root
      ? `${stripTrailingSlashes(root)}${repositoryPath}@${peg}`
      : `${repositoryPath}@${peg}`,
    oldRevision,
    newRevision: revision,
  };
}

/** Join a working-copy path with a relative path for clipboard/reveal calls. */
export function joinWorkspacePath(workspacePath: string, filePath: string): string {
  if (!isWorkspaceRelativePath(filePath)) return filePath;
  const separator = workspacePath.includes("\\") ? "\\" : "/";
  return `${stripTrailingSlashes(workspacePath).replace(/\\/g, separator)}${separator}${filePath.replace(/^[\\/]+/, "")}`;
}

/** The i18n key for a changed-path action code, mirroring the reference. */
export function actionLabelKey(action: string): string {
  switch (action) {
    case "A":
      return "svnWorkspace.common.status.added";
    case "D":
      return "svnWorkspace.common.status.deleted";
    case "M":
      return "svnWorkspace.common.status.modified";
    case "R":
      return "svnWorkspace.common.status.replaced";
    default:
      return action;
  }
}

/** Sorted unique authors seen so far, for the author filter. */
export function collectAuthors(entries: SvnLogEntry[], into: Set<string>): Set<string> {
  const next = new Set(into);
  for (const entry of entries) {
    if (entry.author) next.add(entry.author);
  }
  return next;
}

export type { SvnLogPath };
