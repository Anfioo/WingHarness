// Formatting actions shared by the toolbar, the context menu and (through the
// same primitives) the editor keymap. Every primitive dispatches exactly once,
// so a formatting step is one undo entry.

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LucideIcon } from "lucide-react";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Sigma,
  SquareCode,
  Strikethrough,
  Table,
  Type,
  Workflow,
} from "lucide-react";
import i18n from "@/i18n";

const OL_PREFIX_RE = /^ {0,3}\d{1,9}[.)][ \t]+/;
const TASK_PREFIX_RE = /^ {0,3}[-*][ \t]+\[[ xX]\][ \t]+/;
const UL_PREFIX_RE = /^ {0,3}[-*][ \t]+/;
const QUOTE_PREFIX_RE = /^ {0,3}>[ \t]?/;
const HEADING_PREFIX_RE = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;

interface LineEdit {
  from: number;
  to: number;
  insert: string;
}

/** Position after a set of line edits, keeping the caret roughly in place. */
function mapPosition(pos: number, edits: readonly LineEdit[]): number {
  let offset = 0;
  for (const edit of edits) {
    if (pos < edit.from) break;
    const oldLength = edit.to - edit.from;
    const delta = edit.insert.length - oldLength;
    if (pos <= edit.to) {
      return (
        edit.from + offset + Math.max(0, Math.min(pos - edit.from + delta, edit.insert.length))
      );
    }
    offset += delta;
  }
  return pos + offset;
}

function dispatchLineEdits(view: EditorView, edits: LineEdit[]): boolean {
  const filled = edits.filter((edit) => edit.insert !== view.state.sliceDoc(edit.from, edit.to));
  if (filled.length === 0) return false;

  const sorted = [...filled].sort((left, right) => left.from - right.from);
  const { state } = view;
  const selection = EditorSelection.create(
    state.selection.ranges.map((range) =>
      EditorSelection.range(mapPosition(range.anchor, sorted), mapPosition(range.head, sorted))
    ),
    state.selection.mainIndex
  );

  view.dispatch({ changes: sorted, selection, userEvent: "input.format" });
  return true;
}

/** 1-based line numbers the selection touches, minus a trailing line it only reaches. */
function selectedLineNumbers(view: EditorView): number[] {
  const { state } = view;
  const numbers = new Set<number>();

  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    // A selection ending at the very start of a line does not include that line.
    if (!range.empty && last > first && state.doc.line(last).from === range.to) last -= 1;
    for (let line = first; line <= last; line += 1) numbers.add(line);
  }

  return [...numbers].sort((left, right) => left - right);
}

function matchListMarker(text: string): RegExpExecArray | null {
  return OL_PREFIX_RE.exec(text) ?? TASK_PREFIX_RE.exec(text) ?? UL_PREFIX_RE.exec(text);
}

function matchTaskMarker(text: string): RegExpExecArray | null {
  return TASK_PREFIX_RE.exec(text);
}

function matchBulletMarker(text: string): RegExpExecArray | null {
  // A task item has its own prefix; a plain bullet must not swallow it.
  return TASK_PREFIX_RE.test(text) ? null : UL_PREFIX_RE.exec(text);
}

function matchOrderedMarker(text: string): RegExpExecArray | null {
  return OL_PREFIX_RE.exec(text);
}

function matchQuoteMarker(text: string): RegExpExecArray | null {
  return QUOTE_PREFIX_RE.exec(text);
}

/**
 * Wraps every selection with `before`/`after`. An empty selection gets the pair
 * inserted with the caret in between; running the same action again removes the
 * marks, so every formatting button toggles.
 */
