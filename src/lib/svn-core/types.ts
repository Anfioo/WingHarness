// Wire types for the SVN workspace, mirroring `svn-core/src/models.rs` field for
// field.
//
// One deliberate difference from the reference implementation this feature was
// ported from: every field is camelCase, matching `@/lib/api-core/types` and
// `@/lib/git-core/types`, even though the reference used snake_case. The UI is
// rebuilt either way, so it costs nothing and keeps one convention app-wide.

/** What a write-style command (commit/update/add/…) reports back. */
export interface CommandResult {
  success: boolean;
  output: string;
  error: string | null;
}

/** `svn status` classifications the UI filters on. */
export type SvnStatusCode =
  | "modified"
  | "added"
  | "deleted"
  | "replaced"
  | "unversioned"
  | "missing"
  | "conflicted"
  | "obstructed"
  | "ignored"
  | "external"
  | "incomplete"
  | "normal"
  | "none";

/** One entry of `svn status`. */
export interface SvnStatus {
  /** Path relative to the working copy root, always `/`-separated. */
  path: string;
  /** Human-facing classification, derived from {@link SvnStatus.statusCode}. */
  status: string;
  /** The raw classification the UI filters on. */
  statusCode: string;
  propStatus: string;
  locked: boolean;
  history: boolean;
  switched: boolean;
}

/** One changed path inside a log entry. */
export interface SvnLogPath {
  path: string;
  /** `A` / `D` / `M` / `R`, or empty when the action is unknown. */
  action: string;
}

/** One `svn log` revision. */
export interface SvnLogEntry {
  revision: number;
  author: string;
  date: string;
  message: string;
  changedPaths: SvnLogPath[];
}

/** The subset of `svn info` the UI shows. */
export interface SvnInfo {
  path: string;
  url: string;
  repositoryRoot: string;
  revision: number;
  nodeKind: string;
  schedule: string;
}

/** The credential `svn` would use for this working copy, when it knows one. */
export interface SvnAuthUser {
  username: string;
  realm: string;
}

/** A unified diff plus the revisions it spans. */
export interface DiffResult {
  path: string;
  diff: string;
  oldRevision: number;
  newRevision: number;
}

/** One line of `svn blame` output. */
export interface BlameLine {
  revision: number;
  author: string;
  line: string;
}

/** A file or directory captured for the local stash, base64-encoded. */
export interface StashUnversionedEntry {
  path: string;
  kind: "file" | "directory";
  contentBase64?: string | null;
}

/** `.gitignore` contents plus the mtime the frontend caches against. */
export interface GitignoreData {
  content: string;
  mtime: number;
}

/** One entry of the picker's recent-working-copy list. */
export interface RecentWorkspace {
  path: string;
  revision: number | null;
  openedAt: number;
}

/** Where `openWorkspaceTarget` should send a working copy. */
export type OpenTarget = "explorer" | "vscode" | "terminal";

/** A stash of one file's local modifications, split into hunks by the frontend. */
export interface StashHunk {
  id: string;
  header: string;
  lines: string[];
  added: number;
  removed: number;
}

/** One file inside a stash patch. */
export interface StashFile {
  path: string;
  header: string[];
  hunks: StashHunk[];
}

/** One saved stash, including any unversioned files captured with it. */
export interface StashEntry {
  id: string;
  name: string;
  workspacePath: string;
  createdAt: string;
  patch: string;
  files: string[];
  hunkCount: number;
  unversionedFiles?: StashUnversionedEntry[];
}
