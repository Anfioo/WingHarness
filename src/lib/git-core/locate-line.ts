import type { DiffLine, FileDiff } from "@/lib/git-core/types";

export interface DiffLineHit {
  line: DiffLine;
  start: number;
  end: number;
}

const MIN_SNIPPET = 3;
const MIN_LINE_FOR_CONTAINS = 12;
const KIND_ORDER: DiffLine["kind"][] = ["addition", "deletion", "context"];

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

export function locateDiffLine(diff: FileDiff, snippet: string): DiffLineHit | null {
  const exact = snippet.trim();
  const needle = squash(snippet);
  if (needle.length < MIN_SNIPPET) return null;
  const lines = diff.hunks.flatMap((h) => h.lines);
  for (const kind of KIND_ORDER) {
    for (const line of lines) {
      if (line.kind !== kind) continue;
      const at = line.content.indexOf(exact);
      if (at >= 0) return { line, start: at, end: at + exact.length };
    }
  }
  for (const kind of KIND_ORDER) {
    for (const line of lines) {
      if (line.kind !== kind) continue;
      const content = squash(line.content);
      if (!content) continue;
      if (
        content.includes(needle) ||
        (content.length >= MIN_LINE_FOR_CONTAINS && needle.includes(content))
      ) {
        return { line, start: 0, end: line.content.length };
      }
    }
  }
  return null;
}
