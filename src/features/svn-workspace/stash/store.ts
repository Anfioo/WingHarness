import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { svnStoreWrite } from "@/commands";
import type { StashEntry } from "@/lib/svn-core/types";
import { svnStateStorage } from "../persist-storage";

/**
 * The saved stashes, one list shared by every window and persisted to the SVN
 * data directory under the key `svn-stashes`.
 *
 * Stash entries are feature data, not view preferences — the patch is the only
 * copy of the changes a user set aside — so they go through
 * {@link svnStateStorage} (the same store the git feature persists to), never
 * localStorage or sessionStorage.
 *
 * The reference kept this in a Pinia store backed by localStorage and persisted
 * synchronously before publishing the new state. {@link svnStateStorage} writes
 * are debounced and fire-and-forget, so a plain `set` could publish an entry
 * whose write later failed. `addEntry` therefore writes the entry durably first
 * (via `svnStoreWrite`, the same envelope the `persist` middleware produces) and
 * only then updates the store; a failed write leaves the list untouched.
 */

export const STASH_STORE_KEY = "svn-stashes";

interface StashState {
  entries: StashEntry[];
  /** Persist an entry, then publish it. Rejects without publishing on a failed write. */
  addEntry: (entry: StashEntry) => Promise<void>;
  removeEntry: (id: string) => void;
  /** Drop every stash belonging to one working copy. */
  clearWorkspace: (workspacePath: string) => void;
}

/** The `{ state, version }` envelope the zustand `persist` layer reads back. */
function serialize(entries: StashEntry[]): string {
  return JSON.stringify({ state: { entries }, version: 0 });
}

export const useStashStore = create<StashState>()(
  persist(
    (set, get) => ({
      entries: [],

      addEntry: async (entry) => {
        const next = [entry, ...get().entries];
        // Durably store the only copy of the patch before publishing it, so a
        // failed write cannot look like a saved stash.
        await svnStoreWrite(STASH_STORE_KEY, serialize(next));
        set({ entries: next });
      },

      removeEntry: (id) => set((state) => ({ entries: state.entries.filter((e) => e.id !== id) })),

      clearWorkspace: (workspacePath) =>
        set((state) => ({
          entries: state.entries.filter((entry) => entry.workspacePath !== workspacePath),
        })),
    }),
    {
      name: STASH_STORE_KEY,
      storage: createJSONStorage(() => svnStateStorage),
      partialize: (state) => ({ entries: state.entries }),
    }
  )
);

/** The stashes that belong to one working copy, newest first. */
export function stashesForWorkspace(
  entries: StashEntry[],
  workspacePath: string | null
): StashEntry[] {
  if (!workspacePath) return [];
  return entries.filter((entry) => entry.workspacePath === workspacePath);
}
