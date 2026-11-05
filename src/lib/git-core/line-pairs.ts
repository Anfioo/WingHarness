import type { DiffHunk, DiffLine } from "@/lib/git-core/types";

export interface LinePair {
  left: DiffLine | null;
  right: DiffLine | null;
}

export const PAIR_SIMILARITY = 0.6;
export const PAIR_SCAN_CAP = 4000;

const WORD = /[\p{L}\p{N}_]+/gu;

const wordsOf = (text: string): Set<string> => new Set(text.match(WORD) ?? []);

export function lineSimilarity(a: string, b: string): number {
  const left = wordsOf(a);
  const right = wordsOf(b);
  if (left.size === 0 && right.size === 0) return a.trim() === b.trim() ? 1 : 0;
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

function pairRun(deletions: DiffLine[], additions: DiffLine[], pairs: LinePair[]): void {
  if (deletions.length === 0 || additions.length === 0) {
    for (const del of deletions) pairs.push({ left: del, right: null });
    for (const add of additions) pairs.push({ left: null, right: add });
    return;
  }
  if (deletions.length === 1 && additions.length === 1) {
    pairs.push({ left: deletions[0], right: additions[0] });
    return;
  }
  if (deletions.length * additions.length > PAIR_SCAN_CAP) {
    const n = Math.max(deletions.length, additions.length);
    for (let i = 0; i < n; i++)
      pairs.push({ left: deletions[i] ?? null, right: additions[i] ?? null });
    return;
  }
  let cursor = 0;
  for (const del of deletions) {
    let match = -1;
    for (let j = cursor; j < additions.length; j++) {
      if (lineSimilarity(del.content, additions[j].content) >= PAIR_SIMILARITY) {
        match = j;
        break;
      }
    }
    if (match === -1) {
      pairs.push({ left: del, right: null });
      continue;
    }
    for (let j = cursor; j < match; j++) pairs.push({ left: null, right: additions[j] });
    pairs.push({ left: del, right: additions[match] });
    cursor = match + 1;
  }
  for (let j = cursor; j < additions.length; j++) pairs.push({ left: null, right: additions[j] });
}

export function pairHunkLines(hunk: DiffHunk): LinePair[] {
  const pairs: LinePair[] = [];
  let deletions: DiffLine[] = [];
  let additions: DiffLine[] = [];
  const flush = () => {
    if (deletions.length > 0 || additions.length > 0) pairRun(deletions, additions, pairs);
    deletions = [];
    additions = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "deletion") deletions.push(line);
    else if (line.kind === "addition") additions.push(line);
    else {
      flush();
      pairs.push({ left: line, right: line });
    }
  }
  flush();
  return pairs;
}