export function wrapSelection(view: EditorView, before: string, after: string = before): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);

    if (range.empty) {
      const outerBefore =
        range.from >= before.length &&
        state.sliceDoc(range.from - before.length, range.from) === before;
      const outerAfter =
        range.from + after.length <= state.doc.length &&
        state.sliceDoc(range.from, range.from + after.length) === after;

      if (outerBefore && outerAfter) {
        return {
          changes: [
            { from: range.from - before.length, to: range.from },
            { from: range.from, to: range.from + after.length },
          ],
          range: EditorSelection.cursor(range.from - before.length),
        };
      }

      return {
        changes: { from: range.from, insert: `${before}${after}` },
        range: EditorSelection.cursor(range.from + before.length),
      };
    }

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

    const outerBefore =
      range.from >= before.length &&
      state.sliceDoc(range.from - before.length, range.from) === before;
    const outerAfter =
      range.to + after.length <= state.doc.length &&
      state.sliceDoc(range.to, range.to + after.length) === after;

    if (outerBefore && outerAfter) {
      return {
        changes: [
          { from: range.from - before.length, to: range.from },
          { from: range.to, to: range.to + after.length },
        ],
        range: EditorSelection.range(range.from - before.length, range.to - before.length),
      };
    }

    return {
      changes: { from: range.from, to: range.to, insert: `${before}${text}${after}` },
      range: EditorSelection.range(
        range.from + before.length,
        range.from + before.length + text.length
      ),
    };
  });

  view.dispatch({ ...changes, userEvent: "input.format" });
  return true;
}

/**
 * Adds or removes a block prefix on every selected line. `ordered` renumbers
 * the lines 1..n; running the same action on already-prefixed lines removes it.
 */
export function toggleLinePrefix(view: EditorView, prefix: string, ordered?: boolean): boolean {
  const { state } = view;
  const lines = selectedLineNumbers(view);
  // A multi-line selection leaves blank separator lines alone; one empty line
  // still gets the prefix, which is how a new list item is started.
  const targets = lines.filter((lineNumber) => {
    const text = state.doc.line(lineNumber).text;
    return text.trim().length > 0 || lines.length === 1;
  });
  if (targets.length === 0) return false;

  const specific = ordered
    ? matchOrderedMarker
    : prefix.trimStart().startsWith(">")
      ? matchQuoteMarker
      : prefix.includes("[ ]")
        ? matchTaskMarker
        : matchBulletMarker;
  const family = prefix.trimStart().startsWith(">") ? matchQuoteMarker : matchListMarker;

  const removing = targets.every(
    (lineNumber) => specific(state.doc.line(lineNumber).text) !== null
  );
  const edits: LineEdit[] = [];

  targets.forEach((lineNumber, index) => {
    const line = state.doc.line(lineNumber);
    const matcher = removing ? specific : family;
    const match = matcher(line.text);
    const markerLength = match ? match[0].length : 0;

    let insert = "";
    if (!removing) insert = ordered ? `${index + 1}. ` : prefix;

    edits.push({ from: line.from, to: line.from + markerLength, insert });
  });

  return dispatchLineEdits(view, edits);
}

/** Replaces the leading ATX markers of every selected line. `level` 0 is body text. */
export function setHeading(view: EditorView, level: 0 | 1 | 2 | 3 | 4 | 5 | 6): boolean {
  const { state } = view;
  const edits: LineEdit[] = selectedLineNumbers(view).map((lineNumber) => {
    const line = state.doc.line(lineNumber);
    const match = HEADING_PREFIX_RE.exec(line.text);
    const markerLength = match ? match[0].length : 0;
    const insert = level === 0 ? "" : `${"#".repeat(level)} `;
    return { from: line.from, to: line.from + markerLength, insert };
  });

  return dispatchLineEdits(view, edits);
}

/** Replaces every selection with `text` and leaves the caret after it. */
export function insertBlock(view: EditorView, text: string): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => ({
    changes: { from: range.from, to: range.to, insert: text },
    range: EditorSelection.cursor(range.from + text.length),
  }));

  view.dispatch({ ...changes, userEvent: "input.format" });
  return true;
}

