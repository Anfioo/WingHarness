import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Copy, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { findDiffMatch, getDiffRows, indexDiff, lineAtOffset, type DiffRow } from "@/lib/svn-core";
import { writeClipboardText } from "@/lib/svn-core/clipboard";
import { cn } from "@/lib/utils";

/**
 * The unified-diff presentation shared by the SVN workspace's history panels.
 *
 * It is presentational on purpose: it takes the diff text a caller already
 * fetched and never calls a command itself. Rows are produced by the ported
 * `getDiffRows` / `indexDiff` helpers (the same ones the reference
 * `DiffViewer.vue` used) and virtualized with `@tanstack/react-virtual`, so a
 * multi-megabyte diff still scrolls. The reference ran indexing in a Web Worker
 * for very large documents; this project has no worker infrastructure, so the
 * index is built on the main thread.
 */

export interface DiffStats {
  added: number;
  removed: number;
}

export interface DiffViewerProps {
  /** The unified diff text (`svn diff` output). */
  diff: string;
  /** Tighter rows, for a host that renders the viewer inline. */
  compact?: boolean;
  className?: string;
  /** Reports added/removed line counts for the current text. */
  onStats?: (stats: DiffStats) => void;
}

const ROW_HEIGHT = 22;
const COMPACT_ROW_HEIGHT = 20;

/** Row background for a change type, keyed by the `DiffRow.className`. */
function rowTone(kind: string): string {
  switch (kind) {
    case "diff-added":
      return "bg-success/10";
    case "diff-removed":
      return "bg-destructive/10";
    case "diff-meta":
      return "bg-muted/60";
    default:
      return "";
  }
}

/** Text tone for a change type. */
function codeTone(kind: string): string {
  switch (kind) {
    case "diff-added":
      return "text-success";
    case "diff-removed":
      return "text-destructive";
    case "diff-meta":
      return "text-muted-foreground font-medium";
    default:
      return "text-foreground";
  }
}

export function DiffViewer({ diff, compact = false, className, onStats }: DiffViewerProps) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const index = useMemo(() => indexDiff(diff), [diff]);
  const [query, setQuery] = useState("");
  const [activeOffset, setActiveOffset] = useState(-1);

  const rowHeight = compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
  const virtualizer = useVirtualizer({
    count: index.offsets.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 20,
  });

  // Every new document resets the search and jumps back to the top.
  useEffect(() => {
    setQuery("");
    setActiveOffset(-1);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [diff]);

  useEffect(() => {
    onStats?.({ added: index.added, removed: index.removed });
  }, [index, onStats]);

  const matchedLine = activeOffset >= 0 ? lineAtOffset(index, activeOffset) : -1;

  const find = useCallback(
    (direction: "next" | "previous", restart = false) => {
      if (!query) return;
      const from = restart
        ? 0
        : activeOffset < 0
          ? direction === "next"
            ? 0
            : diff.length
          : activeOffset + (direction === "next" ? 1 : -1);
      const offset = findDiffMatch(diff, query, from, direction);
      setActiveOffset(offset);
      if (offset >= 0) {
        virtualizer.scrollToIndex(lineAtOffset(index, offset), { align: "center" });
      }
    },
    [query, activeOffset, diff, index, virtualizer]
  );

  const copyAll = useCallback(async () => {
    try {
      await writeClipboardText(diff);
      toast.success(t("svnWorkspace.diff.toast.copied"));
    } catch {
      toast.error(t("svnWorkspace.diff.toast.copyFailed"));
    }
  }, [diff, t]);

  const items = virtualizer.getVirtualItems();
  const first = items.length > 0 ? items[0].index : 0;
  const last = items.length > 0 ? items[items.length - 1].index + 1 : 0;
  // Only the visible slice is materialized; the rest of the document stays as
  // offsets, which is what keeps a huge diff cheap to scroll.
  const rows = getDiffRows(diff, index, first, last);
  const noMatch = query.length > 0 && activeOffset < 0;

  return (
    <section
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
        }
      }}
    >
      <div className="border-border bg-muted/30 flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <div className="relative min-w-0 flex-1">
          <Search className="text-faint pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveOffset(-1);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                find(event.shiftKey ? "previous" : "next");
              } else if (event.key === "Escape") {
                setQuery("");
                setActiveOffset(-1);
              }
            }}
            placeholder={t("svnWorkspace.diff.findText")}
            aria-label={t("svnWorkspace.diff.findText")}
            className="h-7 pl-7 text-xs"
          />
        </div>
        {noMatch ? (
          <span className="text-faint shrink-0 px-1 text-xs" role="status">
            {t("svnWorkspace.diff.noMatch")}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={!query}
          aria-label={t("svnWorkspace.diff.previousMatch")}
          title={t("svnWorkspace.diff.previousMatch")}
          onClick={() => find("previous")}
        >
          <ArrowUp className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={!query}
          aria-label={t("svnWorkspace.diff.nextMatch")}
          title={t("svnWorkspace.diff.nextMatch")}
          onClick={() => find("next")}
        >
          <ArrowDown className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={!diff}
          aria-label={t("svnWorkspace.diff.copyAll")}
          title={t("svnWorkspace.diff.copyAll")}
          onClick={() => void copyAll()}
        >
          <Copy className="size-3" />
        </Button>
      </div>

      <div
        ref={scrollRef}
        role="table"
        aria-label={t("svnWorkspace.diff.title")}
        aria-rowcount={index.offsets.length}
        className="min-h-0 flex-1 overflow-auto font-mono text-xs"
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row: DiffRow | undefined = rows[item.index - first];
            if (!row) return null;
            const isMatch = matchedLine === row.index - 1;
            const local = isMatch ? activeOffset - row.start : -1;
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={row.index}
                className={cn(
                  "absolute left-0 flex w-full items-stretch",
                  rowTone(row.className),
                  isMatch && "ring-primary/40 ring-1 ring-inset"
                )}
                style={{ top: 0, height: item.size, transform: `translateY(${item.start}px)` }}
              >
                <span
                  role="cell"
                  className="text-faint border-border/50 w-12 shrink-0 border-r px-2 text-right select-none"
                >
                  {row.index}
                </span>
                <span
                  role="cell"
                  className={cn(
                    "w-5 shrink-0 text-center select-none",
                    row.className === "diff-added" && "text-success",
                    row.className === "diff-removed" && "text-destructive",
                    row.className === "diff-meta" && "text-muted-foreground"
                  )}
                >
                  {row.marker}
                </span>
                <code
                  role="cell"
                  className={cn("min-w-0 flex-1 px-2 whitespace-pre", codeTone(row.className))}
                >
                  {isMatch && local >= 0 && query ? (
                    <>
                      {row.text.slice(0, local)}
                      <mark className="bg-primary/30 text-foreground rounded-sm">
                        {row.text.slice(local, local + query.length)}
                      </mark>
                      {row.text.slice(local + query.length)}
                    </>
                  ) : (
                    row.text || " "
                  )}
                </code>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default DiffViewer;
