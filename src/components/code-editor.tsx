import { useDeferredValue, useMemo, useRef, type KeyboardEvent } from "react";
import hljs from "highlight.js/lib/core";
import { escapeHtml } from "@/lib/git-core/highlight";
import { cn } from "@/lib/utils";

/**
 * Highlighting a file this long would cost more than it is worth, and the
 * deferred value keeps even that off the typing path. Past the cap the editor
 * falls back to plain text and stays usable.
 */
const MAX_HIGHLIGHT_CHARS = 200_000;
const INDENT = "  ";

/**
 * A highlighted text editor: a native textarea for input, with a highlighted
 * copy of the same text painted underneath.
 *
 * The textarea's own text is transparent, so the caret, selection, undo and IME
 * keep working while the colors come from highlight.js. Both layers share one
 * set of typography classes and scroll together, which is what keeps the caret
 * on the glyphs it belongs to. `language` is a highlight.js grammar id; null
 * paints plain text, which is also what an unknown extension gets.
 *
 * The component holds no file state: the host owns the text, the save and the
 * unsaved-changes guard.
 */
export function CodeEditor({
  value,
  language,
  highlight = true,
  onChange,
  onSave,
  ariaLabel = "Editor",
  className,
}: {
  value: string;
  language: string | null;
  highlight?: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
  ariaLabel?: string;
  className?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const painted = useRef<HTMLPreElement>(null);

  // Highlighting runs off the deferred value so a large file cannot lag every
  // keystroke; the caret still moves at typing speed.
  const deferred = useDeferredValue(value);
  const html = useMemo(() => {
    const grammar = highlight && language !== null ? language : null;
    if (grammar === null || deferred.length > MAX_HIGHLIGHT_CHARS) return escapeHtml(deferred);
    try {
      return hljs.highlight(deferred, { language: grammar, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(deferred);
    }
  }, [deferred, highlight, language]);

  const sync = () => {
    const area = input.current;
    const layer = painted.current;
    if (!area || !layer) return;
    layer.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave?.();
      return;
    }
    if (event.key !== "Tab") return;
    // Keep the focus in the editor: a tab is indentation, not a focus change.
    event.preventDefault();
    const area = event.currentTarget;
    area.setRangeText(INDENT, area.selectionStart, area.selectionEnd, "end");
    onChange(area.value);
  };

  return (
    <div className={cn("relative min-h-0 flex-1 overflow-hidden", className)}>
      <pre
        ref={painted}
        aria-hidden
        className="pointer-events-none absolute inset-0 m-0 overflow-hidden p-4 font-mono text-sm leading-6 whitespace-pre"
      >
        <code className="hljs" dangerouslySetInnerHTML={{ __html: `${html}\n` }} />
      </pre>
      <textarea
        ref={input}
        wrap="off"
        spellCheck={false}
        aria-label={ariaLabel}
        className="caret-foreground selection:bg-primary/30 absolute inset-0 resize-none overflow-auto border-0 bg-transparent p-4 font-mono text-sm leading-6 text-transparent outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={keyDown}
        onScroll={sync}
      />
    </div>
  );
}
