// Git engine command service.
//
// Thin, one-to-one wrappers over the `git-core` Rust commands, so callers stay
// close to the engine's own shape. Optional engine arguments are sent as
// `null` rather than omitted, matching what the engine expects to deserialize.

import { invokeCommand } from "../../base";
import type {
  BranchInfo,
  CommitFileInfo,
  CommitInfo,
  ConflictFile,
  FileBlame,
  FileDiff,
  HistoryPage,
  HistoryPosition,
  HistoryQuery,
  HistorySearch,
  HistorySearchQuery,
  RebaseTodoEntry,
  RecentRepository,
  RemoteInfo,
  RepositoryInfo,
  RepositoryScan,
  StashInfo,
  StatusSummary,
  SubmoduleInfo,
  TagInfo,
  WorktreeAddRequest,
  WorktreeInfo,
} from "@/lib/git-core/types";
import type {
  AccountCheckResult,
  CliAgentInfo,
  CliRunRequest,
  CliRunResult,
  EditorInfo,
  EngineInfo,
  FontFamily,
  GeneratedKey,
  HostingAccount,
  HttpRequest,
  HttpResponse,
  OpOutcome,
} from "./types";

// --- Repository ---------------------------------------------------------

/**
 * Opens a repository and answers with its canonical root path.
 *
 * `remember` records it in the recent list — the project page passes false,
 * since its working copy comes from the app config rather than from a pick.
 */
export function repoOpen(path: string, remember = true): Promise<RepositoryInfo> {
  return invokeCommand<{ path: string; remember: boolean }, RepositoryInfo>("repo_open", {
    path,
    remember,
  });
}

export function repoInfo(path: string): Promise<RepositoryInfo> {
  return invokeCommand<{ path: string }, RepositoryInfo>("repo_info", { path });
}

export function repoRefFingerprint(path: string): Promise<string> {
  return invokeCommand<{ path: string }, string>("repo_ref_fingerprint", {
    path,
  });
}

export function repoInit(path: string): Promise<RepositoryInfo> {
  return invokeCommand<{ path: string }, RepositoryInfo>("repo_init", { path });
}

export function repoStatus(path: string): Promise<StatusSummary> {
  return invokeCommand<{ path: string }, StatusSummary>("repo_status", { path });
}

/** The paths `.gitignore` hides from `status`, directories reported whole. */
export function repoIgnoredPaths(path: string): Promise<string[]> {
  return invokeCommand<{ path: string }, string[]>("repo_ignored_paths", { path });
}

/** The git CLI's version line, run by the backend exactly as the IDE runs it. */
export function gitCliVersion(): Promise<string> {
  return invokeCommand<Record<string, never>, string>("git_cli_version", {});
}

export function stateCleanup(path: string): Promise<void> {
  return invokeCommand<{ path: string }, void>("state_cleanup", { path });
}

export function repoClone(url: string, into: string, branch?: string): Promise<string> {
  return invokeCommand<{ url: string; into: string; branch: string | null }, string>("repo_clone", {
    url,
    into,
    branch: branch ?? null,
  });
}

export function gitEngineInfo(): Promise<EngineInfo> {
  return invokeCommand<Record<string, never>, EngineInfo>("git_engine_info", {});
}

// --- Recent repositories ------------------------------------------------

export function recentRepositories(): Promise<RecentRepository[]> {
  return invokeCommand<Record<string, never>, RecentRepository[]>("recent_repositories", {});
}

export function recentAddMany(paths: string[]): Promise<RecentRepository[]> {
  return invokeCommand<{ paths: string[] }, RecentRepository[]>("recent_add_many", { paths });
}

export function recentRemove(path: string): Promise<RecentRepository[]> {
  return invokeCommand<{ path: string }, RecentRepository[]>("recent_remove", {
    path,
  });
}

export function recentSetAiInstructions(
  path: string,
  instructions: string
): Promise<RecentRepository[]> {
  return invokeCommand<{ path: string; instructions: string }, RecentRepository[]>(
    "recent_set_ai_instructions",
    { path, instructions }
  );
}

export function repositoriesScan(root: string): Promise<RepositoryScan> {
  return invokeCommand<{ root: string }, RepositoryScan>("repositories_scan", {
    root,
  });
}

