// SVN workspace command service.
//
// Thin, one-to-one wrappers over the `svn-core` Rust commands so callers stay
// close to the engine's own shape. The engine args are snake_case on the Rust
// side (`workspace_path`, `old_rev`, `dry_run`); Tauri maps the camelCase keys
// sent here onto them.

import { invokeCommand } from "../../base";
import type {
  BlameLine,
  CommandResult,
  DiffResult,
  GitignoreData,
  OpenTarget,
  RecentWorkspace,
  StashUnversionedEntry,
  SvnAuthUser,
  SvnInfo,
  SvnLogEntry,
  SvnStatus,
} from "@/lib/svn-core/types";
import type {
  ApplyPatchPayload,
  BlamePayload,
  CheckoutPayload,
  CommitPayload,
  DiffPayload,
  ExportStashPayload,
  FilesPayload,
  LogPayload,
  LogQuery,
  MergePayload,
  OpenTargetPayload,
  PathPayload,
  RememberPayload,
  ResolvePayload,
  RestoreUnversionedPayload,
  RevealPayload,
  StatusPayload,
  StoreKeyPayload,
  StoreValuePayload,
  SwitchPayload,
  UpdatePayload,
} from "./types";

/** Point the engine at a user-chosen `svn` binary; returns its version. */
export function configureSvnExecutable(executable?: string): Promise<string> {
  return invokeCommand<{ executable: string | null }, string>("configure_svn_executable", {
    executable: executable?.trim() || null,
  });
}

/** Check a repository out to a local path, optionally at a pinned revision. */
export function svnCheckout(url: string, path: string, revision?: number): Promise<CommandResult> {
  return invokeCommand<CheckoutPayload, CommandResult>("svn_checkout", { url, path, revision });
}

/** Update the working copy, optionally to a pinned revision. */
export function svnUpdate(path: string, revision?: number): Promise<CommandResult> {
  return invokeCommand<UpdatePayload, CommandResult>("svn_update", { path, revision });
}

/** Switch the working copy to another repository URL. */
export function svnSwitch(path: string, url: string): Promise<CommandResult> {
  return invokeCommand<SwitchPayload, CommandResult>("svn_switch", { path, url });
}

/** Merge a revision range from `source` into the working copy. */
export function svnMerge(
  path: string,
  source: string,
  revStart: number,
  revEnd: number
): Promise<CommandResult> {
  return invokeCommand<MergePayload, CommandResult>("svn_merge", {
    path,
    source,
    revStart,
    revEnd,
  });
}

/** Clear a stale lock so the working copy is usable again. */
export function svnCleanup(path: string): Promise<CommandResult> {
  return invokeCommand<PathPayload, CommandResult>("svn_cleanup", { path });
}

/** The working copy's status. `force` rescans from disk instead of using the cache. */
export function svnStatus(path: string, force = false): Promise<SvnStatus[]> {
  return invokeCommand<StatusPayload, SvnStatus[]>("svn_status", { path, force });
}

/** Commit the given paths, or the whole working copy when `files` is omitted. */
export function svnCommit(path: string, message: string, files?: string[]): Promise<CommandResult> {
  return invokeCommand<CommitPayload, CommandResult>("svn_commit", { path, message, files });
}

/** `svn add` the given paths. */
export function svnAdd(path: string, files: string[]): Promise<CommandResult> {
  return invokeCommand<FilesPayload, CommandResult>("svn_add", { path, files });
}

/** `svn delete` the given paths. */
export function svnDelete(path: string, files: string[]): Promise<CommandResult> {
  return invokeCommand<FilesPayload, CommandResult>("svn_delete", { path, files });
}

/** `svn revert` the given paths. */
export function svnRevert(path: string, files: string[]): Promise<CommandResult> {
  return invokeCommand<FilesPayload, CommandResult>("svn_revert", { path, files });
}

/** Resolve conflicted paths with the given strategy (`working`, `mine-full`, …). */
export function svnResolve(
  path: string,
  files: string[],
  strategy: string
): Promise<CommandResult> {
  return invokeCommand<ResolvePayload, CommandResult>("svn_resolve", { path, files, strategy });
}

/** Apply a unified diff (a stash patch) to the working copy. */
export function svnApplyPatch(
  workspacePath: string,
  patch: string,
  reverse = false
): Promise<CommandResult> {
  return invokeCommand<ApplyPatchPayload, CommandResult>("svn_apply_patch", {
    workspacePath,
    patch,
    reverse,
  });
}

/** `svn log`, narrowed by the optional filters. */
export function svnLog(path: string, query: LogQuery = {}): Promise<SvnLogEntry[]> {
  return invokeCommand<LogPayload, SvnLogEntry[]>("svn_log", { path, ...query });
}

