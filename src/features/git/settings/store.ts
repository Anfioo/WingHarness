import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  moveRepoGroup as reorderRepoGroups,
  nextRepoGroupColor,
  type RepoGroup,
} from "@/lib/git-core";
import {
  DEFAULT_AI_STYLE,
  type AiConnectionStatus,
  type AiStyleConfig,
  type CommitStyle,
  type ReviewStyle,
} from "@/lib/git-core/ai";
import { gitStateStorage } from "../persist-storage";
import { applyFonts } from "@/lib/fonts/stack";

export type SettingsSection = "appearance" | "git" | "accounts" | "ai";

export type RepoGroupDropPosition = "before" | "after";

interface GitSettingsState {
  autoFetchMinutes: number;
  showPullRequests: boolean;
  cherryPickRecordOrigin: boolean;
  worktreeRoot: string | null;
  editorId: string | null;
  repoGroups: RepoGroup[];
  repoGroupOf: Record<string, string>;
  interfaceFontFamily: string | null;
  codeFontFamily: string | null;
  aiStyle: AiStyleConfig;
  aiStatus: AiConnectionStatus;
  /** Signature of the settings the last connection test ran against. */
  aiStatusKey: string | null;
  settingsSection: SettingsSection;
  setAutoFetchMinutes: (minutes: number) => void;
  setShowPullRequests: (on: boolean) => void;
  setCherryPickRecordOrigin: (on: boolean) => void;
  setWorktreeRoot: (root: string | null) => void;
  setEditorId: (editorId: string | null) => void;
  addRepoGroup: (name: string) => RepoGroup;
  updateRepoGroup: (id: string, patch: { name?: string; color?: number }) => void;
  removeRepoGroup: (id: string) => void;
  moveRepoGroup: (id: string, targetId: string, position: RepoGroupDropPosition) => void;
  setRepoGroup: (path: string, groupId: string | null) => void;
  setInterfaceFontFamily: (family: string | null) => void;
  setCodeFontFamily: (family: string | null) => void;
  resetFonts: () => void;
  setCommitStyle: (patch: Partial<CommitStyle>) => void;
  setReviewStyle: (patch: Partial<ReviewStyle>) => void;
  setAiStatus: (status: AiConnectionStatus, key: string) => void;
  setSettingsSection: (section: SettingsSection) => void;
}

function slugId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "group";
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export const useGitSettings = create<GitSettingsState>()(
  persist(
    (set, get) => ({
      autoFetchMinutes: 0,
      showPullRequests: true,
      cherryPickRecordOrigin: true,
      worktreeRoot: null,
      editorId: null,
      repoGroups: [],
      repoGroupOf: {},
      interfaceFontFamily: null,
      codeFontFamily: null,
      aiStyle: DEFAULT_AI_STYLE,
      aiStatus: "untested",
      aiStatusKey: null,
      settingsSection: "appearance",

      setAutoFetchMinutes: (autoFetchMinutes) => set({ autoFetchMinutes }),
      setShowPullRequests: (showPullRequests) => set({ showPullRequests }),
      setCherryPickRecordOrigin: (cherryPickRecordOrigin) => set({ cherryPickRecordOrigin }),
      setWorktreeRoot: (worktreeRoot) => set({ worktreeRoot }),
      setEditorId: (editorId) => set({ editorId }),
      addRepoGroup: (name) => {
        const groups = get().repoGroups;
        const id = slugId(name, new Set(groups.map((group) => group.id)));
        const group: RepoGroup = { id, name: name.trim(), color: nextRepoGroupColor(groups) };
        set({ repoGroups: [...groups, group] });
        return group;
      },
      updateRepoGroup: (id, patch) =>
        set((state) => ({
          repoGroups: state.repoGroups.map((group) =>
            group.id === id ? { ...group, ...patch } : group
          ),
        })),
      removeRepoGroup: (id) =>
        set((state) => ({
          repoGroups: state.repoGroups.filter((group) => group.id !== id),
          repoGroupOf: Object.fromEntries(
            Object.entries(state.repoGroupOf).filter(([, groupId]) => groupId !== id)
          ),
        })),
      moveRepoGroup: (id, targetId, position) =>
        set((state) => ({
          repoGroups: reorderRepoGroups(state.repoGroups, id, targetId, position),
        })),
      setRepoGroup: (path, groupId) =>
        set((state) => {
          const next = { ...state.repoGroupOf };
          if (groupId) next[path] = groupId;
          else delete next[path];
          return { repoGroupOf: next };
        }),
      setInterfaceFontFamily: (interfaceFontFamily) => {
        set({ interfaceFontFamily });
        applyFonts({ interfaceFontFamily, codeFontFamily: get().codeFontFamily });
      },
      setCodeFontFamily: (codeFontFamily) => {
        set({ codeFontFamily });
        applyFonts({ interfaceFontFamily: get().interfaceFontFamily, codeFontFamily });
      },
      resetFonts: () => {
        set({ interfaceFontFamily: null, codeFontFamily: null });
        applyFonts({ interfaceFontFamily: null, codeFontFamily: null });
      },
      setCommitStyle: (patch) =>
        set((state) => ({
          aiStyle: { ...state.aiStyle, commit: { ...state.aiStyle.commit, ...patch } },
        })),
      setReviewStyle: (patch) =>
        set((state) => ({
          aiStyle: { ...state.aiStyle, review: { ...state.aiStyle.review, ...patch } },
        })),
      setAiStatus: (aiStatus, aiStatusKey) => set({ aiStatus, aiStatusKey }),
      setSettingsSection: (settingsSection) => set({ settingsSection }),
    }),
    {
      name: "git-settings",
      storage: createJSONStorage(() => gitStateStorage),
      partialize: (state) => ({
        autoFetchMinutes: state.autoFetchMinutes,
        showPullRequests: state.showPullRequests,
        cherryPickRecordOrigin: state.cherryPickRecordOrigin,
        worktreeRoot: state.worktreeRoot,
        editorId: state.editorId,
        repoGroups: state.repoGroups,
        repoGroupOf: state.repoGroupOf,
        interfaceFontFamily: state.interfaceFontFamily,
        codeFontFamily: state.codeFontFamily,
        aiStyle: state.aiStyle,
        settingsSection: state.settingsSection,
      }),
      // Settings written before a field existed have no value for it, so the
      // defaults are merged underneath instead of being dropped wholesale.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<GitSettingsState>;
        return {
          ...current,
          ...stored,
          aiStyle: {
            commit: { ...current.aiStyle.commit, ...stored.aiStyle?.commit },
            review: { ...current.aiStyle.review, ...stored.aiStyle?.review },
          },
        };
      },
      onRehydrateStorage: () => (state) => {
        if (state)
          applyFonts({
            interfaceFontFamily: state.interfaceFontFamily,
            codeFontFamily: state.codeFontFamily,
          });
      },
    }
  )
);