// --- Local store --------------------------------------------------------

export function gitStoreRead(key: string): Promise<string | null> {
  return invokeCommand<{ key: string }, string | null>("git_store_read", {
    key,
  });
}

export function gitStoreWrite(key: string, value: string): Promise<void> {
  return invokeCommand<{ key: string; value: string }, void>("git_store_write", {
    key,
    value,
  });
}

export function gitStoreRemove(key: string): Promise<void> {
  return invokeCommand<{ key: string }, void>("git_store_remove", { key });
}

// --- Configuration ------------------------------------------------------

export function configGet(key: string, path?: string): Promise<string | null> {
  return invokeCommand<{ path: string | null; key: string }, string | null>("config_get", {
    path: path ?? null,
    key,
  });
}

export function configSet(
  key: string,
  value: string,
  global: boolean,
  path?: string
): Promise<void> {
  return invokeCommand<{ path: string | null; key: string; value: string; global: boolean }, void>(
    "config_set",
    { path: path ?? null, key, value, global }
  );
}

// --- Working copy -------------------------------------------------------

export function stageFile(path: string, file: string): Promise<void> {
  return invokeCommand<{ path: string; file: string }, void>("stage_file", {
    path,
    file,
  });
}

export function unstageFile(path: string, file: string): Promise<void> {
  return invokeCommand<{ path: string; file: string }, void>("unstage_file", {
    path,
    file,
  });
}

export function stageAll(path: string): Promise<void> {
  return invokeCommand<{ path: string }, void>("stage_all", { path });
}

export function unstageAll(path: string): Promise<void> {
  return invokeCommand<{ path: string }, void>("unstage_all", { path });
}

export function discardFile(path: string, file: string): Promise<boolean> {
  return invokeCommand<{ path: string; file: string }, boolean>("discard_file", {
    path,
    file,
  });
}

export function discardAll(path: string): Promise<string[]> {
  return invokeCommand<{ path: string }, string[]>("discard_all", { path });
}

export function discardStagedFile(path: string, file: string): Promise<boolean> {
  return invokeCommand<{ path: string; file: string }, boolean>("discard_staged_file", {
    path,
    file,
  });
}

export function discardStagedAll(path: string): Promise<string[]> {
  return invokeCommand<{ path: string }, string[]>("discard_staged_all", {
    path,
  });
}

export function restoreFromRev(path: string, rev: string, paths: string[]): Promise<void> {
  return invokeCommand<{ path: string; rev: string; paths: string[] }, void>("restore_from_rev", {
    path,
    rev,
    paths,
  });
}

export function stageHunk(path: string, file: string, hunkIndex: number): Promise<void> {
  return invokeCommand<{ path: string; file: string; hunkIndex: number }, void>("stage_hunk", {
    path,
    file,
    hunkIndex,
  });
}

export function unstageHunk(path: string, file: string, hunkIndex: number): Promise<void> {
  return invokeCommand<{ path: string; file: string; hunkIndex: number }, void>("unstage_hunk", {
    path,
    file,
    hunkIndex,
  });
}

export function stageLine(path: string, file: string, kind: string, lineNo: number): Promise<void> {
  return invokeCommand<{ path: string; file: string; kind: string; lineNo: number }, void>(
    "stage_line",
    { path, file, kind, lineNo }
  );
}

export function unstageLine(
  path: string,
  file: string,
  kind: string,
  lineNo: number
): Promise<void> {
  return invokeCommand<{ path: string; file: string; kind: string; lineNo: number }, void>(
    "unstage_line",
    { path, file, kind, lineNo }
  );
}

export function discardLine(
  path: string,
  file: string,
  kind: string,
  lineNo: number
): Promise<void> {
  return invokeCommand<{ path: string; file: string; kind: string; lineNo: number }, void>(
    "discard_line",
    { path, file, kind, lineNo }
  );
}

// --- Files --------------------------------------------------------------

export function readFile(path: string, file: string): Promise<string> {
  return invokeCommand<{ path: string; file: string }, string>("read_file", {
    path,
    file,
  });
}

export function writeFile(path: string, file: string, content: string): Promise<void> {
  return invokeCommand<{ path: string; file: string; content: string }, void>("write_file", {
    path,
    file,
    content,
  });
}