/** Inserts an empty GFM table: header row, divider, then `rows` body rows. */
export function insertTable(view: EditorView, rows: number, cols = 3): boolean {
  const width = Math.max(1, Math.trunc(cols));
  const bodyRows = Math.max(0, Math.trunc(rows));
  const cells = Array.from({ length: width }, () => "   ");
  const header = `|${cells.join("|")}|`;
  const divider = `|${cells.map(() => "---").join("|")}|`;
  const body = Array.from({ length: bodyRows }, () => header);
  const block = [header, divider, ...body].join("\n");

  const { state } = view;
  const changes = state.changeByRange((range) => {
    const before = state.sliceDoc(Math.max(0, range.from - 1), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + 1));
    const lead = range.from === 0 || before === "\n" ? "" : "\n\n";
    const trail = after === "" || after === "\n" ? "\n" : "\n\n";
    const insert = `${lead}${block}${trail}`;
    // Caret lands inside the first header cell.
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + lead.length + 2),
    };
  });

  view.dispatch({ ...changes, userEvent: "input.format" });
  return true;
}

/** Inserts a fence pair; the caret lands on the empty line inside it. */
function insertFence(view: EditorView, language = ""): boolean {
  const opening = `\`\`\`${language}`;
  const { state } = view;
  const { from, to } = state.selection.main;
  if (from !== to) return wrapSelection(view, `${opening}\n`, "\n```");

  const changes = state.changeByRange((range) => {
    const insert = `${opening}\n\n\`\`\``;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + opening.length + 1),
    };
  });
  view.dispatch({ ...changes, userEvent: "input.format" });
  return true;
}

/** `$$\n…\n$$` around a selection, or an empty display block with the caret inside. */
function insertBlockMath(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  if (from !== to) return wrapSelection(view, "$$\n", "\n$$");

  const changes = state.changeByRange((range) => {
    const insert = "$$\n\n$$";
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + 3),
    };
  });
  view.dispatch({ ...changes, userEvent: "input.format" });
  return true;
}

function currentLineText(view: EditorView): string {
  const head = view.state.selection.main.head;
  return view.state.doc.lineAt(head).text;
}

function headingLevel(text: string): number {
  const match = HEADING_PREFIX_RE.exec(text);
  return match ? match[1].length : 0;
}

function isTaskLine(text: string): boolean {
  return TASK_PREFIX_RE.test(text);
}

function isBulletLine(text: string): boolean {
  return !isTaskLine(text) && UL_PREFIX_RE.test(text);
}

function isOrderedLine(text: string): boolean {
  return OL_PREFIX_RE.test(text);
}

function isQuoteLine(text: string): boolean {
  return QUOTE_PREFIX_RE.test(text);
}

export interface MdAction {
  id: string;
  label: () => string;
  icon?: LucideIcon;
  shortcut?: string;
  run(view: EditorView): boolean;
  isActive?(view: EditorView): boolean;
}

const HEADING_ICONS = [Heading1, Heading2, Heading3, Heading4, Heading5, Heading6];

function headingAction(level: 1 | 2 | 3 | 4 | 5 | 6): MdAction {
  return {
    id: `h${level}`,
    label: () => `${i18n.t("mdEditor.toolbar.heading")} ${level}`,
    icon: HEADING_ICONS[level - 1],
    shortcut: `Ctrl+${level}`,
    run: (view) => setHeading(view, level),
    isActive: (view) => headingLevel(currentLineText(view)) === level,
  };
}

