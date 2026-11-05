// Markdown → sanitized HTML with heading ids and source-line markers.

import hljs from "highlight.js/lib/core";
import { marked } from "marked";
// Registering the grammars is a side effect; the preview shares the Git diff viewer's set.
import "@/lib/git-core/highlight";
import { sanitizeHtml } from "@/lib/preview/viewers/html";
import { ASSET_ATTR, ASSET_MISSING_ATTR, isRemoteSource, resolveAssetPath } from "./assets";
import { extractMath, replaceMath } from "./math";
import type { MathOutput } from "./math";
import { FENCE_PATTERN, fenceCloser, uniqueHeadingId } from "../outline/extract";

export type { MathOutput } from "./math";

/** Everything the renderer needs besides the source itself. */
export interface RenderOptions {
  /** Absolute path of the document, used to resolve relative images; null for an untitled tab. */
  docPath: string | null;
  /** Defaults to `htmlAndMathml`; exports pass `mathml`, which needs no KaTeX stylesheet. */
  mathOutput?: MathOutput;
}

/** Preview is skipped above these limits; the page shows `mdEditor.preview.tooLarge` instead. */
export const MAX_PREVIEW_BYTES = 500 * 1024;
export const MAX_PREVIEW_LINES = 10_000;

/** Blocks that receive `data-source-line`; nesting is collapsed onto the outermost block. */
const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,ul,ol,blockquote,pre,table,hr,div";
const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";
const LANGUAGE_CLASS = /(?:^|\s)language-([\w+#.-]+)/;

/** Highlighting is capped so a document full of huge code blocks still renders fast. */
const HIGHLIGHT_BUDGET = 200_000;
const HIGHLIGHT_BLOCK_LIMIT = 100_000;

/** True when the document is too large to preview. */
export function isDocumentTooLarge(source: string): boolean {
  if (utf8Size(source) > MAX_PREVIEW_BYTES) return true;
  return countLines(source) > MAX_PREVIEW_LINES;
}

/**
 * Markdown → sanitized HTML.
 *
 * The output is already sanitized, every heading carries an `id` (slug, `-2`/`-3`
 * on duplicates) and outermost blocks carry a 0-based `data-source-line`.
 */
export function renderMarkdown(source: string, options: RenderOptions): string {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  // Math is replaced first: marked would otherwise read `_` and `*` inside a
  // formula as emphasis. The line anchors are computed before the replacement
  // because block formulas collapse their newlines into a placeholder.
  const starts = chunkStartLines(normalized.split("\n"));
  const math = extractMath(normalized);
  const rendered = marked.parse(math.text, { gfm: true, breaks: false, async: false });
  const doc = new DOMParser().parseFromString(rendered, "text/html");

  replaceMath(doc, math.items, options.mathOutput ?? "htmlAndMathml");
  markMermaidBlocks(doc);
  assignHeadingIds(doc);
  assignSourceLines(doc, starts);
  highlightCode(doc);
  rewriteImages(doc, options.docPath);

  return sanitizeHtml(doc.body.innerHTML);
}

function assignHeadingIds(doc: Document): void {
  const seen = new Map<string, number>();
  for (const heading of doc.querySelectorAll(HEADING_SELECTOR)) {
    // KaTeX duplicates its output (visual HTML + MathML); the outline strips
    // `$...$` entirely, so both sides must see the heading without the formula.
    for (const katex of Array.from(heading.querySelectorAll(".katex"))) katex.remove();
    heading.id = uniqueHeadingId(heading.textContent ?? "", seen);
  }
}

/**
 * Line numbers are estimated, not parsed: the source is split into chunks at
 * blank lines (fenced blocks stay whole) and the rendered blocks are aligned to
 * those chunks in document order. The mapping is monotonic, which is what the
 * scroll sync needs.
 */
function assignSourceLines(doc: Document, starts: number[]): void {
  if (starts.length === 0) return;

  let index = 0;
  for (const block of outermostBlocks(doc)) {
    block.setAttribute("data-source-line", String(starts[Math.min(index, starts.length - 1)]));
    index += 1;
  }
}

/** Blocks whose ancestors contain no block of their own; keeps `pre`/`table` whole. */
function outermostBlocks(doc: Document): Element[] {
  return Array.from(doc.body.querySelectorAll(BLOCK_SELECTOR)).filter(
    (element) => element.parentElement?.closest(BLOCK_SELECTOR) === null
  );
}

function chunkStartLines(lines: string[]): number[] {
  const starts: number[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index].trim() === "") {
      index += 1;
      continue;
    }
    const start = index;
    const opening = FENCE_PATTERN.exec(lines[index]);
    if (opening) {
      const closer = fenceCloser(opening[1][0], opening[1].length);
      index += 1;
      while (index < lines.length && !closer.test(lines[index])) index += 1;
      if (index < lines.length) index += 1;
    } else {
      while (index < lines.length && lines[index].trim() !== "") index += 1;
    }
    starts.push(start);
  }

  return starts;
}

/** `mermaid` fences are rendered asynchronously by `diagram.ts`, never highlighted. */
function markMermaidBlocks(doc: Document): void {
  for (const code of doc.querySelectorAll("pre > code")) {
    const match = LANGUAGE_CLASS.exec(code.className);
    if (!match || match[1].toLowerCase() !== "mermaid") continue;
    code.parentElement?.classList.add("md-mermaid");
  }
}

function highlightCode(doc: Document): void {
  let budget = HIGHLIGHT_BUDGET;
  for (const code of doc.querySelectorAll("pre:not(.md-mermaid) > code")) {
    const match = LANGUAGE_CLASS.exec(code.className);
    if (!match) continue;
    const language = match[1];
    if (language.toLowerCase() === "mermaid") continue;
    if (!hljs.getLanguage(language)) continue;
    const text = code.textContent ?? "";
    if (text.length > HIGHLIGHT_BLOCK_LIMIT || text.length > budget) continue;
    try {
      code.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      code.classList.add("hljs");
      budget -= text.length;
    } catch {
      // Keep the block as plain text when the grammar rejects it.
    }
  }
}

/**
 * Local images lose their `src` (a relative one would show a broken icon) and
 * are tagged with the absolute path `assets.ts` reads on mount.
 */
function rewriteImages(doc: Document, docPath: string | null): void {
  for (const image of Array.from(doc.querySelectorAll("img"))) {
    const src = image.getAttribute("src");
    if (!src) {
      image.remove();
      continue;
    }
    if (isRemoteSource(src) || src.startsWith("#")) continue;

    image.removeAttribute("src");
    const absolute = resolveAssetPath(src, docPath);
    image.setAttribute(absolute ? ASSET_ATTR : ASSET_MISSING_ATTR, absolute ?? src);
  }
}

function countLines(source: string): number {
  let lines = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function utf8Size(source: string): number {
  return new TextEncoder().encode(source).length;
}
