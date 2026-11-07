// SQL filter input of the table data editor: a `WHERE` fragment with a
// completion popup. Completion reuses the SQL kernel's candidates
// (`sqlCandidates`) against the table the editor is showing, so the list has
// the same order and annotations as the console's.

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CompletionModel, DbDriver } from "@/commands";
import { analyze } from "./sql/analyze";
import { quoteIdent, shouldAutoCompleteSql, sqlCandidates } from "./sql/complete";
import { inLiteral, lex } from "./sql/lexer";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

export type FilterInputProps = {
  value: string;
  onChange(value: string): void;
  /**
   * The completion model. Its first table is the one being filtered: the
   * analysis needs a FROM clause to resolve columns against.
   */
  model: CompletionModel | null;
  driver: DbDriver;
  placeholder?: string;
  /** Enter, when the completion popup is not taking it. */
  onSubmit?(): void;
};

/** What opens and closes a candidate: typing after a clause keyword, or Ctrl+Space. */
const MAX_OPTIONS = 30;

export function FilterInput({
  value,
  onChange,
  model,
  driver,
  placeholder,
  onSubmit,
}: FilterInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // The clause the fragment extends; the analysis is run on the whole statement
  // so the kernel sees a complete SELECT and can resolve the table's columns.
  const table = model?.tables[0] ?? null;
  const prefix = table
    ? `SELECT * FROM ${
        table.schema ? `${quoteIdent(table.schema, driver)}.` : ""
      }${quoteIdent(table.name, driver)} WHERE `
    : "SELECT * FROM t WHERE ";
  const at = Math.min(caret, value.length);

  const analysis = useMemo(
    () => (model ? analyze(prefix + value, prefix.length + at, driver) : null),
    [model, prefix, value, at, driver]
  );

  const typed = analysis?.prefix.text.toLowerCase() ?? "";
  const options = useMemo(() => {
    if (!model || !analysis) return [];
    const seen = new Set<string>();
    return sqlCandidates({ model, analysis, driver, sourceName: "" })
      .filter(
        (candidate) =>
          candidate.kind === "column" ||
          candidate.kind === "keyword" ||
          candidate.kind === "function"
      )
      .filter((candidate) => candidate.label.toLowerCase().startsWith(typed))
      .filter((candidate) => {
        if (seen.has(candidate.label)) return false;
        seen.add(candidate.label);
        return true;
      })
      .slice(0, MAX_OPTIONS);
  }, [model, analysis, driver, typed]);

  const choose = (index: number) => {
    const candidate = options[index];
    if (!candidate || !analysis) return;
    const from = Math.max(0, analysis.prefix.from - prefix.length);
    const insert = candidate.insert ?? candidate.label;
    onChange(value.slice(0, from) + insert + value.slice(at));
    setOpen(false);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(from + insert.length, from + insert.length);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const position = event.currentTarget.selectionStart ?? value.length;

    if (event.ctrlKey && event.key === " ") {
      event.preventDefault();
      setCaret(position);
      setOpen(true);
      setActive(0);
      return;
    }

    if (open && options.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((active + step + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        choose(Math.min(active, options.length - 1));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
    }

    // Close brackets and quotes of a fragment the way the console does.
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const closing: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
      const quote = event.key === "'" || event.key === '"';
      const closer = closing[event.key] ?? (quote ? event.key : undefined);
      const start = event.currentTarget.selectionStart ?? value.length;
      const end = event.currentTarget.selectionEnd ?? start;
      const next = value[start];
      if (
        closer &&
        start === end &&
        (next === undefined || /[\s)\]},;]/.test(next)) &&
        !inLiteral(lex(value, driver), start)
      ) {
        event.preventDefault();
        onChange(value.slice(0, start) + event.key + closer + value.slice(end));
        setCaret(start + 1);
        requestAnimationFrame(() => {
          input.current?.setSelectionRange(start + 1, start + 1);
        });
        setOpen(false);
        return;
      }
    }

    if (event.key === "Enter") {
      setOpen(false);
      onSubmit?.();
    }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Input
        ref={input}
        className="h-7 font-mono text-xs"
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-label={placeholder}
        aria-autocomplete="list"
        aria-expanded={open && options.length > 0}
        onChange={(event) => {
          const next = event.target.value;
          const position = event.target.selectionStart ?? next.length;
          onChange(next);
          setCaret(position);
          setActive(0);
          setOpen(
            !!model &&
              shouldAutoCompleteSql(analyze(prefix + next, prefix.length + position, driver))
          );
        }}
        onClick={(event) => setCaret(event.currentTarget.selectionStart ?? value.length)}
        onFocus={(event) => setCaret(event.currentTarget.selectionStart ?? value.length)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
      />
      {open && options.length > 0 && (
        <ul
          role="listbox"
          aria-label={placeholder}
          className="bg-popover absolute top-full left-0 z-50 mt-1 max-h-64 w-full min-w-56 overflow-auto rounded-md border p-1 shadow-md"
        >
          {options.map((candidate, index) => (
            <li key={`${candidate.kind}:${candidate.label}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                className={cn(
                  "hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs",
                  index === active && "bg-accent"
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <span className="truncate font-mono">{candidate.label}</span>
                <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">
                  {candidate.type ?? candidate.kind}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