export function openPath(target: string): Promise<void> {
  return invokeCommand<{ path: string }, void>("open_path", { path: target });
}

export function revealPath(target: string): Promise<void> {
  return invokeCommand<{ path: string }, void>("reveal_path", { path: target });
}

export function pathsExist(paths: string[]): Promise<boolean[]> {
  return invokeCommand<{ paths: string[] }, boolean[]>("paths_exist", { paths });
}

export function deleteFile(path: string, file: string): Promise<void> {
  return invokeCommand<{ path: string; file: string }, void>("delete_file", {
    path,
    file,
  });
}

export function fileBlame(path: string, file: string, rev?: string): Promise<FileBlame> {
  return invokeCommand<{ path: string; file: string; rev: string | null }, FileBlame>(
    "file_blame",
    { path, file, rev: rev ?? null }
  );
}

// --- Commits ------------------------------------------------------------

export function commitCreate(path: string, message: string): Promise<string> {
  return invokeCommand<{ path: string; message: string }, string>("commit_create", {
    path,
    message,
  });
}

export function commitAmend(path: string, message?: string): Promise<string> {
  return invokeCommand<{ path: string; message: string | null }, string>("commit_amend", {
    path,
    message: message ?? null,
  });
}

export function commitReword(path: string, oid: string, message: string): Promise<string> {
  return invokeCommand<{ path: string; oid: string; message: string }, string>("commit_reword", {
    path,
    oid,
    message,
  });
}

export function commitRevert(path: string, oid: string): Promise<OpOutcome> {
  return invokeCommand<{ path: string; oid: string }, OpOutcome>("commit_revert", { path, oid });
}

export function commitIsAncestor(
  path: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  return invokeCommand<{ path: string; ancestor: string; descendant: string }, boolean>(
    "commit_is_ancestor",
    { path, ancestor, descendant }
  );
}

export function commitDropPaths(path: string, oid: string, paths: string[]): Promise<OpOutcome> {
  return invokeCommand<{ path: string; oid: string; paths: string[] }, OpOutcome>(
    "commit_drop_paths",
    { path, oid, paths }
  );
}

export function commitExtractPaths(
  path: string,
  oid: string,
  paths: string[],
  message: string
): Promise<OpOutcome> {
  return invokeCommand<{ path: string; oid: string; paths: string[]; message: string }, OpOutcome>(
    "commit_extract_paths",
    { path, oid, paths, message }
  );
}

export function historyUnpushed(path: string): Promise<string[]> {
  return invokeCommand<{ path: string }, string[]>("history_unpushed", { path });
}

export function mergeMessage(path: string): Promise<string | null> {
  return invokeCommand<{ path: string }, string | null>("merge_message", {
    path,
  });
}

export function mergeCanFf(path: string, target: string, source: string): Promise<boolean> {
  return invokeCommand<{ path: string; target: string; source: string }, boolean>("merge_can_ff", {
    path,
    target,
    source,
  });
}

// --- History ------------------------------------------------------------

export function historyList(path: string, query: HistoryQuery): Promise<HistoryPage> {
  return invokeCommand<{ path: string; query: HistoryQuery }, HistoryPage>("history_list", {
    path,
    query,
  });
}

export function historySearch(path: string, query: HistorySearchQuery): Promise<HistorySearch> {
  return invokeCommand<{ path: string; query: HistorySearchQuery }, HistorySearch>(
    "history_search",
    { path, query }
  );
}

export function historyCommit(path: string, oid: string): Promise<CommitInfo> {
  return invokeCommand<{ path: string; oid: string }, CommitInfo>("history_commit", { path, oid });
}

export function historyPosition(path: string, rev: string): Promise<HistoryPosition | null> {
  return invokeCommand<{ path: string; rev: string }, HistoryPosition | null>("history_position", {
    path,
    rev,
  });
}

export function historyFile(
  path: string,
  file: string,
  limit?: number,
  skip?: number,
  fromOid?: string
): Promise<HistoryPage> {
  return invokeCommand<
    {
      path: string;
      file: string;
      limit: number | null;
      skip: number | null;
      fromOid: string | null;
    },
    HistoryPage
  >("history_file", {
    path,
    file,
    limit: limit ?? null,
    skip: skip ?? null,
    fromOid: fromOid ?? null,
  });
}

