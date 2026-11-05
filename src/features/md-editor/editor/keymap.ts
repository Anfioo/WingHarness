import { EditorSelection } from "@codemirror/state";
import type { KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";

/** File commands the page owns; the editor only reports that they were asked for. */
export type MdFileCommand = "save" | "saveAs" | "open" | "new" | "close";

/**
 * Wraps (or unwraps, when the same marks are already around the selection) the
 * selected text. With an empty selection the marks are inserted and the caret
 * is put between them.
 */
function wrapSelection(view: EditorView, before: string, after: string): boolean {
  const { state } = view;
  const { changes, selection, effects } = state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: `${before}${after}` },
        range: EditorSelection.cursor(range.from + before.length),
      };
    }

    const text = state.sliceDoc(range.from, range.to);
    // Toggling: a second press on already-wrapped text removes the marks again.
    if (
      text.length >= before.length + after.length &&
      text.startsWith(before) &&
      text.endsWith(after)
    ) {
      const inner = text.slice(before.length, text.length - after.length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }

    return {
      changes: { from: range.from, to: range.to, insert: `${before}${text}${after}` },
      range: EditorSelection.range(range.from + before.length, range.to + before.length),
    };
  });

  view.dispatch({ changes, selection, effects, userEvent: "input.format" });
  return true;
}

function insertLink(view: EditorView): boolean {
  const { state } = view;
  const { changes, selection, effects } = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = text ? `[${text}](url)` : "[](url)";
    const urlStart = range.from + insert.lastIndexOf("(url)") + 1;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: text
        ? EditorSelection.range(urlStart, urlStart + 3)
        : EditorSelection.cursor(range.from + 1),
    };
  });

  view.dispatch({ changes, selection, effects, userEvent: "input.format" });
  return true;
}

/** Replaces the heading markers on every line the selection touches. */
function setHeading(view: EditorView, level: 1 | 2 | 3 | 4 | 5 | 6): boolean {
  const { state } = view;
  const lines = new Set<number>();

  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let lineNumber = first; lineNumber <= last; lineNumber += 1) lines.add(lineNumber);
  }

  const changes = [...lines].map((lineNumber) => {
    const line = state.doc.line(lineNumber);
    const text = line.text.replace(/^#{1,6}[ \t]+/, "");
    return { from: line.from, to: line.to, insert: `${"#".repeat(level)} ${text}` };
  });

  view.dispatch({ changes, userEvent: "input.format" });
  return true;
}

function runFileCommand(onCommand: (command: MdFileCommand) => void, command: MdFileCommand) {
  onCommand(command);
  return true;
}

/**
 * The editor keymap. The five file commands are not implemented here — they go
 * through `onCommand` so the editor layer never imports the page store.
 */
export function mdKeymap(onCommand: (command: MdFileCommand) => void): KeyBinding[] {
  return [
    { key: "Mod-s", preventDefault: true, run: () => runFileCommand(onCommand, "save") },
    {
      key: "Mod-Shift-s",
      preventDefault: true,
      run: () => runFileCommand(onCommand, "saveAs"),
    },
    { key: "Mod-o", preventDefault: true, run: () => runFileCommand(onCommand, "open") },
    { key: "Mod-n", preventDefault: true, run: () => runFileCommand(onCommand, "new") },
    { key: "Mod-w", preventDefault: true, run: () => runFileCommand(onCommand, "close") },
    { key: "Mod-b", preventDefault: true, run: (view) => wrapSelection(view, "**", "**") },
    { key: "Mod-i", preventDefault: true, run: (view) => wrapSelection(view, "*", "*") },
    { key: "Mod-k", preventDefault: true, run: insertLink },
    { key: "Mod-1", preventDefault: true, run: (view) => setHeading(view, 1) },
    { key: "Mod-2", preventDefault: true, run: (view) => setHeading(view, 2) },
    { key: "Mod-3", preventDefault: true, run: (view) => setHeading(view, 3) },
    { key: "Mod-4", preventDefault: true, run: (view) => setHeading(view, 4) },
    { key: "Mod-5", preventDefault: true, run: (view) => setHeading(view, 5) },
    { key: "Mod-6", preventDefault: true, run: (view) => setHeading(view, 6) },
  ];
}
