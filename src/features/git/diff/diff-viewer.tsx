import { useMemo } from "react";
import { FileText, ImageOff } from "lucide-react";
import { imageMimeFor, type DiffHunk, type DiffLine, type FileDiff } from "@/lib/git-core";
import { cn } from "@/lib/utils";
import { PaneEmpty } from "@/pages/git-repo/pane-empty";
import { useUi } from "@/features/git/ui-store";
import { languageOf } from "@/lib/git-core/highlight";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  CodeLine,
  gutter,
  lineBg,
  pairHunkLines,
  prepareLineStates,
  wrapUnavailable,
  type SearchRanges,
} from "./diff-shared";
import {
  flattenDiff,
  VirtualInlineDiff,
  VirtualSplitDiff,
  type LineMenuInfo,
} from "./virtual-diff";

interface HunkProps {
  hunk: DiffHunk;
  language: string | null;
  useWordDiff: boolean;
  actions?: React.ReactNode;
  search?: SearchRanges;
  wrap?: boolean;
}

function searchTint(line: DiffLine | null, search?: SearchRanges): React.CSSProperties | undefined {
  const ranges = line ? search?.get(line) : undefined;
  if (!ranges || ranges.length === 0) return undefined;
  const current = ranges.some((range) => range.current);
  return { backgroundColor: `hsl(var(--primary) / ${current ? 0.28 : 0.14})` };
}

function isCurrent(line: DiffLine | null, search?: SearchRanges): true | undefined {
  return line && search?.get(line)?.some((range) => range.current) ? true : undefined;
}

function HunkHeader({ hunk, actions }: { hunk: DiffHunk; actions?: React.ReactNode }) {
  if (!hunk.header) return null;
  return (
    <div className="border-border bg-muted/60 sticky left-0 flex items-center gap-2 border-y px-3 py-1">
      <span className="text-info min-w-0 flex-1 truncate font-mono text-[10px]">{hunk.header}</span>
      {actions}
    </div>
  );
}