export function repoFiles(path: string): Promise<string[]> {
  return invokeCommand<{ path: string }, string[]>("repo_files", { path });
}

export function treeFiles(path: string, oid: string): Promise<string[]> {
  return invokeCommand<{ path: string; oid: string }, string[]>("tree_files", {
    path,
    oid,
  });
}

export function indexFiles(path: string): Promise<string[]> {
  return invokeCommand<{ path: string }, string[]>("index_files", { path });
}

export function fileContents(path: string, file: string, oid?: string): Promise<FileDiff> {
  return invokeCommand<{ path: string; file: string; oid: string | null }, FileDiff>(
    "file_contents",
    { path, file, oid: oid ?? null }
  );
}

// --- Branches -----------------------------------------------------------

export function branchList(path: string): Promise<BranchInfo[]> {
  return invokeCommand<{ path: string }, BranchInfo[]>("branch_list", { path });
}

export function branchCreate(
  path: string,
  name: string,
  fromOid: string | null,
  checkout: boolean
): Promise<void> {
  return invokeCommand<
    { path: string; name: string; fromOid: string | null; checkout: boolean },
    void
  >("branch_create", { path, name, fromOid, checkout });
}

export function branchDelete(path: string, name: string, remote: boolean): Promise<void> {
  return invokeCommand<{ path: string; name: string; remote: boolean }, void>("branch_delete", {
    path,
    name,
    remote,
  });
}

export function branchRename(path: string, oldName: string, newName: string): Promise<void> {
  return invokeCommand<{ path: string; oldName: string; newName: string }, void>("branch_rename", {
    path,
    oldName,
    newName,
  });
}

export function branchCheckout(path: string, name: string): Promise<void> {
  return invokeCommand<{ path: string; name: string }, void>("branch_checkout", {
    path,
    name,
  });
}

export function checkoutDetached(path: string, rev: string): Promise<void> {
  return invokeCommand<{ path: string; rev: string }, void>("checkout_detached", { path, rev });
}

export function branchMerge(path: string, name: string, noFf?: boolean): Promise<OpOutcome> {
  return invokeCommand<{ path: string; name: string; noFf: boolean | null }, OpOutcome>(
    "branch_merge",
    { path, name, noFf: noFf ?? null }
  );
}

export function mergeAbort(path: string): Promise<void> {
  return invokeCommand<{ path: string }, void>("merge_abort", { path });
}

export function branchRebase(path: string, upstream: string): Promise<OpOutcome> {
  return invokeCommand<{ path: string; upstream: string }, OpOutcome>("branch_rebase", {
    path,
    upstream,
  });
}

export function rebaseContinue(path: string): Promise<OpOutcome> {
  return invokeCommand<{ path: string }, OpOutcome>("rebase_continue", { path });
}

export function rebaseAbort(path: string): Promise<void> {
  return invokeCommand<{ path: string }, void>("rebase_abort", { path });
}

export function rebaseCommits(path: string, baseOid: string): Promise<CommitInfo[]> {
  return invokeCommand<{ path: string; baseOid: string }, CommitInfo[]>("rebase_commits", {
    path,
    baseOid,
  });
}

export function rebaseInteractive(
  path: string,
  baseOid: string,
  todo: RebaseTodoEntry[]
): Promise<string> {
  return invokeCommand<{ path: string; baseOid: string; todo: RebaseTodoEntry[] }, string>(
    "rebase_interactive",
    { path, baseOid, todo }
  );
}

export function cherryPick(path: string, oid: string, recordOrigin: boolean): Promise<OpOutcome> {
  return invokeCommand<{ path: string; oid: string; recordOrigin: boolean }, OpOutcome>(
    "cherry_pick",
    { path, oid, recordOrigin }
  );
}

export function cherryPickMany(
  path: string,
  oids: string[],
  recordOrigin: boolean
): Promise<OpOutcome> {
  return invokeCommand<{ path: string; oids: string[]; recordOrigin: boolean }, OpOutcome>(
    "cherry_pick_many",
    { path, oids, recordOrigin }
  );
}

