import type { EditorView } from "@codemirror/view";

let active: EditorView | null = null;

/** The editor the toolbar and context menu act on; null while no tab is open. */
export function setActiveView(view: EditorView | null): void {
  active = view;
}

export function getActiveView(): EditorView | null {
  return active;
}