function WrappedInlineHunk({
  hunk,
  language,
  useWordDiff,
  actions,
  search,
  wrap = true,
}: HunkProps) {
  const pairs = useMemo(() => pairHunkLines(hunk), [hunk]);
  const counterpart = useMemo(() => {
    const map = new Map<DiffLine, DiffLine>();
    for (const pair of pairs) {
      if (pair.left && pair.right && pair.left !== pair.right) {
        map.set(pair.left, pair.right);
        map.set(pair.right, pair.left);
      }
    }
    return map;
  }, [pairs]);

  return (
    <div>
      <HunkHeader hunk={hunk} actions={actions} />
      {hunk.lines.map((line, i) => (
        <div
          key={i}
          className={cn("flex", lineBg(line.kind))}
          style={searchTint(line, search)}
          data-search-current={isCurrent(line, search)}
        >
          <span className="border-border text-faint w-10 shrink-0 border-r pr-1.5 text-right font-mono text-[10px] leading-5 select-none">
            {gutter(line.oldLineNo)}
          </span>
          <span className="border-border text-faint w-10 shrink-0 border-r pr-1.5 text-right font-mono text-[10px] leading-5 select-none">
            {gutter(line.newLineNo)}
          </span>
          <span
            className={cn(
              "w-5 shrink-0 text-center font-mono text-xs leading-5 select-none",
              line.kind === "addition" && "text-success",
              line.kind === "deletion" && "text-destructive"
            )}
          >
            {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : ""}
          </span>
          <div className="min-w-0 flex-1 px-1">
            <CodeLine
              line={line}
              pair={counterpart.get(line)}
              language={language}
              useWordDiff={useWordDiff}
              side={line.kind === "deletion" ? "old" : "new"}
              wrap={wrap}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function WrappedSplitHunk({ hunk, language, useWordDiff, actions, search }: HunkProps) {
  const pairs = useMemo(() => pairHunkLines(hunk), [hunk]);
  return (
    <div>
      <HunkHeader hunk={hunk} actions={actions} />
      {pairs.map((pair, i) => (
        <div key={i} className="flex">
          <div
            className={cn(
              "border-border flex w-1/2 border-r",
              pair.left
                ? lineBg(pair.left.kind === "context" ? "context" : "deletion")
                : "bg-muted/40"
            )}
            style={searchTint(pair.left, search)}
            data-search-current={isCurrent(pair.left, search)}
          >
            <span className="border-border text-faint w-10 shrink-0 border-r pr-1.5 text-right font-mono text-[10px] leading-5 select-none">
              {pair.left ? gutter(pair.left.oldLineNo) : ""}
            </span>
            <div className="min-w-0 flex-1 px-1.5">
              {pair.left ? (
                <CodeLine
                  line={pair.left}
                  pair={pair.left.kind !== "context" ? pair.right : null}
                  language={language}
                  useWordDiff={useWordDiff}
                  side="old"
                  wrap
                />
              ) : (
                <span data-diff-blank aria-hidden className="text-transparent">
                  {"​"}
                </span>
              )}
            </div>
          </div>
          <div
            className={cn(
              "flex w-1/2",
              pair.right
                ? lineBg(pair.right.kind === "context" ? "context" : "addition")
                : "bg-muted/40"
            )}
            style={searchTint(pair.right, search)}
            data-search-current={isCurrent(pair.right, search)}
          >
            <span className="border-border text-faint w-10 shrink-0 border-r pr-1.5 text-right font-mono text-[10px] leading-5 select-none">
              {pair.right ? gutter(pair.right.newLineNo) : ""}
            </span>
            <div className="min-w-0 flex-1 px-1.5">
              {pair.right ? (
                <CodeLine
                  line={pair.right}
                  pair={pair.right.kind !== "context" ? pair.left : null}
                  language={language}
                  useWordDiff={useWordDiff}
                  side="new"
                  wrap
                />
              ) : (
                <span data-diff-blank aria-hidden className="text-transparent">
                  {"​"}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ImageDiff({ diff }: { diff: FileDiff }) {
  const { t } = useAppTranslation();
  const oldSrc = diff.oldImage;
  const newSrc = diff.newImage;
  if (!oldSrc && !newSrc) {
    return (
      <PaneEmpty
        icon={<ImageOff />}
        title={t("gitRepo.diff.image.unavailableTitle")}
        hint={t("gitRepo.diff.image.unavailableHint")}
      />
    );
  }
  const mime = imageMimeFor(diff.path) ?? "application/octet-stream";
  const src = (data: string) => `data:${mime};base64,${data}`;
  return (
    <div className="flex gap-4 p-4">
      <figure className="border-destructive/40 bg-card flex-1 rounded-lg border p-3 text-center">
        <img
          className="mx-auto max-h-72 max-w-full"
          src={oldSrc ? src(oldSrc) : ""}
          alt={t("gitRepo.diff.image.before")}
        />
        <figcaption className="text-destructive mt-2 text-[11px] font-medium">
          {t("gitRepo.diff.image.before")}
        </figcaption>
      </figure>
      <figure className="border-success/40 bg-card flex-1 rounded-lg border p-3 text-center">
        <img
          className="mx-auto max-h-72 max-w-full"
          src={newSrc ? src(newSrc) : ""}
          alt={t("gitRepo.diff.image.after")}
        />
        <figcaption className="text-success mt-2 text-[11px] font-medium">
          {t("gitRepo.diff.image.after")}
        </figcaption>
      </figure>
    </div>
  );
}

export function DiffViewer({
  diff,
  scrollRef,
  hunkActions,
  onLineContextMenu,
  search,
  stacked = false,
}: {
  diff: FileDiff;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  hunkActions?: (hunkIndex: number) => React.ReactNode;
  onLineContextMenu?: (event: React.MouseEvent, info: LineMenuInfo) => void;
  search?: SearchRanges;
  stacked?: boolean;
}) {
  const { t } = useAppTranslation();
  const diffView = useUi((s) => s.diffView);
  const useWord = useUi((s) => s.wordDiff);
  const wrapLines = useUi((s) => s.wrapLines);
  const language = useMemo(() => languageOf(diff.path), [diff.path]);
  prepareLineStates(diff, language);

  const split = diffView === "split";
  const wrap = stacked ? wrapLines || split : wrapLines && !wrapUnavailable(diff);
  const flatRows = useMemo(
    () => (!wrap && scrollRef && !stacked ? flattenDiff(diff, split) : []),
    [diff, split, wrap, scrollRef, stacked]
  );

  if (diff.isImage) return <ImageDiff diff={diff} />;
  if (diff.isBinary) {
    return (
      <PaneEmpty
        icon={<FileText />}
        title={t("gitRepo.diff.viewer.binaryTitle")}
        hint={t("gitRepo.diff.viewer.binaryHint")}
      />
    );
  }
  if (diff.hunks.length === 0) {
    return (
      <PaneEmpty
        icon={<FileText />}
        title={t("gitRepo.diff.viewer.noChangesTitle")}
        hint={t("gitRepo.diff.viewer.noChangesHint")}
      />
    );
  }

  if (!wrap && scrollRef && !stacked) {
    const props = {
      rows: flatRows,
      language,
      useWordDiff: useWord,
      scrollRef,
      hunkActions,
      onLineContextMenu,
      search,
    };
    return split ? <VirtualSplitDiff {...props} /> : <VirtualInlineDiff {...props} />;
  }

  return (
    <div className={cn(!wrap && "min-w-max")}>
      {diff.hunks.map((hunk, i) => {
        const props: HunkProps = {
          hunk,
          language,
          useWordDiff: useWord,
          actions: hunkActions?.(i),
          search,
        };
        return split ? (
          <WrappedSplitHunk key={i} {...props} />
        ) : (
          <WrappedInlineHunk key={i} {...props} />
        );
      })}
    </div>
  );
}