export function cherryPickPaths(
  path: string,
  oid: string,
  paths: string[],
  recordOrigin: boolean
): Promise<OpOutcome> {
  return invokeCommand<
    { path: string; oid: string; paths: string[]; recordOrigin: boolean },
    OpOutcome
  >("cherry_pick_paths", { path, oid, paths, recordOrigin });
}

export function revertPaths(path: string, oid: string, paths: string[]): Promise<OpOutcome> {
  return invokeCommand<{ path: string; oid: string; paths: string[] }, OpOutcome>("revert_paths", {
    path,
    oid,
    paths,
  });
}

export function resetTo(path: string, oid: string, mode: string): Promise<void> {
  return invokeCommand<{ path: string; oid: string; mode: string }, void>("reset_to", {
    path,
    oid,
    mode,
  });
}

// --- Remotes ------------------------------------------------------------

export function remoteList(path: string): Promise<RemoteInfo[]> {
  return invokeCommand<{ path: string }, RemoteInfo[]>("remote_list", { path });
}

export function remoteAdd(path: string, name: string, url: string): Promise<void> {
  return invokeCommand<{ path: string; name: string; url: string }, void>("remote_add", {
    path,
    name,
    url,
  });
}

export function remoteEdit(
  path: string,
  name: string,
  newName: string,
  url: string
): Promise<void> {
  return invokeCommand<{ path: string; name: string; newName: string; url: string }, void>(
    "remote_edit",
    { path, name, newName, url }
  );
}

export function remoteRemove(path: string, name: string): Promise<void> {
  return invokeCommand<{ path: string; name: string }, void>("remote_remove", {
    path,
    name,
  });
}

export function remoteFetch(
  path: string,
  remote: string,
  tags: boolean,
  prune: boolean
): Promise<OpOutcome> {
  return invokeCommand<{ path: string; remote: string; tags: boolean; prune: boolean }, OpOutcome>(
    "remote_fetch",
    { path, remote, tags, prune }
  );
}

export function remotePull(path: string, remote: string, mode?: string): Promise<OpOutcome> {
  return invokeCommand<{ path: string; remote: string; mode: string | null }, OpOutcome>(
    "remote_pull",
    { path, remote, mode: mode ?? null }
  );
}

export function remotePullBranch(path: string, branch: string): Promise<OpOutcome> {
  return invokeCommand<{ path: string; branch: string }, OpOutcome>("remote_pull_branch", {
    path,
    branch,
  });
}

export function remotePush(
  path: string,
  remote: string,
  branch: string | null,
  force: boolean,
  withTags: boolean,
  setUpstream: boolean
): Promise<OpOutcome> {
  return invokeCommand<
    {
      path: string;
      remote: string;
      branch: string | null;
      force: boolean;
      withTags: boolean;
      setUpstream: boolean;
    },
    OpOutcome
  >("remote_push", {
    path,
    remote,
    branch: branch ?? null,
    force,
    withTags,
    setUpstream,
  });
}

export function remotePushTag(path: string, remote: string, tag: string): Promise<OpOutcome> {
  return invokeCommand<{ path: string; remote: string; tag: string }, OpOutcome>(
    "remote_push_tag",
    { path, remote, tag }
  );
}

export function prCheckout(
  path: string,
  remote: string,
  sourceRef: string,
  branch: string,
  track: boolean
): Promise<void> {
  return invokeCommand<
    {
      path: string;
      remote: string;
      sourceRef: string;
      branch: string;
      track: boolean;
    },
    void
  >("pr_checkout", { path, remote, sourceRef, branch, track });
}

// --- Stashes ------------------------------------------------------------

export function stashList(path: string): Promise<StashInfo[]> {
  return invokeCommand<{ path: string }, StashInfo[]>("stash_list", { path });
}

export function stashCreate(
  path: string,
  message: string | undefined,
  includeUntracked: boolean,
  paths?: string[]
): Promise<void> {
  return invokeCommand<
    {
      path: string;
      message: string | null;
      includeUntracked: boolean;
      paths: string[];
    },
    void
  >("stash_create", {
    path,
    message: message ?? null,
    includeUntracked,
    paths: paths ?? [],
  });
}

export function stashApply(path: string, index: number): Promise<void> {
  return invokeCommand<{ path: string; index: number }, void>("stash_apply", {
    path,
    index,
  });
}

