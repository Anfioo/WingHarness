// Pure path and entry helpers for the file panes.
//
// Local paths are Windows absolute paths, remote paths are POSIX absolute
// paths. Everything here is side-aware so the two panes share one code path.

import { isServerError } from "@/commands/services/servers/types";
import type { SftpEntry } from "@/commands/services/servers/types";
import type { DragPayload, Side, SortState } from "./types";

/** Mirrors `server_core::sftp::ops::MAX_LIST_ENTRIES`. */
export const MAX_LIST_ENTRIES = 5000;

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "svg",
  "yml",
  "yaml",
  "toml",
  "ini",
  "conf",
  "cfg",
  "log",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sql",
  "csv",
  "tsv",
  "env",
  "properties",
  "gradle",
]);

/** Last segment of either path flavour. A trailing separator is ignored. */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return path;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** Parent directory; roots stay their own parent. */
export function parentPath(side: Side, path: string): string {
  if (!path) return path;

  if (side === "remote") {
    if (path === "/") return "/";
    const trimmed = path.replace(/\/+$/, "");
    if (!trimmed) return "/";
    const index = trimmed.lastIndexOf("/");
    if (index < 0) return ".";
    if (index === 0) return "/";
    return trimmed.slice(0, index);
  }

  const driveRoot = /^([A-Za-z]:)[\\/]*$/.exec(path);
  if (driveRoot) return `${driveRoot[1]}\\`;

  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return path;
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index < 0) return trimmed;
  if (index === 2 && /^[A-Za-z]:$/.test(trimmed.slice(0, 2))) return `${trimmed.slice(0, 2)}\\`;
  if (index === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, index);
}

export function canGoUp(side: Side, path: string): boolean {
  return Boolean(path) && parentPath(side, path) !== path;
}

/** Join one entry name onto a directory. */
export function joinPath(side: Side, dir: string, name: string): string {
  if (side === "remote") {
    if (!dir || dir === "/") return `/${name}`;
    return `${dir.replace(/\/+$/, "")}/${name}`;
  }
  if (/[\\/]$/.test(dir)) return `${dir}${name}`;
  if (/^[A-Za-z]:$/.test(dir)) return `${dir}\\${name}`;
  return `${dir}\\${name}`;
}

/** Segments for the breadcrumb, root included. */
export function pathSegments(side: Side, path: string): { label: string; path: string }[] {
  if (side === "remote") {
    const segments = [{ label: "/", path: "/" }];
    let prefix = "/";
    for (const part of path.split("/").filter(Boolean)) {
      prefix = prefix === "/" ? `/${part}` : `${prefix}/${part}`;
      segments.push({ label: part, path: prefix });
    }
    return segments;
  }

  const driveMatch = /^([A-Za-z]:)[\\/]?/.exec(path);
  const rootLabel = driveMatch ? `${driveMatch[1]}\\` : path.startsWith("\\\\") ? "\\\\" : "";
  if (!rootLabel) return [{ label: path, path }];

  const segments = [{ label: rootLabel, path: rootLabel }];
  let prefix = rootLabel;
  for (const part of path
    .slice(rootLabel.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    prefix = /[\\/]$/.test(prefix) ? `${prefix}${part}` : `${prefix}\\${part}`;
    segments.push({ label: part, path: prefix });
  }
  return segments;
}

/** Directories first, then the requested column, with the name as tiebreaker. */
export function sortEntries(entries: SftpEntry[], sort: SortState): SftpEntry[] {
  const factor = sort.direction === "asc" ? 1 : -1;
  const byName = (left: SftpEntry, right: SftpEntry) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });

  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;

    let primary = 0;
    if (sort.key === "size") primary = left.size - right.size;
    else if (sort.key === "modifiedAt") primary = (left.modifiedAt ?? 0) - (right.modifiedAt ?? 0);
    else primary = byName(left, right);

    if (primary === 0 && sort.key !== "name") primary = byName(left, right);
    return primary * factor;
  });
}

/** Whether the preview dialog offers this file as text. */
export function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower === "makefile" || lower === "license") return true;

  const index = lower.lastIndexOf(".");
  if (index <= 0) return lower.startsWith(".") && lower.length > 1;
  return TEXT_EXTENSIONS.has(lower.slice(index + 1));
}

/** One-segment check before a mkdir/rename reaches the engine. */
export function isValidEntryName(side: Side, name: string): boolean {
  if (!name.trim() || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\0")) return false;
  if (side === "local" && name.includes("\\")) return false;
  return true;
}

/** The engine signals an oversized directory with `detail.limit`. */
export function tooManyEntryLimit(error: unknown): number | null {
  if (!isServerError(error) || !error.detail) return null;
  const limit = error.detail.limit;
  return typeof limit === "number" ? limit : null;
}

/** Validate an untrusted drag payload. */
export function parseDragPayload(raw: string): DragPayload | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { side, paths } = value as Partial<DragPayload>;
    if (side !== "local" && side !== "remote") return null;
    if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) return null;
    return { side, paths };
  } catch {
    return null;
  }
}
