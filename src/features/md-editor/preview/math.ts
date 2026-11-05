// KaTeX math extraction and re-insertion.
//
// Math is swapped out for private-use placeholders *before* `marked` runs:
// Markdown would otherwise treat `_`, `*` and `\\` inside a formula as markup.
// `replaceMath` puts the rendered output back once the DOM exists.

import katex from "katex";
import { FENCE_PATTERN, fenceCloser } from "../outline/extract";

/** KaTeX markup flavor; the exports use `mathml` so no KaTeX stylesheet is needed. */
export type MathOutput = "htmlAndMathml" | "mathml";

export interface MathItem {
  tex: string;
  display: boolean;
}

export interface MathExtract {
  text: string;
  items: MathItem[];
}

/** Placeholder delimiters from the Unicode private-use area. */
const OPEN = "\uE000";
const CLOSE = "\uE001";
const PLACEHOLDER_PATTERN = /\uE000(\d+)\uE001/g;

/** A document with more formulas than this keeps the extra ones as plain text. */
const MAX_ITEMS = 2000;

/** `[start, end)` ranges covered by fenced code blocks. */
interface TextRange {
  start: number;
  end: number;
}

interface InlineMatch {
  tex: string;
  end: number;
}

interface BlockMatch {
  tex: string;
  end: number;
  /** Newlines inside the match, re-emitted after the placeholder. */
  newlines: number;
}

/** Replace every `$...$` / `$$...$$` outside code and link targets with a placeholder. */
export function extractMath(source: string): MathExtract {
  const items: MathItem[] = [];
  const ranges = fencedRanges(source);
  const parts: string[] = [];

  let rangeIndex = 0;
  let cursor = 0;

  while (cursor < source.length) {
    const range = ranges[rangeIndex];
    if (range && cursor >= range.end) {
      rangeIndex += 1;
      continue;
    }
    if (range && cursor >= range.start) {
      parts.push(source.slice(cursor, range.end));
      cursor = range.end;
      rangeIndex += 1;
      continue;
    }

    const char = source[cursor];

    if (char === "`") {
      const end = codeSpanEnd(source, cursor);
      if (end > cursor) {
        parts.push(source.slice(cursor, end));
        cursor = end;
        continue;
      }
    }

    if (char === "]" && source[cursor + 1] === "(") {
      const end = linkTargetEnd(source, cursor + 2);
      if (end > cursor) {
        parts.push(source.slice(cursor, end));
        cursor = end;
        continue;
      }
    }

    if (char === "$" && !isEscaped(source, cursor)) {
      if (source[cursor + 1] === "$") {
        const block = readBlockMath(source, cursor);
        if (block) {
          if (items.length >= MAX_ITEMS) {
            parts.push(source.slice(cursor, block.end));
          } else {
            const index = items.length;
            items.push({ tex: block.tex, display: true });
            parts.push(`${OPEN}${index}${CLOSE}${"\n".repeat(block.newlines)}`);
          }
          cursor = block.end;
          continue;
        }
      } else {
        const inline = readInlineMath(source, cursor);
        if (inline) {
          if (items.length >= MAX_ITEMS) {
            parts.push(source.slice(cursor, inline.end));
          } else {
            const index = items.length;
            items.push({ tex: inline.tex, display: false });
            parts.push(`${OPEN}${index}${CLOSE}`);
          }
          cursor = inline.end;
          continue;
        }
      }
    }

    parts.push(char);
    cursor += 1;
  }

  return { text: parts.join(""), items };
}

/** Replace the placeholders in `root` with KaTeX output. */
export function replaceMath(root: Document, items: MathItem[], output: MathOutput): void {
  if (items.length === 0) return;

  const textNodes: Text[] = [];
  const walker = root.createTreeWalker(root.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.nodeValue?.includes(OPEN)) textNodes.push(node);
  }

  for (const node of textNodes) {
    const value = node.nodeValue ?? "";
    const parent = node.parentElement;
    const sole = parent?.tagName === "P" ? solePlaceholder(value) : null;

    if (sole !== null && parent) {
      const item = items[sole];
      if (!item) continue;
      const container = root.createElement("div");
      container.className = "md-math-display";
      container.innerHTML = renderMath(item.tex, item.display, output);
      parent.replaceWith(container);
      continue;
    }

    replaceInline(node, items, output);
  }
}