export function stashPop(path: string, index: number): Promise<void> {
  return invokeCommand<{ path: string; index: number }, void>("stash_pop", {
    path,
    index,
  });
}

export function stashDrop(path: string, index: number): Promise<void> {
  return invokeCommand<{ path: string; index: number }, void>("stash_drop", {
    path,
    index,
  });
}

export function stashFiles(path: string, index: number): Promise<CommitFileInfo[]> {
  return invokeCommand<{ path: string; index: number }, CommitFileInfo[]>("stash_files", {
    path,
    index,
  });
}

export function stashRestoreFiles(path: string, index: number, paths: string[]): Promise<string[]> {
  return invokeCommand<{ path: string; index: number; paths: string[] }, string[]>(
    "stash_restore_files",
    { path, index, paths }
  );
}

// --- Tags and submodules ------------------------------------------------

export function tagList(path: string): Promise<TagInfo[]> {
  return invokeCommand<{ path: string }, TagInfo[]>("tag_list", { path });
}

export function tagCreate(
  path: string,
  name: string,
  target: string | null,
  message?: string
): Promise<void> {
  return invokeCommand<
    { path: string; name: string; target: string | null; message: string | null },
    void
  >("tag_create", { path, name, target, message: message ?? null });
}

export function tagDelete(path: string, name: string): Promise<void> {
  return invokeCommand<{ path: string; name: string }, void>("tag_delete", {
    path,
    name,
  });
}

export function submoduleList(path: string): Promise<SubmoduleInfo[]> {
  return invokeCommand<{ path: string }, SubmoduleInfo[]>("submodule_list", {
    path,
  });
}

export function submoduleUpdate(path: string, name: string): Promise<void> {
  return invokeCommand<{ path: string; name: string }, void>("submodule_update", { path, name });
}

// --- Worktrees ----------------------------------------------------------

export function worktreeList(path: string): Promise<WorktreeInfo[]> {
  return invokeCommand<{ path: string }, WorktreeInfo[]>("worktree_list", {
    path,
  });
}

export function worktreeAdd(path: string, request: WorktreeAddRequest): Promise<string> {
  return invokeCommand<{ path: string; request: WorktreeAddRequest }, string>("worktree_add", {
    path,
    request,
  });
}

export function worktreeRemove(path: string, name: string, force: boolean): Promise<void> {
  return invokeCommand<{ path: string; name: string; force: boolean }, void>("worktree_remove", {
    path,
    name,
    force,
  });
}

export function worktreePrune(path: string): Promise<string[]> {
  return invokeCommand<{ path: string }, string[]>("worktree_prune", { path });
}

// --- Diffs --------------------------------------------------------------

export function diffFile(
  path: string,
  file: string,
  staged: boolean,
  contextLines?: number,
  ignoreWhitespace?: boolean
): Promise<FileDiff> {
  return invokeCommand<
    {
      path: string;
      file: string;
      staged: boolean;
      contextLines: number | null;
      ignoreWhitespace: boolean | null;
    },
    FileDiff
  >("diff_file", {
    path,
    file,
    staged,
    contextLines: contextLines ?? null,
    ignoreWhitespace: ignoreWhitespace ?? null,
  });
}

export function diffCommit(
  path: string,
  oid: string,
  contextLines?: number,
  ignoreWhitespace?: boolean
): Promise<FileDiff[]> {
  return invokeCommand<
    {
      path: string;
      oid: string;
      contextLines: number | null;
      ignoreWhitespace: boolean | null;
    },
    FileDiff[]
  >("diff_commit", {
    path,
    oid,
    contextLines: contextLines ?? null,
    ignoreWhitespace: ignoreWhitespace ?? null,
  });
}

export function diffCommitFiles(path: string, oid: string): Promise<CommitFileInfo[]> {
  return invokeCommand<{ path: string; oid: string }, CommitFileInfo[]>("diff_commit_files", {
    path,
    oid,
  });
}

