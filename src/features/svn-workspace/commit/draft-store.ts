import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { svnStateStorage } from "@/features/svn-workspace/persist-storage";

/**
 * The in-progress commit message, one draft per working copy, persisted to the
 * SVN data directory under the `svn-commit-draft` key.
 *
 * The reference kept the whole commit form in `sessionStorage` (`orca_commit_form`)
 * and its recent-messages list in `localStorage`; this project forbids business
 * state in WebView storage, so the draft lives here instead and the recent-message
 * list is dropped. Reopening a working copy restores exactly the message the user
 * was writing, and nothing else.
 */
interface CommitDraftState {
  /** Draft message keyed by working-copy path. */
  drafts: Record<string, string>;
  setDraft: (workspacePath: string, message: string) => void;
  clearDraft: (workspacePath: string) => void;
}

export const useCommitDraft = create<CommitDraftState>()(
  persist(
    (set) => ({
      drafts: {},
      setDraft: (workspacePath, message) =>
        set((state) => {
          const drafts = { ...state.drafts };
          if (message) drafts[workspacePath] = message;
          else delete drafts[workspacePath];
          return { drafts };
        }),
      clearDraft: (workspacePath) =>
        set((state) => {
          if (!(workspacePath in state.drafts)) return state;
          const drafts = { ...state.drafts };
          delete drafts[workspacePath];
          return { drafts };
        }),
    }),
    {
      name: "svn-commit-draft",
      storage: createJSONStorage(() => svnStateStorage),
      partialize: (state) => ({ drafts: state.drafts }),
    }
  )
);
