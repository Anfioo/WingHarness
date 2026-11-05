import { create } from "zustand";
import type {
  BranchInfo,
  RecentRepository,
  RemoteInfo,
  RepositoryInfo,
  StashInfo,
  StatusSummary,
  SubmoduleInfo,
  TagInfo,
  WorktreeInfo,
} from "@/lib/git-core";
import {
  branchList,
  configGet,
  conflictList,
  historyUnpushed,
  recentRepositories,
  remoteList,
  repoInfo,
  repoOpen,
  repoStatus,
  stashList,
  submoduleList,
  tagList,
  worktreeList,
} from "@/commands";

interface RepoState {
  repo: RepositoryInfo | null;
  status: StatusSummary | null;
  branches: BranchInfo[];
  tags: TagInfo[];
  stashes: StashInfo[];
  statusVersion: number;
  remotes: RemoteInfo[];
  submodules: SubmoduleInfo[];
  worktrees: WorktreeInfo[];
  conflicts: string[];
  unpushed: string[];
  recents: RecentRepository[];
  busy: string | null;
  opening: string | null;
  refreshing: boolean;
  profileId: string | null;
  lastFetchAt: number | null;
  fetchFailures: string[];
  loadRecents: () => Promise<void>;
  open: (path: string) => Promise<RepositoryInfo>;
  close: () => void;
  refresh: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  setBusy: (label: string | null) => void;
  setProfileId: (profileId: string | null) => void;
  markFetched: () => void;
  setFetchFailures: (names: string[]) => void;
}

let openSeq = 0;
let fullSeq = 0;
let statusSeq = 0;

export const useRepo = create<RepoState>((set, get) => ({
  repo: null,
  status: null,
  branches: [],
  tags: [],
  stashes: [],
  statusVersion: 0,
  remotes: [],
  submodules: [],
  worktrees: [],
  conflicts: [],
  unpushed: [],
  recents: [],
  busy: null,
  opening: null,
  refreshing: false,
  profileId: null,
  lastFetchAt: null,
  fetchFailures: [],

  loadRecents: async () => {
    const recents = await recentRepositories();
    set({ recents });
  },
  open: async (path) => {
    const seq = ++openSeq;
    const previousPath = get().repo?.path;
    set({ opening: path });
    let repo: RepositoryInfo;
    try {
      repo = await repoOpen(path);
    } catch (error) {
      if (seq === openSeq) set({ opening: null });
      throw error;
    }
    if (seq !== openSeq) return repo;
    if (previousPath !== undefined && previousPath !== repo.path) {
      set({
        repo,
        profileId: null,
        lastFetchAt: null,
        fetchFailures: [],
        opening: null,
        refreshing: true,
        status: null,
        branches: [],
        tags: [],
        stashes: [],
        remotes: [],
        submodules: [],
        worktrees: [],
        conflicts: [],
        unpushed: [],
      });
    } else {
      set({
        repo,
        profileId: null,
        lastFetchAt: null,
        fetchFailures: [],
        opening: null,
        refreshing: true,
      });
    }
    void configGet("git.profile", repo.path)
      .then((profileId) => {
        if (seq === openSeq && get().repo?.path === repo.path) set({ profileId });
      })
      .catch(() => undefined);
    try {
      await get().refresh();
    } finally {
      if (seq === openSeq) set({ refreshing: false });
    }
    void get().loadRecents();
    return repo;
  },
  close: () =>
    set({
      repo: null,
      status: null,
      branches: [],
      tags: [],
      stashes: [],
      remotes: [],
      submodules: [],
      worktrees: [],
      conflicts: [],
      unpushed: [],
      opening: null,
      refreshing: false,
      profileId: null,
      lastFetchAt: null,
      fetchFailures: [],
    }),
  refresh: async () => {
    const { repo } = get();
    if (!repo) return;
    const path = repo.path;
    const seq = ++fullSeq;
    const statusEpoch = ++statusSeq;
    const [
      info,
      status,
      branches,
      tags,
      stashes,
      remotes,
      submodules,
      conflicts,
      worktrees,
      unpushed,
    ] = await Promise.all([
      repoInfo(path),
      repoStatus(path),
      branchList(path),
      tagList(path),
      stashList(path),
      remoteList(path),
      submoduleList(path),
      conflictList(path),
      worktreeList(path).catch(() => [] as WorktreeInfo[]),
      historyUnpushed(path).catch(() => [] as string[]),
    ]);
    if (get().repo?.path !== path || seq !== fullSeq) return;
    if (statusEpoch === statusSeq) {
      set((state) => ({
        repo: info,
        status,
        branches,
        tags,
        stashes,
        remotes,
        submodules,
        worktrees,
        conflicts,
        unpushed,
        statusVersion: state.statusVersion + 1,
      }));
    } else {
      set({ repo: info, branches, tags, stashes, remotes, submodules, worktrees, unpushed });
    }
  },
  refreshStatus: async () => {
    const { repo } = get();
    if (!repo) return;
    const path = repo.path;
    const statusEpoch = ++statusSeq;
    const [status, conflicts] = await Promise.all([repoStatus(path), conflictList(path)]);
    if (get().repo?.path !== path || statusEpoch !== statusSeq) return;
    set((state) => ({ status, conflicts, statusVersion: state.statusVersion + 1 }));
  },
  setBusy: (busy) => set({ busy }),
  markFetched: () => set({ lastFetchAt: Date.now() }),
  setFetchFailures: (fetchFailures) => set({ fetchFailures }),
  setProfileId: (profileId) => set({ profileId }),
}));
