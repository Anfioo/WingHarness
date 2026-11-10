import { highlightText, languageOf } from "@/lib/git-core/highlight";

/**
 * Past this many characters the highlight pass costs more than it is worth,
 * and a highlighted document of that size is also a huge DOM. Above the cap
 * the text is rendered as one plain `<pre>` instead.
 */
export const MAX_HIGHLIGHT_CHARS = 400_000;

export interface PreviewText {
  /** Highlighted HTML, or null when the text should be shown unhighlighted. */
  html: string | null;
  /** The grammar the file name resolved to, if any. */
  language: string | null;
}

/**
 * The read-only text view's one decision: highlight with the editor's own
 * grammars, or leave the text plain. Highlighting is one pass over the whole
 * document, never one per line, so the rendered tree stays a single `<code>`.
 */
export function previewText(text: string, name: string): PreviewText {
  const language = languageOf(name);
  if (!language || text.length > MAX_HIGHLIGHT_CHARS) return { html: null, language };
  return { html: highlightText(text, language), language };
}