export const mdActions: MdAction[] = [
  {
    id: "bold",
    label: () => i18n.t("mdEditor.toolbar.bold"),
    icon: Bold,
    shortcut: "Ctrl+B",
    run: (view) => wrapSelection(view, "**"),
  },
  {
    id: "italic",
    label: () => i18n.t("mdEditor.toolbar.italic"),
    icon: Italic,
    shortcut: "Ctrl+I",
    run: (view) => wrapSelection(view, "*"),
  },
  {
    id: "strike",
    label: () => i18n.t("mdEditor.toolbar.strike"),
    icon: Strikethrough,
    run: (view) => wrapSelection(view, "~~"),
  },
  {
    id: "inlineCode",
    label: () => i18n.t("mdEditor.toolbar.code"),
    icon: Code,
    run: (view) => wrapSelection(view, "`"),
  },
  headingAction(1),
  headingAction(2),
  headingAction(3),
  headingAction(4),
  headingAction(5),
  headingAction(6),
  {
    id: "paragraph",
    label: () => i18n.t("mdEditor.toolbar.paragraph"),
    icon: Type,
    run: (view) => setHeading(view, 0),
    isActive: (view) => headingLevel(currentLineText(view)) === 0,
  },
  {
    id: "quote",
    label: () => i18n.t("mdEditor.toolbar.quote"),
    icon: Quote,
    run: (view) => toggleLinePrefix(view, "> "),
    isActive: (view) => isQuoteLine(currentLineText(view)),
  },
  {
    id: "ul",
    label: () => i18n.t("mdEditor.toolbar.ul"),
    icon: List,
    run: (view) => toggleLinePrefix(view, "- "),
    isActive: (view) => isBulletLine(currentLineText(view)),
  },
  {
    id: "ol",
    label: () => i18n.t("mdEditor.toolbar.ol"),
    icon: ListOrdered,
    run: (view) => toggleLinePrefix(view, "1. ", true),
    isActive: (view) => isOrderedLine(currentLineText(view)),
  },
  {
    id: "task",
    label: () => i18n.t("mdEditor.toolbar.task"),
    icon: ListTodo,
    run: (view) => toggleLinePrefix(view, "- [ ] "),
    isActive: (view) => isTaskLine(currentLineText(view)),
  },
  {
    id: "codeBlock",
    label: () => i18n.t("mdEditor.toolbar.codeBlock"),
    icon: SquareCode,
    run: (view) => insertFence(view),
  },
  {
    id: "table",
    label: () => i18n.t("mdEditor.toolbar.table"),
    icon: Table,
    run: (view) => insertTable(view, 3, 3),
  },
  {
    id: "hr",
    label: () => i18n.t("mdEditor.toolbar.hr"),
    icon: Minus,
    run: (view) => insertBlock(view, "\n\n---\n\n"),
  },
  {
    id: "link",
    label: () => i18n.t("mdEditor.toolbar.link"),
    icon: Link2,
    shortcut: "Ctrl+K",
    run: (view) => wrapSelection(view, "[", "](url)"),
  },
  {
    id: "image",
    label: () => i18n.t("mdEditor.toolbar.image"),
    icon: Image,
    run: (view) => wrapSelection(view, "![", "](url)"),
  },
  {
    id: "inlineMath",
    label: () => i18n.t("mdEditor.toolbar.inlineMath"),
    icon: Sigma,
    run: (view) => wrapSelection(view, "$", "$"),
  },
  {
    id: "blockMath",
    label: () => i18n.t("mdEditor.toolbar.blockMath"),
    icon: Sigma,
    run: insertBlockMath,
  },
  {
    id: "mermaid",
    label: () => i18n.t("mdEditor.toolbar.mermaid"),
    icon: Workflow,
    run: (view) => insertFence(view, "mermaid"),
  },
];

export const mdActionsById: ReadonlyMap<string, MdAction> = new Map(
  mdActions.map((action) => [action.id, action])
);

/** Looks actions up by id in the declared order; used to compose menus. */
export function pickActions(...ids: string[]): MdAction[] {
  return ids.map((id) => {
    const action = mdActionsById.get(id);
    if (!action) throw new Error(`Unknown markdown action: ${id}`);
    return action;
  });
}

/**
 * Splits consecutive items that carry the same optional `group` property into
 * rows. Actions do not set one, so the components compose their own groups.
 */
export function group<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  let current: unknown = Symbol("start");

  for (const item of items) {
    const next = (item as { group?: unknown }).group;
    if (rows.length === 0 || next !== current) {
      rows.push([]);
      current = next;
    }
    rows[rows.length - 1].push(item);
  }

  return rows;
}
