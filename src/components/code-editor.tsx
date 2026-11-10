import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import hljs from "highlight.js/lib/core";
import { Search } from "lucide-react";
import type { TextEncoding } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { escapeHtml } from "@/lib/git-core/highlight";
import { cn } from "@/lib/utils";
import { CompactSelect } from "@/components/compact-select";

/**
 * Highlighting a file this long would cost more than it is worth, and the
 * deferred value keeps even that off the typing path. Past the cap the editor
 * falls back to plain text and stays usable.
 */
const MAX_HIGHLIGHT_CHARS = 200_000;
/**
 * How much text the view fills itself with before it waits for a scroll. Any
 * viewport is full long before this; the cap only matters for text that never
 * grows tall, such as one very long line.
 */
const AUTO_FILL_CHARS = 64 * 1024;
const INDENT = "  ";

/** The encodings a text file can be read and written back with. */
export const TEXT_ENCODINGS: { value: TextEncoding; key: string; fallback: string }[] = [
  { value: "auto", key: "spacePreview.encoding.auto", fallback: "Detect automatically" },
  { value: "utf-8", key: "spacePreview.encoding.utf8", fallback: "UTF-8" },
  { value: "utf-16le", key: "spacePreview.encoding.utf16le", fallback: "UTF-16 LE" },
  { value: "utf-16be", key: "spacePreview.encoding.utf16be", fallback: "UTF-16 BE" },
  { value: "gb18030", key: "spacePreview.encoding.gb18030", fallback: "GB18030" },
  { value: "big5", key: "spacePreview.encoding.big5", fallback: "Big5" },
  { value: "windows-1252", key: "spacePreview.encoding.windows1252", fallback: "Windows-1252" },
  { value: "shift_jis", key: "spacePreview.encoding.shiftJis", fallback: "Shift-JIS" },
];

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
 * unsaved-changes guard. The encoding selector and the find bar are opt-in, so
 * a caller that passes neither gets the plain editor it always had.
 *
 * In read-only mode it doubles as the preview for text files past the foldable
 * threshold: two nodes instead of one per line, and the find bar still works.
 * `onReachEnd` lets that preview append the next page as the reader scrolls.
 */
