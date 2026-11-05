import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { toast } from "sonner";
import { openGitRepoWindow, gitRepoWindowLabel, showGitHome } from "@/lib/git-windows";
import { destroyWindow } from "@/lib/window";
import type { RepoGroupDropPosition } from "@/lib/git-core";
import { basename } from "@/features/git/utils";
import { gitStateStorage } from "@/features/git/persist-storage";
import { useRepo } from "@/features/git/repository-store";
import i18n from "@/i18n";

interface RepoTabState {
  tabs: string[];
  worktreeTabs: string[];
  worktreeMains: Record<string, string>;
  tabGroupsCollapsed: Record<string, boolean>;
  addTab: (path: string) => void;
  removeTab: (path: string) => void;
  moveTab: (source: string, target: string, position: RepoGroupDropPosition) => void;
  setWorktrees: (tabs: string[], mains: Record<string, string>) => void;
  toggleGroupCollapsed: (id: string) => void;
  setGroupCollapsed: (id: string, collapsed: boolean) => void;
  setGroupsCollapsed: (collapsed: Record<string, boolean>) => void;
}

export const useRepoTabs = create<RepoTabState>()(
  persist(
    (set) => ({
      tabs: [],
      worktreeTabs: [],
      worktreeMains: {},
      tabGroupsCollapsed: {},
      addTab: (path) =>
        set((state) => (state.tabs.includes(path) ? state : { tabs: [...state.tabs, path] })),
      removeTab: (path) =>
        set((state) => ({
          tabs: state.tabs.filter((tab) => tab !== path),
          worktreeTabs: state.worktreeTabs.filter((tab) => tab !== path),
        })),
      moveTab: (source, target, position) =>
        set((state) => {
          if (source === target) return state;
          const rest = state.tabs.filter((tab) => tab !== source);
          const index = rest.indexOf(target);
          if (index < 0) return state;
          rest.splice(position === "before" ? index : index + 1, 0, source);
          return { tabs: rest };
        }),
      setWorktrees: (worktreeTabs, worktreeMains) => set({ worktreeTabs, worktreeMains }),
      toggleGroupCollapsed: (id) =>
        set((state) => ({
          tabGroupsCollapsed: { ...state.tabGroupsCollapsed, [id]: !state.tabGroupsCollapsed[id] },
        })),
      setGroupCollapsed: (id, collapsed) =>
        set((state) => ({ tabGroupsCollapsed: { ...state.tabGroupsCollapsed, [id]: collapsed } })),
      setGroupsCollapsed: (collapsed) =>
        set((state) => ({ tabGroupsCollapsed: { ...state.tabGroupsCollapsed, ...collapsed } })),
    }),
    {
      name: "git-repo-tabs",
      storage: createJSONStorage(() => gitStateStorage),
    }
  )
);

const PATH_SEPARATORS = /[/\\]/;

export interface TabLabel {
  name: string;
  hint: string | null;
}

function partsOf(path: string): string[] {
  return path.split(PATH_SEPARATORS).filter(Boolean);
}

function suffixOf(parts: string[], depth: number): string {
  return parts
    .slice(Math.max(0, parts.length - depth))
    .join("/")
    .toLowerCase();
}

function uniqueHint(path: string, paths: readonly string[]): string | null {
  const parts = partsOf(path);
  const name = basename(path).toLowerCase();
  const rivals = paths
    .filter((other) => other !== path && basename(other).toLowerCase() === name)
    .map(partsOf);
  if (rivals.length === 0) return null;
  for (let depth = 2; depth <= parts.length; depth += 1) {
    const key = suffixOf(parts, depth);
    if (rivals.every((other) => suffixOf(other, depth) !== key)) {
      return parts.slice(parts.length - depth, parts.length - 1).join("/") || null;
    }
  }
  return parts.slice(0, parts.length - 1).join("/") || null;
}

export function tabLabels(paths: readonly string[]): Map<string, TabLabel> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const key = basename(path).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const labels = new Map<string, TabLabel>();
  for (const path of paths) {
    const name = basename(path);
    labels.set(path, {
      name,
      hint: (counts.get(name.toLowerCase()) ?? 0) > 1 ? uniqueHint(path, paths) : null,
    });
  }
  return labels;
}

/**
 * Show `path`: put it in the strip and open that repository's window, focusing
 * the window if it is already on screen. A repository that cannot be opened has
 * no window to show it, so it is reported and dropped from the strip again.
 */
export function activateTab(path: string): void {
  useRepoTabs.getState().addTab(path);
  if (path === useRepo.getState().repo?.path) return;
  void openGitRepoWindow(path).catch((error: unknown) => {
    toast.error(
      i18n.t("gitRepo.extras.tabs.couldNotOpen", {
        error: (error as { message?: string })?.message ?? String(error),
      })
    );
    useRepoTabs.getState().removeTab(path);
  });
}

/**
 * Leave the repository `repoPath` names: forget it, close its window, and show
 * the picker in the main window. The picker lives in the main window, which a
 * repository window cannot navigate, so it is asked for over an event. The
 * window is closed rather than emptied because a window here is the repository:
 * staying open past it would leave a window whose title and page disagree.
 */
export function goToRepoHome(repoPath?: string): void {
  useRepo.getState().close();
  void showGitHome();
  if (repoPath) void destroyWindow(gitRepoWindowLabel(repoPath));
}

/** Close the windows of `paths` and drop them from the strip. Closing the one
 *  that shows the current repository steps to the last remaining window, or
 *  back to the picker when none is left. */
export function closeRepoTabs(paths: readonly string[]): void {
  if (paths.length === 0) return;
  const closing = new Set(paths);
  const store = useRepoTabs.getState();
  const current = useRepo.getState().repo?.path ?? null;
  const remaining = store.tabs.filter((tab) => !closing.has(tab));
  for (const tab of closing) store.removeTab(tab);
  for (const tab of closing) void destroyWindow(gitRepoWindowLabel(tab));
  if (!current || !closing.has(current)) return;
  if (remaining.length > 0) activateTab(remaining[remaining.length - 1]);
  else goToRepoHome(current);
}
