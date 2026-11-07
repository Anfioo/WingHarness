import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  hasNextSnippetField,
  insertCompletionText,
  nextSnippetField,
  pickedCompletion,
  snippet,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  MSSQL,
  MySQL,
  PostgreSQL,
  SQLite,
  StandardSQL,
  sql,
  type SQLDialect,
} from "@codemirror/lang-sql";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter, type Diagnostic } from "@codemirror/lint";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import type { CompletionModel, DbDriver } from "@/commands";
import { analyze } from "./sql/analyze";
import { shouldAutoCompleteSql, sqlCandidates, type SqlCandidate } from "./sql/complete";
import { formatSql } from "./sql/format";
import { SqlResolver } from "./sql/resolve";

/** The statement to run: the selection, or the one under the caret. */
export type ConsoleEditorHandle = {
  /**
   * The statement(s) in a document range. Pass a negative `from`/`to` to
   * follow the editor's live selection or caret.
   */
  currentStatement(from: number, to: number): string;
  format(): void;
  focus(): void;
};

export type ConsoleEditorProps = {
  value: string;
  onChange(value: string): void;
  model: CompletionModel | null;
  driver: DbDriver;
  onRun(): void;
  onRunAll(): void;
  onExplain(): void;
  onFormat(): void;
  /** The live selection, so the toolbar can tell a caret from a selected range. */
  onSelectionChange?(from: number, to: number): void;
  readOnly?: boolean;
};

/** The props the long-lived extensions read through the `live` ref. */
type LiveProps = Pick<
  ConsoleEditorProps,
  | "value"
  | "model"
  | "driver"
  | "onChange"
  | "onRun"
  | "onRunAll"
  | "onExplain"
  | "onFormat"
  | "onSelectionChange"
  | "readOnly"
>;

/** How long the document must be idle before names are re-checked. */
const LINT_DELAY = 300;

/**
 * The SQL dialect only drives highlighting and indentation; completion comes
 * from the custom source below (D13), never from `lang-sql`'s schema option.
 */
function dialectFor(driver: DbDriver): SQLDialect {
  switch (driver) {
    case "sqlite":
      return SQLite;
    case "postgres":
      return PostgreSQL;
    case "mysql":
      return MySQL;
    case "sqlServer":
      return MSSQL;
    default:
      return StandardSQL;
  }
}

/** Documentation popup of one candidate: the plain text the model carries. */
function docNode(text: string): Node {
  const pre = document.createElement("pre");
  pre.className = "max-w-96 whitespace-pre-wrap p-2 font-mono text-xs";
  pre.textContent = text;
  return pre;
}

/**
 * Applies one candidate. A candidate may replace the label with different
 * text, add a `FROM` clause when it was picked before any table, or open a
 * snippet whose `${}` marks the next caret position.
 */
function applyCandidate(
  candidate: SqlCandidate,
  driver: DbDriver
): (view: EditorView, completion: Completion, from: number, to: number) => void {
  return (view, completion, from, to) => {
    // A selected placeholder is replaced, as CodeMirror's own completions do.
    const selection = view.state.selection.main;
    if (to === selection.from) to = selection.to;

    if (candidate.snippet) {
      snippet(candidate.snippet)(view, completion, from, to);
      return;
    }

    const text = candidate.insert ?? candidate.label;
    if (!candidate.addFrom) {
      view.dispatch({
        ...insertCompletionText(view.state, text, from, to),
        userEvent: "input.complete",
        annotations: pickedCompletion.of(completion),
      });
      if (candidate.retrigger) setTimeout(() => startCompletion(view), 0);
      else if (hasNextSnippetField(view.state)) nextSnippetField(view);
      return;
    }

    const changes: Array<{ from: number; to?: number; insert: string }> = [
      { from, to, insert: text },
    ];
    // Re-read the statement as it is now: the user may have typed since the
    // popup opened.
    const analysis = analyze(view.state.doc.toString(), to, driver);
    if (analysis.fromInsert !== null) {
      const clause = ` ${analysis.lowerKeywords ? "from" : "FROM"} ${candidate.addFrom}`;
      if (analysis.fromInsert <= to) changes[0]!.insert += clause;
      else changes.push({ from: analysis.fromInsert, insert: clause });
    }
    view.dispatch({
      changes,
      selection: { anchor: from + text.length },
      userEvent: "input.complete",
      annotations: pickedCompletion.of(completion),
      scrollIntoView: true,
    });
  };
}

/** Context-aware completion from the analysed statement and the schema model. */
function completionSource(get: () => LiveProps): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const { model, driver } = get();
    const doc = context.state.doc.toString();
    const analysis = analyze(doc, context.pos, driver);
    if (!context.explicit && !shouldAutoCompleteSql(analysis)) return null;
    const candidates = sqlCandidates({ model, analysis, driver });
    if (candidates.length === 0) return null;
    return {
      from: analysis.prefix.from,
      options: candidates.map((candidate) => ({
        label: candidate.label,
        detail: candidate.tail,
        typeText: candidate.type,
        type: candidate.kind,
        boost: Math.max(-99, Math.min(99, candidate.boost)),
        info: candidate.doc ? () => docNode(candidate.doc!) : undefined,
        apply: applyCandidate(candidate, driver),
      })),
      validFor: /^[\p{L}\p{N}_$]*$/u,
    };
  };
}

