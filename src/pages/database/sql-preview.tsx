// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * A read-only SQL preview: line numbers, `@codemirror/lang-sql` syntax colours
 * and the actions of the object dialogs. It is a rendering of a string, not an
 * editor — no CodeMirror instance is created.
 */

import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { syntaxTree } from "@codemirror/language";
import { sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { highlightTree, tags, type Highlighter, type Tag } from "@lezer/highlight";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";

export type SqlPreviewProps = {
  sql: string;
  title?: string;
  busy?: boolean;
  onExecute(): void;
  onOpenInConsole(): void;
  onCancel(): void;
  executeLabel: string;
};

const STYLES: readonly (readonly [Tag, string])[] = [
  [tags.keyword, "text-violet-600 dark:text-violet-400"],
  [tags.comment, "text-muted-foreground italic"],
  [tags.string, "text-emerald-600 dark:text-emerald-400"],
  [tags.number, "text-amber-600 dark:text-amber-400"],
  [tags.bool, "text-amber-600 dark:text-amber-400"],
  [tags.null, "text-amber-600 dark:text-amber-400"],
  [tags.operator, "text-sky-600 dark:text-sky-400"],
  [tags.typeName, "text-teal-600 dark:text-teal-400"],
  [tags.function(tags.variableName), "text-blue-600 dark:text-blue-400"],
  [tags.propertyName, "text-blue-600 dark:text-blue-400"],
  [tags.variableName, "text-foreground"],
  [tags.punctuation, "text-muted-foreground"],
];

const highlighter: Highlighter = {
  style(list) {
    for (const [tag, className] of STYLES) {
      if (list.includes(tag)) return className;
    }
    return null;
  },
};

type Piece = { text: string; className?: string };

function highlight(text: string): Piece[] {
  const pieces: Piece[] = [];
  let offset = 0;
  try {
    const state = EditorState.create({ doc: text, extensions: [sql()] });
    highlightTree(syntaxTree(state), highlighter, (from, to, className) => {
      if (from > offset) pieces.push({ text: text.slice(offset, from) });
      pieces.push({ text: text.slice(from, to), className });
      offset = to;
    });
  } catch {
    // Highlighting is cosmetic: fall back to plain text if the parser refuses.
    return [{ text }];
  }
  if (offset < text.length) pieces.push({ text: text.slice(offset) });
  return pieces;
}

/** Destructive statements get the destructive button, whatever the dialog. */
function isDestructive(text: string): boolean {
  return /^\s*(drop|truncate|delete)\b/i.test(text);
}

export function SqlPreview({
  sql: text,
  title,
  busy = false,
  onExecute,
  onOpenInConsole,
  onCancel,
  executeLabel,
}: SqlPreviewProps) {
  const { t } = useAppTranslation();
  const pieces = useMemo(() => highlight(text), [text]);
  const lines = text.split("\n").length;
  const destructive = isDestructive(text);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {title && <div className="text-muted-foreground text-xs font-medium">{title}</div>}
      <div className="bg-muted/40 flex max-h-[45vh] min-h-24 overflow-auto rounded-md border">
        <div
          aria-hidden
          className="text-muted-foreground shrink-0 border-r px-2 py-2 text-right font-mono text-[11px] leading-5 select-none"
        >
          {Array.from({ length: lines }, (_, index) => (
            <div key={index}>{index + 1}</div>
          ))}
        </div>
        <pre className="flex-1 p-2 font-mono text-xs leading-5" aria-label={title}>
          {pieces.map((piece, index) =>
            piece.className ? (
              <span key={index} className={piece.className}>
                {piece.text}
              </span>
            ) : (
              <span key={index}>{piece.text}</span>
            )
          )}
        </pre>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {t("database.form.cancel")}
        </Button>
        <Button variant="outline" onClick={onOpenInConsole} disabled={busy}>
          {t("database.ddl.openInConsole")}
        </Button>
        <Button
          variant={destructive ? "destructive" : "default"}
          onClick={onExecute}
          disabled={busy || !text.trim()}
        >
          {busy && <Loader2 className="animate-spin" />}
          {executeLabel}
        </Button>
      </div>
    </div>
  );
}
