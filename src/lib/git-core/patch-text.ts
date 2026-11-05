import type { DiffLine, FileDiff } from "@/lib/git-core/types";

const LINE_PREFIX: Record<DiffLine["kind"], string> = {
  addition: "+",
  deletion: "-",
  context: " ",
};

export function patchTextOf(diff: FileDiff): string {
  const header = `--- ${diff.oldPath ?? diff.path}\n+++ ${diff.path}`;
  const hunks = diff.hunks.map((hunk) =>
    [hunk.header, ...hunk.lines.map((line) => `${LINE_PREFIX[line.kind]}${line.content}`)].join(
      "\n"
    )
  );
  return [header, ...hunks].join("\n");
}

export function patchTextOfAll(diffs: FileDiff[]): string {
  return diffs.map(patchTextOf).join("\n\n");
}

export function hasReviewableText(diff: FileDiff | null): diff is FileDiff {
  return (
    !!diff && !diff.isBinary && !diff.isImage && diff.hunks.some((hunk) => hunk.lines.length > 0)
  );
}