/** Unresolved table / column / alias names as lint diagnostics. */
function lintSource(get: () => LiveProps) {
  return (view: EditorView): Diagnostic[] => {
    const { model, driver } = get();
    if (!model?.tables.length) return [];
    return new SqlResolver(view.state.doc.toString(), driver, model).problems().map((problem) => ({
      from: problem.from,
      to: problem.to,
      severity: "error" as const,
      message: problem.message,
      source: "SQL",
    }));
  };
}

/** Editor chrome that borrows the app's CSS variables, like the Markdown editor. */
const consoleEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    fontSize: "12px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily:
      "var(--font-mono, ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, monospace)",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { padding: "8px 0" },
  ".cm-line": { padding: "0 10px" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--foreground) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--primary) 24%, transparent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--destructive)",
  },
});

/**
 * A CodeMirror 6 SQL console. The view is created once and owned by a ref —
 * never by React state — and external `value` changes are applied only when
 * they really differ, so typing never moves the caret.
 */
export function ConsoleEditor(
  props: ConsoleEditorProps & { ref?: Ref<ConsoleEditorHandle> }
): ReactNode {
  const {
    ref,
    value,
    onChange,
    model,
    driver,
    onRun,
    onRunAll,
    onExplain,
    onFormat,
    onSelectionChange,
    readOnly = false,
  } = props;

  const parentRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const editability = useRef(new Compartment());
  // The latest render's callbacks and model, read by long-lived extensions.
  const live = useRef<LiveProps>({
    value,
    onChange,
    model,
    driver,
    onRun,
    onRunAll,
    onExplain,
    onFormat,
    onSelectionChange,
    readOnly,
  });
  const initialized = useRef(false);

  useEffect(() => {
    live.current = {
      value,
      onChange,
      model,
      driver,
      onRun,
      onRunAll,
      onExplain,
      onFormat,
      onSelectionChange,
      readOnly,
    };
  });

  useImperativeHandle(
    ref,
    () => ({
      currentStatement(from, to) {
        const view = viewRef.current;
        if (!view) return "";
        const doc = view.state.doc;
        let start = from;
        let end = to;
        if (start < 0 || end < 0) {
          const selection = view.state.selection.main;
          start = selection.from;
          end = selection.to;
        }
        start = Math.max(0, Math.min(start, doc.length));
        end = Math.max(0, Math.min(end, doc.length));
        if (start > end) [start, end] = [end, start];
        if (start === end) {
          return analyze(doc.toString(), start, live.current.driver).statement.text;
        }
        return doc.sliceString(start, end);
      },
      format() {
        const view = viewRef.current;
        if (!view) return;
        const text = view.state.doc.toString();
        const selection = view.state.selection.main;
        const range = selection.empty ? null : { from: selection.from, to: selection.to };
        const edits = formatSql(text, live.current.driver, range);
        if (edits.length > 0) view.dispatch({ changes: edits });
      },
      focus() {
        viewRef.current?.focus();
      },
    }),
    []
  );

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const editable = !(live.current.readOnly ?? false);
    const extensions: Extension[] = [
      history(),
      language.current.of(sql({ dialect: dialectFor(live.current.driver) })),
      autocompletion({ override: [completionSource(() => live.current)] }),
      linter(
        lintSource(() => live.current),
        { delay: LINT_DELAY }
      ),
      keymap.of([
        ...completionKeymap,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      Prec.high(
        keymap.of([
          {
            key: "Shift-Mod-Enter",
            run: () => {
              live.current.onRunAll();
              return true;
            },
          },
          {
            key: "Mod-Enter",
            run: () => {
              live.current.onRun();
              return true;
            },
          },
          {
            key: "Mod-Alt-l",
            run: () => {
              live.current.onFormat();
              return true;
            },
          },
          {
            key: "Alt-Enter",
            run: () => {
              live.current.onExplain();
              return true;
            },
          },
        ])
      ),
      closeBrackets(),
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      editability.current.of([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) live.current.onChange(update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const selection = update.state.selection.main;
          live.current.onSelectionChange?.(selection.from, selection.to);
        }
      }),
      consoleEditorTheme,
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: live.current.value, extensions }),
      parent,
    });
    viewRef.current = view;
    initialized.current = true;

    return () => {
      view.destroy();
      viewRef.current = null;
      initialized.current = false;
    };
    // The view is created once; changes are applied by the effects below.
  }, []);

  // A different driver changes the dialect of the highlighter.
  useEffect(() => {
    if (!initialized.current) return;
    viewRef.current?.dispatch({
      effects: language.current.reconfigure(sql({ dialect: dialectFor(driver) })),
    });
  }, [driver]);

  // A caller can make the console read-only without rebuilding the view.
  useEffect(() => {
    if (!initialized.current) return;
    const editable = !readOnly;
    viewRef.current?.dispatch({
      effects: editability.current.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    });
  }, [readOnly]);

  // The document can also change from outside the editor (history, object
  // tree); applying it only when it differs keeps the caret in place.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={parentRef} className="h-full min-h-0 overflow-hidden" />;
}
