import { create } from "zustand";

/**
 * The live text of every Markdown document a preview tab is showing.
 *
 * The preview extension owns the workbench's documents and writes here on every
 * change; the preview tab reads it. Handing the source through `EditorTabSurface`
 * instead would build a new surface object per keystroke and re-render the tab
 * strip with it.
 */
interface MarkdownPreviewDocsState {
  /** Absolute document path as codelet spells it, to its current source. */
  docs: Record<string, string>;
  set: (path: string, text: string) => void;
  remove: (path: string) => void;
  reset: () => void;
}

export const useMarkdownPreviewDocs = create<MarkdownPreviewDocsState>((set) => ({
  docs: {},
  set: (path, text) =>
    set((state) => (state.docs[path] === text ? state : { docs: { ...state.docs, [path]: text } })),
  remove: (path) =>
    set((state) => {
      if (!(path in state.docs)) return state;
      const docs = { ...state.docs };
      delete docs[path];
      return { docs };
    }),
  reset: () => set({ docs: {} }),
}));
