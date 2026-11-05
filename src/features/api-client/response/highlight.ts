/**
 * Minimal highlight.js setup for the response body. Only JSON and XML grammars
 * are registered so the response pane does not pull in the full language bundle
 * that the git diff viewer needs.
 *
 * `hljs.highlight` escapes its own output, so the returned markup is safe to
 * pass to `dangerouslySetInnerHTML`; the escape fallback keeps that true when
 * highlighting throws.
 */
import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";

hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);

/** The body grammars the response pane highlights. */
export type BodyLanguage = "json" | "xml";

/** Highlight `code` as `language`; fall back to escaped plain text on error. */
export function highlight(code: string, language: BodyLanguage): string {
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/** Escape the HTML-significant characters so text can be injected as innerHTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
