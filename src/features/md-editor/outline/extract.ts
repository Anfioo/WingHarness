// Heading extraction and the slug rules shared with the preview renderer.

/** One ATX heading found in the source. */
export interface OutlineHeading {
  /** Slug, deduplicated with `-2`/`-3`. Matches the preview's heading ids. */
  id: string;
  /** 1–6. */
  level: number;
  /** Heading text with inline Markdown markers removed. */
  text: string;
  /** 0-based source line. */
  line: number;
}

/** Opening line of a fenced code block, indented by at most three spaces. */
export const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

const ATX_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const CODE_SPAN = /`+([^`]*)`+/g;
const STRIKE = /~~(.+?)~~/g;
const STRONG_STAR = /\*\*(.+?)\*\*/g;
const STRONG_UNDERSCORE = /__(.+?)__/g;
const EMPHASIS_STAR = /\*(.+?)\*/g;
const HTML_TAG = /<[^>]*>/g;

/** Closing fence for a block opened by `marker`, repeated at least `length` times. */
export function fenceCloser(marker: string, length: number): RegExp {
  return new RegExp(`^ {0,3}${marker}{${length},}[ \\t]*$`);
}

/**
 * Slug for one heading: lowercased, whitespace becomes `-`, everything outside
 * letters, digits and `-` is dropped. CJK characters are letters, so they stay.
 * `render.ts` imports this so outline ids and preview heading ids never diverge.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "");
  return slug || "section";
}

/** Slug carrying the `-2`, `-3`… suffix that keeps it unique in one document. */
export function uniqueHeadingId(text: string, seen: Map<string, number>): string {
  const base = slugify(text);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function stripInlineMarkdown(text: string): string {
  return (
    text
      // Formulas contribute no text: the renderer drops the KaTeX nodes before
      // reading the heading, so the preview id and this slug must agree.
      .replace(/\$\$[\s\S]*?\$\$/g, "")
      .replace(/(?<!\\)\$[^$\n]+\$/g, "")
      // An image contributes no text content to the rendered heading, so it must not
      // contribute its alt text here either; otherwise the two ids diverge.
      .replace(IMAGE, "")
      .replace(LINK, "$1")
      .replace(CODE_SPAN, "$1")
      .replace(STRIKE, "$1")
      .replace(STRONG_STAR, "$1")
      .replace(STRONG_UNDERSCORE, "$1")
      .replace(EMPHASIS_STAR, "$1")
      .replace(HTML_TAG, "")
      .trim()
  );
}

/**
 * Extract ATX headings in source order, skipping fenced code blocks. A heading
 * indented by four spaces is code, not a heading, so it never matches.
 */
export function extractHeadings(source: string): OutlineHeading[] {
  const lines = source.split(/\r?\n/);
  const headings: OutlineHeading[] = [];
  const seen = new Map<string, number>();
  let fence: { marker: string; closer: RegExp } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (fence.closer.test(line)) fence = null;
      continue;
    }
    const opening = FENCE_PATTERN.exec(line);
    if (opening) {
      fence = { marker: opening[1][0], closer: fenceCloser(opening[1][0], opening[1].length) };
      continue;
    }
    const match = ATX_HEADING.exec(line);
    if (!match) continue;
    const text = stripInlineMarkdown(match[2]);
    if (!text) continue;
    headings.push({
      id: uniqueHeadingId(text, seen),
      level: match[1].length,
      text,
      line: index,
    });
  }

  return headings;
}
