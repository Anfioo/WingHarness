import { create } from "zustand";

/** What the bottom Git tool window is showing. */
export type GitToolTab = "log" | "console" | "workingTree";

interface GitViewState {
  /** The tool window is docked below the editor. */
  panelOpen: boolean;
  /** The commit view is covering the side bar. */
  changesOpen: boolean;
  tab: GitToolTab;
  /** The branch the log is filtered to, or null for every branch. */
  branch: string | null;
  /** The branch HEAD is on, once the refs have been read. */
  currentBranch: string | null;
  selectedOid: string | null;
  /** Every commit picked in the list; `selectedOid` is the one the detail shows. */
  selectedOids: string[];
  /** Bumped when the working copy may have changed, e.g. after an editor save. */
  refreshToken: number;
  /** The change list nests files under their directories instead of a flat list. */
  changesTree: boolean;
  /** A file row also shows the directory the file sits in. */
  changesShowPath: boolean;
  togglePanel: () => void;
  openPanel: (tab?: GitToolTab) => void;
  closePanel: () => void;
  toggleChanges: () => void;
  openChanges: () => void;
  closeChanges: () => void;
  setTab: (tab: GitToolTab) => void;
  setBranch: (branch: string | null) => void;
  setCurrentBranch: (branch: string | null) => void;
  selectCommit: (oid: string | null) => void;
  setSelectedOids: (oids: string[]) => void;
  requestRefresh: () => void;
  setChangesTree: (tree: boolean) => void;
  setChangesShowPath: (showPath: boolean) => void;
  reset: () => void;
}

const INITIAL = {
  panelOpen: false,
  changesOpen: false,
  tab: "log" as GitToolTab,
  branch: null,
  currentBranch: null,
  selectedOid: null,
  selectedOids: [],
  refreshToken: 0,
  changesTree: true,
  changesShowPath: false,
};

/**
 * The project page's Git views, shared by the two activity-bar buttons and the
 * tool window they open.
 *
 * Both views live outside the workbench's tab model — one is docked below the
 * editor, one covers the side bar — so what the reader chose (which tool tab,
 * which branch, which commit) is kept here and survives either being closed.
 */
export const useGitView = create<GitViewState>((set) => ({
  ...INITIAL,
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
  openPanel: (tab) => set((state) => ({ panelOpen: true, tab: tab ?? state.tab })),
  closePanel: () => set({ panelOpen: false }),
  toggleChanges: () => set((state) => ({ changesOpen: !state.changesOpen })),
  openChanges: () => set({ changesOpen: true }),
  closeChanges: () => set({ changesOpen: false }),
  setTab: (tab) => set({ tab }),
  setBranch: (branch) => set({ branch, selectedOid: null, selectedOids: [] }),
  setCurrentBranch: (currentBranch) => set({ currentBranch }),
  selectCommit: (selectedOid) => set({ selectedOid }),
  setSelectedOids: (selectedOids) => set({ selectedOids }),
  requestRefresh: () => set((state) => ({ refreshToken: state.refreshToken + 1 })),
  setChangesTree: (changesTree) => set({ changesTree }),
  setChangesShowPath: (changesShowPath) => set({ changesShowPath }),
  reset: () => set({ ...INITIAL }),
}));