/** A single file's diff, against the base revision or between two revisions. */
export function svnDiff(
  workspacePath: string,
  file: string,
  oldRev?: number,
  newRev?: number
): Promise<DiffResult> {
  return invokeCommand<DiffPayload, DiffResult>("svn_diff", {
    workspacePath,
    file,
    oldRev,
    newRev,
  });
}

/** Per-line attribution for a file. */
export function svnBlame(workspacePath: string, file: string): Promise<BlameLine[]> {
  return invokeCommand<BlamePayload, BlameLine[]>("svn_blame", { workspacePath, file });
}

/** `svn info` for the working copy. */
export function svnInfo(path: string): Promise<SvnInfo> {
  return invokeCommand<PathPayload, SvnInfo>("svn_info", { path });
}

/** `svn info` against the repository, for "how far behind am I". */
export function svnRemoteInfo(path: string): Promise<SvnInfo> {
  return invokeCommand<PathPayload, SvnInfo>("svn_remote_info", { path });
}

/** The credential `svn` would use, or `null` when it knows of none. */
export function svnCurrentUser(path: string): Promise<SvnAuthUser | null> {
  return invokeCommand<PathPayload, SvnAuthUser | null>("svn_current_user", { path });
}

/** The working copy's own revision. */
export function svnLocalRevision(path: string): Promise<number> {
  return invokeCommand<PathPayload, number>("svn_local_revision", { path });
}

/** Delete unversioned paths from the working copy. */
export function deleteUnversioned(path: string, files: string[]): Promise<CommandResult> {
  return invokeCommand<FilesPayload, CommandResult>("delete_unversioned", { path, files });
}

/** Capture unversioned paths (base64) so they can be stashed. */
export function readUnversionedFiles(
  path: string,
  files: string[]
): Promise<StashUnversionedEntry[]> {
  return invokeCommand<FilesPayload, StashUnversionedEntry[]>("read_unversioned_files", {
    path,
    files,
  });
}

/** Write stashed unversioned paths back. `dryRun` only validates. */
export function restoreUnversionedFiles(
  path: string,
  files: StashUnversionedEntry[],
  dryRun: boolean
): Promise<void> {
  return invokeCommand<RestoreUnversionedPayload, void>("restore_unversioned_files", {
    path,
    files,
    dryRun,
  });
}

/** Open the working copy in Explorer, VS Code or a terminal. */
export function openWorkspaceTarget(path: string, target: OpenTarget): Promise<void> {
  return invokeCommand<OpenTargetPayload, void>("open_workspace_target", { path, target });
}

/** Reveal one file inside the working copy in Explorer. */
export function revealWorkspaceFile(path: string, file: string): Promise<void> {
  return invokeCommand<RevealPayload, void>("reveal_workspace_file", { path, file });
}

/** The working copy's `.gitignore`, or `null` when it has none. */
export function readGitignore(path: string): Promise<GitignoreData | null> {
  return invokeCommand<PathPayload, GitignoreData | null>("read_gitignore", { path });
}

/** The recently opened working copies, most recent first. */
export function svnWorkspaceRecent(): Promise<RecentWorkspace[]> {
  return invokeCommand<Record<string, never>, RecentWorkspace[]>("svn_workspace_recent", {});
}

/** Record an open; returns the updated recent list. */
export function svnWorkspaceRemember(path: string, revision?: number): Promise<RecentWorkspace[]> {
  return invokeCommand<RememberPayload, RecentWorkspace[]>("svn_workspace_remember", {
    path,
    revision,
  });
}

/** Drop a working copy from the recent list; returns the updated list. */
export function svnWorkspaceForget(path: string): Promise<RecentWorkspace[]> {
  return invokeCommand<PathPayload, RecentWorkspace[]>("svn_workspace_forget", { path });
}

/** Write a stash export to a path the user picked in the save dialog. */
export function svnStashExport(path: string, contents: string): Promise<void> {
  return invokeCommand<ExportStashPayload, void>("svn_stash_export", { path, contents });
}

// -- Raw key/value store (the feature's own persisted state) -----------------
//
// Backs the SVN feature's zustand `persist` layers with the engine's data
// directory instead of WebView2 localStorage, mirroring `gitStoreRead` /
// `gitStoreWrite` / `gitStoreRemove`. One file per key.

/** Read a raw value from the SVN data directory, or `null` when absent. */
export function svnStoreRead(key: string): Promise<string | null> {
  return invokeCommand<StoreKeyPayload, string | null>("svn_store_read", { key });
}

/** Write a raw value to the SVN data directory. */
export function svnStoreWrite(key: string, value: string): Promise<void> {
  return invokeCommand<StoreValuePayload, void>("svn_store_write", { key, value });
}

/** Delete a key from the SVN data directory. A missing key is not an error. */
export function svnStoreRemove(key: string): Promise<void> {
  return invokeCommand<StoreKeyPayload, void>("svn_store_remove", { key });
}
