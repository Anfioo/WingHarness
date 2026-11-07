import { create } from "zustand";

/**
 * What an editor tab is showing, when the tab's content is drawn by the host
 * rather than by codelet.
 *
 * codelet can only put an iframe of its own inside a tab, and React cannot mount
 * into that iframe. So the tabs below exist as real codelet tab strips, and the
 * React content is laid over the frame the tab would have shown — the workbench
 * reports which panel is visible, and that is what this store holds.
 */

export interface DiffTabTarget {
  /** The commit the diff is taken at, or null for the working tree. */
  oid: string | null;
  /** `/`-rooted path inside the working copy. */
  path: string;
  oldPath: string | null;
  /** The index rather than the working tree. */
  staged: boolean;
  /** Open a second tab even when the same diff is already showing, and do not reuse it. */
  forceNew?: boolean;
}

export type EditorTabSurface =
  | { kind: "diff"; target: DiffTabTarget }
  | { kind: "preview"; path: string; name: string }
  /** Two revisions compared, or one revision against the working tree when `right` is null. */
  | { kind: "compare"; left: string; right: string | null; path?: string }
  /** One file as it is in a revision, read-only. */
  | { kind: "revisionFile"; oid: string; path: string }
  /** Every file a revision holds, as a browsable list. */
  | { kind: "revisionTree"; oid: string }
  /** A file's commits, newest first, optionally starting at a revision. */
  | { kind: "fileHistory"; path: string; fromOid?: string }
  /** A Markdown document rendered for reading, with its outline. */
  | { kind: "markdown"; path: string; name: string }
  /**
   * A tab of the project page's database panel: a query file, a project `.sql`
   * file, or a table's data. One kind rather than three — what the tab holds is
   * already in `useProjectDb`, and the panel looks it up by id.
   */
  | { kind: "dbTab"; tabId: string };

interface EditorTabsState {
  /** Identity of the panel that reported itself visible. */
  key: string | null;
  surface: EditorTabSurface | null;
  show: (key: string, surface: EditorTabSurface) => void;
  hide: (key: string) => void;
  reset: () => void;
}

export const useEditorTabs = create<EditorTabsState>((set) => ({
  key: null,
  surface: null,
  // Only one panel is visible at a time, but the shell hides the previous panel
  // before it shows the next one; matching on the key keeps that order harmless.
  show: (key, surface) =>
    set((state) => (state.key === key && state.surface === surface ? state : { key, surface })),
  hide: (key) => set((state) => (state.key === key ? { key: null, surface: null } : state)),
  reset: () => set({ key: null, surface: null }),
}));
