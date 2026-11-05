import { useDeferredValue, useMemo, useRef } from "react";
import hljs from "highlight.js/lib/core";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("yaml", yaml);

export type CodeLanguage = "yaml" | "plaintext";

/** Clash sources are YAML; a file with another extension gets plain text. */
export function languageFor(filename: string): CodeLanguage {
  const name = filename.toLowerCase();
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  return name.includes(".") ? "plaintext" : "yaml";
}

/**
 * A highlighted editor: a native textarea for input, with a highlighted copy
 * of the same text painted underneath. The textarea's own text is transparent,
 * so the caret, selection, undo and IME keep working while the colors come from
 * highlight.js. Both layers share one set of typography classes and scroll
 * together, which is what keeps the caret on the glyphs it belongs to.
 */
export function CodeEditor({
  value,
  language,
  onChange,
}: {
  value: string;
  language: CodeLanguage;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const painted = useRef<HTMLPreElement>(null);

  // Highlighting runs off the deferred value so a large YAML file cannot lag
  // every keystroke; the caret still moves at typing speed.
  const deferred = useDeferredValue(value);
  const html = useMemo(() => {
    if (language === "plaintext") return escapeHtml(deferred);
    try {
      return hljs.highlight(deferred, { language: "yaml", ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(deferred);
    }
  }, [deferred, language]);

  const sync = () => {
    const area = input.current;
    const layer = painted.current;
    if (!area || !layer) return;
    layer.scrollTop = area.scrollTop;
    layer.scrollLeft = area.scrollLeft;
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
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
        aria-label="Editor"
        className="caret-foreground selection:bg-primary/30 absolute inset-0 resize-none overflow-auto border-0 bg-transparent p-4 font-mono text-sm leading-6 text-transparent outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={sync}
      />
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
