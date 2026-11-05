import type { StashEntry, StashUnversionedEntry, SvnStatus } from "@/lib/svn-core/types";

/**
 * Pure helpers for the stash panel, ported from the reference's `StashView.vue`
 * script block. Everything here is framework-free so the panel component stays
 * about rendering and orchestration.
 */

/** The statuses whose content can be captured into a stash patch. */
const STASHABLE_STATUSES = new Set(["modified", "added", "deleted", "replaced"]);

/** A status that is neither `normal` nor blank. */
export function changedFiles(list: SvnStatus[]): SvnStatus[] {
  return list.filter((entry) => entry.statusCode !== "normal" && entry.statusCode !== "");
}

/** The content-changed files a `svn diff` can turn into a patch. */
export function stashableFiles(list: SvnStatus[]): SvnStatus[] {
  return changedFiles(list).filter((entry) => STASHABLE_STATUSES.has(entry.statusCode));
}

/** Whether `path` lives under `parent` (both normalised to `/`). */
export function isDescendant(path: string, parent: string): boolean {
  const target = path.replace(/\\/g, "/");
  const root = parent.replace(/\\/g, "/").replace(/\/$/, "");
  return target !== root && target.startsWith(`${root}/`);
}

/**
 * The unversioned roots only: a nested path is dropped when one of its
 * ancestors is also unversioned, because capturing the ancestor already
 * captures it. Mirrors the reference's `unversionedFiles` computed.
 */
export function unversionedRoots(list: SvnStatus[]): SvnStatus[] {
  const unversioned = changedFiles(list).filter((entry) => entry.statusCode === "unversioned");
  return unversioned.filter(
    (entry) => !unversioned.some((parent) => isDescendant(entry.path, parent.path))
  );
}

/** Decode a captured file's base64 content for preview; `null` when binary. */
export function decodePreview(entry: StashUnversionedEntry): string | null {
  if (!entry.contentBase64) return entry.kind === "file" ? "" : null;
  try {
    const bytes = Uint8Array.from(atob(entry.contentBase64), (char) => char.charCodeAt(0));
    if (bytes.includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Rough byte size of a base64 payload, as the reference displayed it. */
export function formatContentSize(content?: string | null): string {
  return `${Math.floor(((content?.length ?? 0) * 3) / 4)} B`;
}

/** How many of a stash's top-level paths are unversioned captures. */
export function unversionedRootCount(entry: StashEntry): number {
  const paths = new Set(entry.unversionedFiles?.map((file) => file.path));
  return entry.files.filter((path) => paths.has(path)).length;
}

/** A unified-diff line's colour class, ignoring the `+++` / `---` file headers. */
export function lineClass(line: string): string {
  if (line.startsWith("\\")) return "text-muted-foreground";
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-success";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-destructive";
  return "text-foreground";
}

/** A patch filename derived from a stash name, safe for the filesystem. */
export function exportFileName(name: string): string {
  return `${name.replace(/[^\w\-. ]+/g, "_")}.patch`;
}
