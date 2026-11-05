import { create } from "zustand";
import type { RepositoryInfo, StatusSummary } from "@/lib/git-core";
import { repoInfo, repoOpen, repoStatus } from "@/commands";

/**
 * The project page's own view of its single working copy.
 *
 * The page shows exactly one repository — the one the app config names — so it
 * keeps its state here instead of borrowing the Git feature's store. Sharing
 * that store would put this working copy in the Git tab strip and in the
 * recent-repositories list, and would let a repository opened in the Git
 * feature answer for this one.
 */
interface ProjectRepoState {
  repo: RepositoryInfo | null;
  status: StatusSummary | null;
  refreshing: boolean;
  open: (path: string) => Promise<RepositoryInfo>;
  refresh: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

let openSeq = 0;
let fullSeq = 0;
let statusSeq = 0;

export const useProjectRepo = create<ProjectRepoState>((set, get) => ({
  repo: null,
  status: null,
  refreshing: false,

  open: async (path) => {
    const seq = ++openSeq;
    const previous = get().repo?.path;
    set({ refreshing: true });

    let repo: RepositoryInfo;
    try {
      // `remember: false`: the Git feature owns the recent-repositories list,
      // and the project page opening its configured working copy is not the
      // user opening a repository.
      repo = await repoOpen(path, false);
    } catch (error) {
      if (seq === openSeq) set({ refreshing: false });
      throw error;
    }
    if (seq !== openSeq) return repo;

    // libgit2 answers with the repository's canonical path, which may not be
    // the configured string. Adopting it is what keeps `repo.path` equal to the
    // `repo` the page hands down, since the panes compare the two with `===`.
    set(previous === repo.path ? { repo } : { repo, status: null });

    try {
      await get().refresh();
    } finally {
      if (seq === openSeq) set({ refreshing: false });
    }
    return repo;
  },

  refresh: async () => {
    const { repo } = get();
    if (!repo) return;
    const path = repo.path;
    const seq = ++fullSeq;
    const statusEpoch = ++statusSeq;
    const [info, status] = await Promise.all([repoInfo(path), repoStatus(path)]);
    if (get().repo?.path !== path || seq !== fullSeq) return;
    // A newer status read owns the working copy state; this one still refreshes
    // the repository itself.
    if (statusEpoch === statusSeq) set({ repo: info, status });
    else set({ repo: info });
  },

  refreshStatus: async () => {
    const { repo } = get();
    if (!repo) return;
    const path = repo.path;
    const statusEpoch = ++statusSeq;
    const status = await repoStatus(path);
    if (get().repo?.path !== path || statusEpoch !== statusSeq) return;
    set({ status });
  },
}));