export function diffCommitFile(
  path: string,
  oid: string,
  file: string,
  oldPath?: string,
  contextLines?: number,
  ignoreWhitespace?: boolean
): Promise<FileDiff> {
  return invokeCommand<
    {
      path: string;
      oid: string;
      file: string;
      oldPath: string | null;
      contextLines: number | null;
      ignoreWhitespace: boolean | null;
    },
    FileDiff
  >("diff_commit_file", {
    path,
    oid,
    file,
    oldPath: oldPath ?? null,
    contextLines: contextLines ?? null,
    ignoreWhitespace: ignoreWhitespace ?? null,
  });
}

export function stagedPatch(path: string): Promise<string> {
  return invokeCommand<{ path: string }, string>("staged_patch", { path });
}

export function diffRefFiles(path: string, from: string, to: string): Promise<CommitFileInfo[]> {
  return invokeCommand<{ path: string; from: string; to: string }, CommitFileInfo[]>(
    "diff_ref_files",
    { path, from, to }
  );
}

export function diffRefFile(
  path: string,
  from: string,
  to: string,
  file: string,
  oldPath?: string,
  contextLines?: number,
  ignoreWhitespace?: boolean
): Promise<FileDiff> {
  return invokeCommand<
    {
      path: string;
      from: string;
      to: string;
      file: string;
      oldPath: string | null;
      contextLines: number | null;
      ignoreWhitespace: boolean | null;
    },
    FileDiff
  >("diff_ref_file", {
    path,
    from,
    to,
    file,
    oldPath: oldPath ?? null,
    contextLines: contextLines ?? null,
    ignoreWhitespace: ignoreWhitespace ?? null,
  });
}

export function diffRefWorkdirFiles(path: string, rev: string): Promise<CommitFileInfo[]> {
  return invokeCommand<{ path: string; rev: string }, CommitFileInfo[]>("diff_ref_workdir_files", {
    path,
    rev,
  });
}

export function diffRefWorkdirFile(
  path: string,
  rev: string,
  file: string,
  oldPath?: string,
  contextLines?: number,
  ignoreWhitespace?: boolean
): Promise<FileDiff> {
  return invokeCommand<
    {
      path: string;
      rev: string;
      file: string;
      oldPath: string | null;
      contextLines: number | null;
      ignoreWhitespace: boolean | null;
    },
    FileDiff
  >("diff_ref_workdir_file", {
    path,
    rev,
    file,
    oldPath: oldPath ?? null,
    contextLines: contextLines ?? null,
    ignoreWhitespace: ignoreWhitespace ?? null,
  });
}

export function patchSave(path: string, from: string, to: string, dest: string): Promise<void> {
  return invokeCommand<{ path: string; from: string; to: string; dest: string }, void>(
    "patch_save",
    { path, from, to, dest }
  );
}

// --- Conflicts ----------------------------------------------------------

export function conflictList(path: string): Promise<string[]> {
  return invokeCommand<{ path: string }, string[]>("conflict_list", { path });
}

export function conflictRead(path: string, file: string): Promise<ConflictFile> {
  return invokeCommand<{ path: string; file: string }, ConflictFile>("conflict_read", {
    path,
    file,
  });
}

export function conflictResolve(path: string, file: string, content: string): Promise<void> {
  return invokeCommand<{ path: string; file: string; content: string }, void>("conflict_resolve", {
    path,
    file,
    content,
  });
}

// --- Terminal -----------------------------------------------------------

export function termCreate(cwd: string, cols: number, rows: number): Promise<number> {
  return invokeCommand<{ cwd: string; cols: number; rows: number }, number>("term_create", {
    cwd,
    cols,
    rows,
  });
}

export function termWrite(id: number, data: string): Promise<void> {
  return invokeCommand<{ id: number; data: string }, void>("term_write", {
    id,
    data,
  });
}

export function termResize(id: number, cols: number, rows: number): Promise<void> {
  return invokeCommand<{ id: number; cols: number; rows: number }, void>("term_resize", {
    id,
    cols,
    rows,
  });
}

export function termKill(id: number): Promise<void> {
  return invokeCommand<{ id: number }, void>("term_kill", { id });
}

// --- Watching -----------------------------------------------------------

export function watchRepo(path: string): Promise<void> {
  return invokeCommand<{ path: string }, void>("watch_repo", { path });
}

export function watchStop(): Promise<void> {
  return invokeCommand<Record<string, never>, void>("watch_stop", {});
}

// --- Credentials and SSH ------------------------------------------------

