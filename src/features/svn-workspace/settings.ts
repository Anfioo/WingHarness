import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { svnStateStorage } from "./persist-storage";

/**
 * The SVN workspace feature's settings, shared by every window. Persisted to the
 * SVN data directory under a single store key (`svn-settings`) via
 * {@link svnStateStorage}, never localStorage.
 *
 * The reference kept theme and language here too; both are app-wide concerns
 * this project already owns, so the feature keeps only what is genuinely its
 * own — the `svn` binary and the log/gitignore defaults.
 */

export interface SvnSettings {
  /** Path to the `svn` executable; empty means "find it on PATH". */
  svnPath: string;
  /** Encoding the engine should assume for command output. */
  encoding: string;
  /** How many revisions the log panel loads per batch. */
  logLimit: number;
  /** Whether `.gitignore` rules filter the status list. */
  gitignoreEnabled: boolean;
}

const DEFAULT_SETTINGS: SvnSettings = {
  svnPath: "",
  encoding: "utf-8",
  logLimit: 50,
  gitignoreEnabled: false,
};

interface SvnSettingsStore extends SvnSettings {
  updateSettings: (partial: Partial<SvnSettings>) => void;
  resetSettings: () => void;
}

export const useSvnSettingsStore = create<SvnSettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      updateSettings: (partial) => set(partial),
      resetSettings: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      name: "svn-settings",
      storage: createJSONStorage(() => svnStateStorage),
      partialize: (state) => ({
        svnPath: state.svnPath,
        encoding: state.encoding,
        logLimit: state.logLimit,
        gitignoreEnabled: state.gitignoreEnabled,
      }),
    }
  )
);

/**
 * The settings as plain values, for callers that are not React components —
 * `useSvnWorkspace` reads `gitignoreEnabled` while loading, outside any render.
 */
export function readSvnSettings(): SvnSettings {
  const state = useSvnSettingsStore.getState();
  return {
    svnPath: state.svnPath,
    encoding: state.encoding,
    logLimit: state.logLimit,
    gitignoreEnabled: state.gitignoreEnabled,
  };
}

export function useSvnSettings(): {
  settings: SvnSettings;
  updateSettings: (partial: Partial<SvnSettings>) => void;
  resetSettings: () => void;
} {
  const state = useSvnSettingsStore();
  const settings = useMemo<SvnSettings>(
    () => ({
      svnPath: state.svnPath,
      encoding: state.encoding,
      logLimit: state.logLimit,
      gitignoreEnabled: state.gitignoreEnabled,
    }),
    [state.svnPath, state.encoding, state.logLimit, state.gitignoreEnabled]
  );

  return { settings, updateSettings: state.updateSettings, resetSettings: state.resetSettings };
}
