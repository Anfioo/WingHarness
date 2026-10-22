import { invokeCommand } from "../../base";

/**
 * The git-svn working copy, as codelet's `remote` extension reads it.
 *
 * Shapes mirror `codelet/dist/_chunks/protocol.d.mts`. Paths are `/`-rooted and
 * relative to the configured repo; the backend confines them and never serves
 * `.git`.
 */

export interface RemoteInfo {
  /** The protocol's own name for this server; the client checks it. */
  name: "codelet-server";
  /** The protocol's version, which the client checks. */
  version: 1;
  readonly: boolean;
  maxFileSize: number;
  /** The optional protocol features offered; only `"watch"` is defined, and it is not. */
  features: "watch"[];
}

export interface RemoteEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  mtime?: number;
  /** Not text: mirrored as an address rather than as content. */
  binary?: boolean;
  /** Present only when the listing reached this directory; absent means unloaded. */
  children?: RemoteEntry[];
  text?: string;
  /** Text the size cap kept out, so the page can say why rather than show empty. */
  truncated?: boolean;
}

export interface TreeResult {
  entry: RemoteEntry;
}

export interface ReadResult {
  text: string;
  etag?: string;
}

export interface WriteResult {
  mtime: number;
  size: number;
  etag: string;
}

/** What this is, asked once at connect time. Fails loudly when no repo is set. */
export function projectInfo(): Promise<RemoteInfo> {
  return invokeCommand("project_info", {});
}

/**
 * Lists one directory level. `depth: "all"` walks the whole tree and
 * `content` inlines text bodies — the page sends neither, so a large working
 * copy costs only what is on screen.
 */
export function projectTree(
  path: string,
  options?: { depth?: number | "all"; content?: boolean }
): Promise<TreeResult> {
  return invokeCommand("project_tree", { path, ...options });
}

/** A text file's bytes, with the tag a later write compares against. */
export function projectRead(path: string): Promise<ReadResult> {
  return invokeCommand("project_read", { path });
}

/** Writes a text file; a stale `etag` is refused rather than clobbering disk. */
export function projectWrite(path: string, body: string, etag?: string): Promise<WriteResult> {
  return invokeCommand("project_write", { path, body, etag });
}

export function projectMkdir(path: string): Promise<void> {
  return invokeCommand("project_mkdir", { path });
}

export function projectMove(from: string, to: string): Promise<void> {
  return invokeCommand("project_move", { from, to });
}

export function projectDelete(path: string): Promise<void> {
  return invokeCommand("project_delete", { path });
}