export function credentialStore(host: string, username: string, password: string): Promise<void> {
  return invokeCommand<{ host: string; username: string; password: string }, void>(
    "credential_store",
    { host, username, password }
  );
}

export function credentialPrefsSet(
  sshKeyPath: string | null,
  useAgent: boolean,
  useCredentialHelper: boolean
): Promise<void> {
  return invokeCommand<
    { sshKeyPath: string | null; useAgent: boolean; useCredentialHelper: boolean },
    void
  >("credential_prefs_set", { sshKeyPath, useAgent, useCredentialHelper });
}

export function sshPublicKey(path: string): Promise<string> {
  return invokeCommand<{ path: string }, string>("ssh_public_key", { path });
}

export function sshKeyGenerate(path: string, comment: string): Promise<GeneratedKey> {
  return invokeCommand<{ path: string; comment: string }, GeneratedKey>("ssh_key_generate", {
    path,
    comment,
  });
}

// --- Hosting accounts ---------------------------------------------------

export function accountList(): Promise<HostingAccount[]> {
  return invokeCommand<Record<string, never>, HostingAccount[]>("account_list", {});
}

export function accountAdd(
  host: string,
  username: string,
  provider: string,
  token: string,
  verified: boolean,
  email?: string
): Promise<HostingAccount[]> {
  return invokeCommand<
    {
      host: string;
      username: string;
      provider: string;
      token: string;
      verified: boolean;
      email: string | null;
    },
    HostingAccount[]
  >("account_add", { host, username, provider, token, verified, email: email ?? null });
}

export function accountRemove(host: string, username: string): Promise<HostingAccount[]> {
  return invokeCommand<{ host: string; username: string }, HostingAccount[]>("account_remove", {
    host,
    username,
  });
}

export function accountSetDefault(host: string, username: string): Promise<HostingAccount[]> {
  return invokeCommand<{ host: string; username: string }, HostingAccount[]>(
    "account_set_default",
    { host, username }
  );
}

export function accountCheck(host: string, username: string): Promise<AccountCheckResult> {
  return invokeCommand<{ host: string; username: string }, AccountCheckResult>("account_check", {
    host,
    username,
  });
}

// --- AI keys and CLIs ---------------------------------------------------

export function aiKeyGet(provider: string): Promise<string | null> {
  return invokeCommand<{ provider: string }, string | null>("ai_key_get", {
    provider,
  });
}

export function aiKeySet(provider: string, key: string): Promise<void> {
  return invokeCommand<{ provider: string; key: string }, void>("ai_key_set", {
    provider,
    key,
  });
}

export function aiKeyDelete(provider: string): Promise<void> {
  return invokeCommand<{ provider: string }, void>("ai_key_delete", {
    provider,
  });
}

export function aiCliDetect(): Promise<CliAgentInfo[]> {
  return invokeCommand<Record<string, never>, CliAgentInfo[]>("ai_cli_detect", {});
}

export function aiCliRun(request: CliRunRequest): Promise<CliRunResult> {
  return invokeCommand<{ request: CliRunRequest }, CliRunResult>("ai_cli_run", {
    request,
  });
}

// --- Editors and fonts --------------------------------------------------

export function editorsDetect(): Promise<EditorInfo[]> {
  return invokeCommand<Record<string, never>, EditorInfo[]>("editors_detect", {});
}

export function editorOpen(editorId: string, target: string): Promise<EditorInfo> {
  return invokeCommand<{ editorId: string; path: string }, EditorInfo>("editor_open", {
    editorId,
    path: target,
  });
}

export function fontsList(): Promise<FontFamily[]> {
  return invokeCommand<Record<string, never>, FontFamily[]>("fonts_list", {});
}

// --- HTTP and forge -----------------------------------------------------

export function httpRequest(request: HttpRequest): Promise<HttpResponse> {
  return invokeCommand<{ request: HttpRequest }, HttpResponse>("http_request", {
    request,
  });
}

export function forgeRequest(
  host: string,
  request: HttpRequest,
  repoPath?: string
): Promise<HttpResponse> {
  return invokeCommand<
    { repoPath: string | null; host: string; request: HttpRequest },
    HttpResponse
  >("forge_request", { repoPath: repoPath ?? null, host, request });
}
