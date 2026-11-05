import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { gitStateStorage } from "../persist-storage";

interface RepositoryPrefsState {
  cloneRoot: string | null;
  setCloneRoot: (path: string | null) => void;
}

export const useRepositoryPrefs = create<RepositoryPrefsState>()(
  persist(
    (set) => ({
      cloneRoot: null,
      setCloneRoot: (path) => set({ cloneRoot: path }),
    }),
    { name: "git-repository-prefs", storage: createJSONStorage(() => gitStateStorage) }
  )
);