export function CodeEditor({
  value,
  language,
  highlight = true,
  encoding,
  readOnly = false,
  wrap = false,
  onChange,
  onSave,
  onEncodingChange,
  showFind = false,
  onReachEnd,
  ariaLabel = "Editor",
  className,
}: {
  value: string;
  language: string | null;
  highlight?: boolean;
  /** The encoding the file was read with; `auto` is a display choice only. */
  encoding?: TextEncoding;
  /** Shows the text without allowing edits; selection and the find bar still work. */
  readOnly?: boolean;
  /** Wraps long lines instead of scrolling sideways. */
  wrap?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  /** Supplying this draws the encoding selector and reports its changes. */
  onEncodingChange?: (encoding: TextEncoding) => void;
  /** Enables the in-page find bar on Ctrl/Cmd+F. */
  showFind?: boolean;
  /**
   * Called when the text is scrolled near its end, and again whenever new text
   * still does not fill the view — the page reader's way of loading the next
   * chunk without a button.
   */
  onReachEnd?: () => void;
  ariaLabel?: string;
  className?: string;
}) {
  const { t } = useAppTranslation();
  const input = useRef<HTMLTextAreaElement>(null);
  const painted = useRef<HTMLPreElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Highlighting runs off the deferred value so a large file cannot lag every
  // keystroke; the caret still moves at typing speed.
  const deferred = useDeferredValue(value);
  // Past the cap the painted layer would only echo the same text in one color,
  // so it is dropped and the textarea shows its own glyphs. That keeps a long
  // file — and paging through one — off the escape-and-repaint path entirely.
  const huge = deferred.length > MAX_HIGHLIGHT_CHARS;
  const html = useMemo(() => {
    if (huge) return "";
    const grammar = highlight && language !== null ? language : null;
    if (grammar === null) return escapeHtml(deferred);
    try {
      return hljs.highlight(deferred, { language: grammar, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(deferred);
    }
  }, [deferred, highlight, language, huge]);

  useEffect(() => {
    if (findOpen) findInput.current?.focus();
  }, [findOpen]);

  const sync = () => {
    const area = input.current;
    const layer = painted.current;
    if (!area || !layer) return;
    layer.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
  };

  const reachEnd = useCallback(() => {
    const area = input.current;
    if (!area || !onReachEnd) return;
    if (area.scrollHeight - area.scrollTop - area.clientHeight <= 48) onReachEnd();
  }, [onReachEnd]);

  // Text that does not fill the view cannot be scrolled, so a page that short
  // would stall; ask for the next one right after every change instead. The
  // limit stops a file that is one endless line from reading itself whole
  // without the reader ever scrolling.
  useEffect(() => {
    if (value.length > AUTO_FILL_CHARS) return;
    reachEnd();
  }, [reachEnd, value]);

  const reveal = (offset: number, length: number) => {
    const area = input.current;
    if (!area) return;
    area.setSelectionRange(offset, offset + length);
    area.focus();
    // setSelectionRange moves the caret; this keeps the match midline instead of
    // at the top or bottom edge the caret scroll would land on.
    const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 24;
    const line = value.slice(0, offset).split("\n").length - 1;
    area.scrollTop = Math.max(0, line * lineHeight - area.clientHeight / 2 + lineHeight / 2);
    sync();
  };

  const find = (backwards: boolean) => {
    const area = input.current;
    if (!area || query === "") return;
    const haystack = value.toLowerCase();
    const needle = query.toLowerCase();
    let index: number;
    if (backwards) {
      index = haystack.lastIndexOf(needle, Math.max(0, area.selectionStart - 1));
      if (index === -1) index = haystack.lastIndexOf(needle);
    } else {
      index = haystack.indexOf(needle, area.selectionEnd);
      if (index === -1) index = haystack.indexOf(needle);
    }
    if (index === -1) return;
    reveal(index, needle.length);
  };

  const findKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      find(event.shiftKey);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setFindOpen(false);
      input.current?.focus();
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave?.();
      return;
    }
    if (showFind && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setFindOpen(true);
      return;
    }
    if (event.key === "Escape" && findOpen) {
      setFindOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    if (readOnly) return;
    // Keep the focus in the editor: a tab is indentation, not a focus change.
    event.preventDefault();
    const area = event.currentTarget;
    area.setRangeText(INDENT, area.selectionStart, area.selectionEnd, "end");
    onChange?.(area.value);
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}>
      {onEncodingChange ? (
        <div className="border-border flex h-9 shrink-0 items-center justify-end gap-2 border-b px-2">
          <CompactSelect
            ariaLabel={t("spacePreview.viewer.textEncoding", { defaultValue: "Text encoding" })}
            value={encoding ?? "auto"}
            onChange={(value) => onEncodingChange(value as TextEncoding)}
            options={TEXT_ENCODINGS.map((item) => ({
              value: item.value,
              label: t(item.key, { defaultValue: item.fallback }),
            }))}
          />
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {huge ? null : (
          <pre
            ref={painted}
            aria-hidden
            className={`pointer-events-none absolute inset-0 m-0 overflow-hidden p-4 font-mono text-sm leading-6 ${
              wrap ? "whitespace-pre-wrap" : "whitespace-pre"
            }`}
          >
            <code className="hljs" dangerouslySetInnerHTML={{ __html: `${html}\n` }} />
          </pre>
        )}
        <textarea
          ref={input}
          readOnly={readOnly}
          wrap={wrap ? "soft" : "off"}
          spellCheck={false}
          aria-label={ariaLabel}
          className={cn(
            "caret-foreground selection:bg-primary/30 absolute inset-0 resize-none overflow-auto border-0 bg-transparent p-4 font-mono text-sm leading-6 outline-none",
            huge ? "text-foreground" : "text-transparent"
          )}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={keyDown}
          onScroll={() => {
            sync();
            reachEnd();
          }}
        />
        {findOpen ? (
          <div className="border-border bg-card absolute top-2 right-2 z-10 flex items-center gap-2 rounded-md border px-2 py-1 shadow-sm">
            <Search className="text-muted-foreground size-3.5 shrink-0" />
            <input
              ref={findInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={findKeyDown}
              placeholder={t("spacePreview.editor.find", { defaultValue: "Find" })}
              aria-label={t("spacePreview.editor.find", { defaultValue: "Find" })}
              spellCheck={false}
              className="w-40 bg-transparent text-xs outline-none"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
