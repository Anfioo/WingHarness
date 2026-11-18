// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as placeholderExtension,
  type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Height floor in pixels; the editor scrolls internally above its ceiling. */
  minHeight?: number;
}

const MAX_HEIGHT = 360;

/**
 * The composer's Markdown source editor.
 *
 * Deliberately independent of the Markdown editor page: it owns its own
 * `EditorView` and never touches the shared view registry or a global shortcut,
 * so an open composer cannot steal focus or commands from the page beside it.
 */
export default function MarkdownEditor({
  value,
  onChange,
  placeholder,
  disabled = false,
  minHeight = 200,
}: MarkdownEditorProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  // The configuration that changes while the view lives: editable/read-only and
  // the placeholder copy. A compartment swaps it without rebuilding the view.
  const configRef = useRef(new Compartment());
  const disabledRef = useRef(disabled);
  const placeholderRef = useRef(placeholder);
  const initialValueRef = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const extensions: Extension[] = [
      markdown(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
      configRef.current.of(configExtensions(disabledRef.current, placeholderRef.current)),
      composerTheme,
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: initialValueRef.current, extensions }),
      parent,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; later changes arrive through the effects below.
  }, []);

  // The document can also change from outside the editor (a new draft, a reset
  // after a failure). Apply it only when it really differs, or every keystroke
  // would move the caret back to the start.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    disabledRef.current = disabled;
    placeholderRef.current = placeholder;
    view.dispatch({
      effects: configRef.current.reconfigure(configExtensions(disabled, placeholder)),
    });
  }, [disabled, placeholder]);

  return (
    <div
      ref={parentRef}
      className="bg-background overflow-hidden rounded-md border"
      style={{ minHeight, maxHeight: MAX_HEIGHT, overflowY: "auto" }}
    />
  );
}

function configExtensions(disabled: boolean, placeholder: string | undefined): Extension[] {
  return [
    EditorState.readOnly.of(disabled),
    EditorView.editable.of(!disabled),
    placeholder ? placeholderExtension(placeholder) : [],
  ];
}

const composerTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "14px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": {
    padding: "8px 12px",
    caretColor: "var(--foreground)",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-placeholder": {
    color: "var(--muted-foreground)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--primary) 24%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--foreground)",
  },
});
