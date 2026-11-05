import { useEffect, useMemo, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import type { DiffLine, FileDiff } from "@/lib/git-core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useUi } from "@/features/git/ui-store";
import { Hint, Kbd } from "./diff-ui";
import type { SearchRange, SearchRanges } from "./diff-shared";
import { flattenDiff, HEADER_H, LINE_H, panControllers } from "./virtual-diff";

interface DiffMatch {
  line: DiffLine;
  start: number;
  end: number;
}

function findMatches(diff: FileDiff, query: string, caseSensitive: boolean): DiffMatch[] {
  if (!query) return [];
  const matches: DiffMatch[] = [];
  const q = caseSensitive ? query : query.toLowerCase();
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const hay = caseSensitive ? line.content : line.content.toLowerCase();
      let idx = hay.indexOf(q);
      while (idx !== -1) {
        matches.push({ line, start: idx, end: idx + query.length });
        idx = hay.indexOf(q, idx + Math.max(query.length, 1));
      }
    }
  }
  return matches;
}

export function scrollDiffToLine(
  el: HTMLElement,
  diff: FileDiff,
  target: DiffLine,
  split: boolean,
  wrap: boolean
): void {
  if (wrap) {
    requestAnimationFrame(() => {
      el.querySelector('[data-search-current="true"]')?.scrollIntoView({ block: "center" });
    });
    return;
  }
  const rows = flattenDiff(diff, split);
  let offset = 0;
  for (const row of rows) {
    const hit =
      row.kind === "line"
        ? row.line === target
        : row.kind === "pair" && (row.left === target || row.right === target);
    if (hit) break;
    offset += row.kind === "header" ? HEADER_H : LINE_H;
  }
  el.scrollTo({ top: Math.max(0, offset - el.clientHeight * 0.35) });
  const revealHorizontally = () => {
    const mark = el.querySelector('[data-search-mark="current"]');
    const pane = mark?.closest("[data-diff-pane]");
    if (!mark || !pane) return;
    const panBy = panControllers.get(pane as HTMLElement);
    if (!panBy) return;
    const paneRect = pane.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    if (markRect.left < paneRect.left + 24 || markRect.right > paneRect.right - 24) {
      panBy(markRect.left - paneRect.left - paneRect.width * 0.3);
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(revealHorizontally));
}

export function useDiffFind(diff: FileDiff | null, scrollRef: React.RefObject<HTMLElement | null>) {
  const { t } = useAppTranslation();
  const diffView = useUi((s) => s.diffView);
  const wrapLines = useUi((s) => s.wrapLines);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(
    () => (diff && open ? findMatches(diff, query, caseSensitive) : []),
    [diff, open, query, caseSensitive]
  );
  const bounded = matches.length > 0 ? current % matches.length : 0;

  useEffect(() => {
    setCurrent(0);
  }, [query, caseSensitive, diff]);

  const search = useMemo<SearchRanges | undefined>(() => {
    if (!open || matches.length === 0) return undefined;
    const map: SearchRanges = new Map();
    matches.forEach((m, i) => {
      const ranges = map.get(m.line) ?? [];
      ranges.push({ start: m.start, end: m.end, current: i === bounded });
      map.set(m.line, ranges);
    });
    return map;
  }, [open, matches, bounded]);

  useEffect(() => {
    if (!open || matches.length === 0 || !diff) return;
    const el = scrollRef.current;
    if (!el) return;
    scrollDiffToLine(el, diff, matches[bounded].line, diffView === "split", wrapLines);
  }, [open, matches, bounded, diff, diffView, wrapLines, scrollRef]);

  useEffect(() => {
    if (!diff) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.select());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [diff]);

  const next = () => matches.length > 0 && setCurrent((c) => (c + 1) % matches.length);
  const prev = () =>
    matches.length > 0 && setCurrent((c) => (c - 1 + matches.length) % matches.length);
  const close = () => setOpen(false);

  const matchCaseLabel = t("gitRepo.diff.search.matchCase");
  const previousLabel = t("gitRepo.diff.search.previous");
  const nextLabel = t("gitRepo.diff.search.next");
  const closeLabel = t("gitRepo.diff.search.close");

  const findBar = open ? (
    <div className="border-border bg-popover shadow-soft absolute top-2 right-6 z-20 flex items-center gap-1 rounded-md border py-1 pr-1 pl-2">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) prev();
            else next();
          }
        }}
        placeholder={t("gitRepo.diff.search.placeholder")}
        autoFocus
        spellCheck={false}
        className="text-foreground placeholder:text-faint w-44 bg-transparent text-xs outline-none"
      />
      <span className="text-muted-foreground shrink-0 px-1 text-[10px] whitespace-nowrap tabular-nums">
        {query
          ? matches.length > 0
            ? t("gitRepo.diff.search.count", { current: bounded + 1, total: matches.length })
            : t("gitRepo.diff.search.noResults")
          : ""}
      </span>
      <Hint label={matchCaseLabel}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={matchCaseLabel}
          className={cn("size-6", caseSensitive && "bg-muted text-primary")}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          <CaseSensitive className="size-3.5" />
        </Button>
      </Hint>
      <Hint label={previousLabel}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={previousLabel}
          className="size-6"
          disabled={matches.length === 0}
          onClick={prev}
        >
          <ChevronUp className="size-3.5" />
        </Button>
      </Hint>
      <Hint label={nextLabel}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={nextLabel}
          className="size-6"
          disabled={matches.length === 0}
          onClick={next}
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </Hint>
      <Hint
        label={
          <span className="flex items-center gap-1">
            {closeLabel} <Kbd>Esc</Kbd>
          </span>
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={closeLabel}
          className="size-6"
          onClick={close}
        >
          <X className="size-3.5" />
        </Button>
      </Hint>
    </div>
  ) : null;

  return { findBar, search };
}

export type { SearchRange, SearchRanges };