function replaceInline(node: Text, items: MathItem[], output: MathOutput): void {
  const document = node.ownerDocument;
  const value = node.nodeValue ?? "";
  const fragment = document.createDocumentFragment();
  let last = 0;

  PLACEHOLDER_PATTERN.lastIndex = 0;
  for (
    let match = PLACEHOLDER_PATTERN.exec(value);
    match;
    match = PLACEHOLDER_PATTERN.exec(value)
  ) {
    if (last < match.index) {
      fragment.appendChild(document.createTextNode(value.slice(last, match.index)));
    }

    const item = items[Number(match[1])];
    const holder = document.createElement("span");
    if (item) {
      if (item.display) holder.className = "md-math-display";
      holder.innerHTML = renderMath(item.tex, item.display, output);
    } else {
      holder.textContent = match[0];
    }
    fragment.appendChild(holder);

    last = match.index + match[0].length;
  }

  if (last < value.length) {
    fragment.appendChild(document.createTextNode(value.slice(last)));
  }

  node.replaceWith(fragment);
}

function renderMath(tex: string, display: boolean, output: MathOutput): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      output,
      throwOnError: false,
      trust: false,
      strict: "ignore",
      maxExpand: 1000,
      errorColor: "#cc0000",
    });
  } catch {
    // Not expected with `throwOnError: false`; never inject the raw source as HTML.
    return `<span class="md-math-error">${escapeHtml(tex)}</span>`;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** Index of the placeholder when the paragraph contains nothing else but whitespace. */
function solePlaceholder(value: string): number | null {
  const match = /^\s*\uE000(\d+)\uE001\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

function readInlineMath(source: string, start: number): InlineMatch | null {
  const first = source[start + 1];
  // Currency guard: `$ 5` and `$$` are not openings.
  if (first === undefined || first === "$" || /\s/.test(first)) return null;

  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\n") return null;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "$") {
      const next = source[index + 1];
      // A closing `$` never follows whitespace nor precedes a digit.
      if (!/\s/.test(source[index - 1]) && (next === undefined || !/[0-9]/.test(next))) {
        const tex = source.slice(start + 1, index);
        if (tex.trim() !== "") return { tex, end: index + 1 };
      }
      return null;
    }
    index += 1;
  }

  return null;
}

function readBlockMath(source: string, start: number): BlockMatch | null {
  let index = start + 2;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "$" && source[index + 1] === "$") {
      const tex = source.slice(start + 2, index);
      if (tex.trim() === "") return null;
      return {
        tex,
        end: index + 2,
        newlines: countNewlines(source.slice(start, index + 2)),
      };
    }
    index += 1;
  }

  return null;
}

/** End of the inline code span that starts at `start`, or -1 when it never closes. */
function codeSpanEnd(source: string, start: number): number {
  let runEnd = start;
  while (runEnd < source.length && source[runEnd] === "`") runEnd += 1;
  const ticks = runEnd - start;

  const lineEnd = source.indexOf("\n", runEnd);
  const limit = lineEnd < 0 ? source.length : lineEnd;
  let index = runEnd;

  while (index < limit) {
    if (source[index] !== "`") {
      index += 1;
      continue;
    }
    let end = index;
    while (end < limit && source[end] === "`") end += 1;
    if (end - index === ticks) return end;
    index = end;
  }

  return -1;
}

/** End of the link destination that starts right after `](`; -1 when it never closes. */
function linkTargetEnd(source: string, start: number): number {
  let depth = 1;
  let index = start;

  while (index < source.length) {
    const char = source[index];
    if (char === "\n") return -1;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }

  return -1;
}

function isEscaped(source: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && source[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}

function countNewlines(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") count += 1;
  }
  return count;
}

function fencedRanges(source: string): TextRange[] {
  const ranges: TextRange[] = [];
  const lines = source.split("\n");
  let offset = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const lineStart = offset;
    offset += line.length + 1;
    index += 1;

    const opening = FENCE_PATTERN.exec(line);
    if (!opening) continue;

    const closer = fenceCloser(opening[1][0], opening[1].length);
    let end = lineStart + line.length;

    while (index < lines.length) {
      const next = lines[index];
      const nextStart = offset;
      offset += next.length + 1;
      index += 1;
      end = nextStart + next.length;
      if (closer.test(next)) break;
    }

    ranges.push({ start: lineStart, end: Math.min(end, source.length) });
  }

  return ranges;
}
