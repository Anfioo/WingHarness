import { create } from "zustand";
import type { GitignorePattern, SvnInfo, SvnStatus } from "@/lib/svn-core";

/**
 * The SVN workspace's window state: which working copy this window shows, its
 * status, and which of the nine panels is active.
 *
 * One window shows one working copy, and each window is its own WebView context,
 * so this store is per-working-copy by construction. It is deliberately not
 * persisted: the working copy on disk is the source of truth, and everything
 * here is re-derived by `useSvnWorkspace().loadWorkspace` on open. The only
 * persisted SVN state is the feature's settings (`./settings`).
 */

export type SvnTabId =
  | "changes"
  | "commit"
  | "update"
  | "checkout"
  | "log"
  | "diff"
  | "blame"
  | "stash"
  | "settings";

export interface SvnDiffTarget {
  path: string;
  oldRevision?: number;
  newRevision?: number;
}

export interface SvnWorkspaceState {
  /** The working copy this window shows; `null` before one is opened. */
  workspacePath: string | null;
  /** `svn status`, already filtered by the gitignore rules when enabled. */
  statusList: SvnStatus[];
  svnInfo: SvnInfo | null;
  isLoading: boolean;
  /** True while the list on screen is a cached snapshot, not yet re-verified. */
  statusIsStale: boolean;
  error: string | null;
  gitignorePatterns: GitignorePattern[];
  gitignoreMtime: number | null;
  gitignoreWorkspacePath: string | null;
  /** The active panel. Tabs, not routes: the reference's vue-router pages map
   *  onto this one field, and the diff/blame hand-off goes through
   *  `openDiff` / `openBlame` rather than a URL. */
  activeTab: SvnTabId;
  /** What the diff panel should show, set by `openDiff`. */
  diffTarget: SvnDiffTarget | null;
  /** Workspace-relative file path for the blame panel, set by `openBlame`. */
  blameTarget: string | null;
  /** Workspace-relative, `/`-separated paths currently selected. */
  selection: string[];

  setCurrentPath: (path: string | null) => void;
  setStatusList: (list: SvnStatus[]) => void;
  setSvnInfo: (info: SvnInfo | null) => void;
  setStatusIsStale: (value: boolean) => void;
  setLoading: (value: boolean) => void;
  setError: (value: string | null) => void;
  setGitignorePatterns: (patterns: GitignorePattern[]) => void;
  setGitignoreMtime: (mtime: number | null) => void;
  setGitignoreWorkspacePath: (path: string | null) => void;
  clearWorkspace: () => void;
  setActiveTab: (tab: SvnTabId) => void;
  openDiff: (target: SvnDiffTarget) => void;
  openBlame: (path: string) => void;
  setSelection: (paths: string[]) => void;
  toggleSelection: (path: string) => void;
  clearSelection: () => void;
}

export const useSvnWorkspaceStore = create<SvnWorkspaceState>()((set) => ({
  workspacePath: null,
  statusList: [],
  svnInfo: null,
  isLoading: false,
  statusIsStale: false,
  error: null,
  gitignorePatterns: [],
  gitignoreMtime: null,
  gitignoreWorkspacePath: null,
  activeTab: "changes",
  diffTarget: null,
  blameTarget: null,
  selection: [],

  setCurrentPath: (workspacePath) => set({ workspacePath }),
  setStatusList: (statusList) => set({ statusList }),
  setSvnInfo: (svnInfo) => set({ svnInfo }),
  setStatusIsStale: (statusIsStale) => set({ statusIsStale }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  setGitignorePatterns: (gitignorePatterns) => set({ gitignorePatterns }),
  setGitignoreMtime: (gitignoreMtime) => set({ gitignoreMtime }),
  setGitignoreWorkspacePath: (gitignoreWorkspacePath) => set({ gitignoreWorkspacePath }),
  // Reset everything tied to the working copy, and the work handed to the
  // diff/blame panels with it. The tab itself stays where the user left it.
  clearWorkspace: () =>
    set({
      workspacePath: null,
      statusList: [],
      svnInfo: null,
      statusIsStale: false,
      error: null,
      gitignorePatterns: [],
      gitignoreMtime: null,
      gitignoreWorkspacePath: null,
      diffTarget: null,
      blameTarget: null,
      selection: [],
    }),
  setActiveTab: (activeTab) => set({ activeTab }),
  openDiff: (diffTarget) => set({ diffTarget, activeTab: "diff" }),
  openBlame: (blameTarget) => set({ blameTarget, activeTab: "blame" }),
  setSelection: (selection) => set({ selection }),
  toggleSelection: (path) =>
    set((state) => ({
      selection: state.selection.includes(path)
        ? state.selection.filter((item) => item !== path)
        : [...state.selection, path],
    })),
  clearSelection: () => set({ selection: [] }),
}));

// -- Derived counts ----------------------------------------------------------
//
// Plain functions over a status list, not store fields: the changes panel and
// the header both read the same list, and a caller may want to count a subset.
// The rules are the reference store's `computed` definitions, kept identical.

/** A status that is neither `normal` nor blank. */
export function hasChanges(list: SvnStatus[]): boolean {
  return list.some((entry) => entry.statusCode !== "normal" && entry.statusCode !== "");
}

/** Content changes plus property-only modifications, as the reference counted
 *  them: status in modified/added/deleted/replaced, or a modified `prop_status`. */
export function countChanges(list: SvnStatus[]): number {
  const changedStatuses = new Set(["modified", "added", "deleted", "replaced"]);
  return list.filter(
    (entry) => changedStatuses.has(entry.statusCode) || entry.propStatus === "modified"
  ).length;
}

export function countModified(list: SvnStatus[]): number {
  return list.filter((entry) => entry.statusCode === "modified").length;
}

export function countAdded(list: SvnStatus[]): number {
  return list.filter((entry) => entry.statusCode === "added").length;
}

export function countDeleted(list: SvnStatus[]): number {
  return list.filter((entry) => entry.statusCode === "deleted").length;
}

export function countUnversioned(list: SvnStatus[]): number {
  return list.filter((entry) => entry.statusCode === "unversioned").length;
}

/** Conflicts, whether the content or a property is conflicted. */
export function countConflicted(list: SvnStatus[]): number {
  return list.filter(
    (entry) => entry.statusCode === "conflicted" || entry.propStatus === "conflicted"
  ).length;
}

export function countMissing(list: SvnStatus[]): number {
  return list.filter((entry) => entry.statusCode === "missing").length;
}
