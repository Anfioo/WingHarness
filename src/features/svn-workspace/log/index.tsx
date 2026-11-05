import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  History,
  MessageSquare,
  RotateCcw,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { svnCurrentUser, svnLog } from "@/commands";
import { writeClipboardText } from "@/lib/svn-core/clipboard";
import type { SvnLogEntry } from "@/lib/svn-core/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangePicker } from "@/components/date-picker";
import { EmptyPane } from "@/components/svn-workspace/empty-pane";
import { useSvnWorkspaceStore } from "@/features/svn-workspace/store";
import { useSvnSettings } from "@/features/svn-workspace/settings";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { collectAuthors, formatLogDate, normalizeLogEntries } from "./model";
import { LogDetailDialog } from "./detail-dialog";

/** The reference debounced its filter-triggered reload by this much. */
const FILTER_RELOAD_DELAY_MS = 250;
/** Sentinel for the author select's "no filter" entry (Radix forbids ""). */
const ANY_AUTHOR = "__any__";
/** Page sizes offered in the log footer. */
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

interface LogFilters {
  author: string;
  keyword: string;
  dateFrom: string;
  dateTo: string;
}

const EMPTY_FILTERS: LogFilters = { author: "", keyword: "", dateFrom: "", dateTo: "" };

/**
 * The log panel: a pageable revision list from `svn log`, with the reference's
 * author / keyword / date-range filters, per-revision detail dialog and
 * changed-path actions. Pagination follows the reference's revision cursor: each
 * page asks for one more than it shows (`limit = pageSize + 1`) so the extra row
 * both proves there is a next page and seeds the next page's `startRev`.
 */
export function LogPanel() {
  const { t, language } = useAppTranslation();
  const workspacePath = useSvnWorkspaceStore((state) => state.workspacePath);
  const { settings, updateSettings } = useSvnSettings();
  const pageSize = Math.max(1, settings.logLimit);
  // The stored size may be a custom value the settings page accepted, so keep it
  // selectable rather than letting the trigger fall back to a blank value.
  const pageSizeOptions = useMemo(
    () => Array.from(new Set([...PAGE_SIZE_OPTIONS, pageSize])).sort((a, b) => a - b),
    [pageSize]
  );

  const [logs, setLogs] = useState<SvnLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [filters, setFilters] = useState<LogFilters>(EMPTY_FILTERS);
  const [knownAuthors, setKnownAuthors] = useState<Set<string>>(() => new Set());
  const [currentUser, setCurrentUser] = useState("");
  const [selected, setSelected] = useState<SvnLogEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  /** `cursors[i]` is page `i`'s start revision; page 0 is unbounded (`undefined`). */
  const cursorsRef = useRef<Array<number | undefined>>([undefined]);
  const requestGeneration = useRef(0);
  const authorGeneration = useRef(0);
  const filterTimer = useRef<number | undefined>(undefined);
  const firstFilterRun = useRef(true);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const fetchLogPage = useCallback(
    async (index: number) => {
      const path = workspacePath;
      if (!path) return;
      const generation = ++requestGeneration.current;
      const startRev = cursorsRef.current[index];
      const endRev = startRev === undefined ? undefined : 1;
      const limit = pageSize + 1;
      const { keyword, author, dateFrom, dateTo } = filtersRef.current;

      setLoading(true);
      try {
        const batch = normalizeLogEntries(
          await svnLog(path, {
            limit,
            startRev,
            endRev,
            keyword: keyword.trim() || undefined,
            author: author.trim() || undefined,
            dateFrom: dateFrom || undefined,
            dateTo: dateTo || undefined,
          })
        );
        if (generation !== requestGeneration.current) return;
        if (path !== useSvnWorkspaceStore.getState().workspacePath) return;

        const page = batch.slice(0, pageSize);
        setLogs(page);
        setHasMore(batch.length > pageSize);
        setPageIndex(index);
        if (batch.length > pageSize && page.length > 0) {
          cursorsRef.current[index + 1] = page[page.length - 1].revision - 1;
        }
        setKnownAuthors((prev) => collectAuthors(batch, prev));
        setError(null);
        listRef.current?.scrollTo({ top: 0 });
      } catch (err) {
        if (generation === requestGeneration.current) setError(String(err));
      } finally {
        if (generation === requestGeneration.current) setLoading(false);
      }
    },
    [workspacePath, pageSize]
  );

  const reloadLogs = useCallback(() => {
    cursorsRef.current = [undefined];
    setPageIndex(0);
    setLogs([]);
    setHasMore(false);
    void fetchLogPage(0);
  }, [fetchLogPage]);

  // A new working copy (or a changed page size) starts from the top with the
  // author list rebuilt.
  useEffect(() => {
    requestGeneration.current += 1;
    authorGeneration.current += 1;
    cursorsRef.current = [undefined];
    setLogs([]);
    setHasMore(false);
    setPageIndex(0);
    setError(null);
    setKnownAuthors(new Set());
    setCurrentUser("");
    if (!workspacePath) return;

    reloadLogs();

    const generation = authorGeneration.current;
    void svnCurrentUser(workspacePath)
      .then((user) => {
        if (generation === authorGeneration.current) setCurrentUser(user?.username || "");
      })
      .catch(() => {
        if (generation === authorGeneration.current) setCurrentUser("");
      });
  }, [workspacePath, reloadLogs]);

  // Filters reload after a short idle, as the reference's debounced watch did.
  const filterKey = `${filters.author}|${filters.keyword}|${filters.dateFrom}|${filters.dateTo}`;
  useEffect(() => {
    if (firstFilterRun.current) {
      firstFilterRun.current = false;
      return;
    }
    if (filterTimer.current !== undefined) window.clearTimeout(filterTimer.current);
    filterTimer.current = window.setTimeout(() => {
      filterTimer.current = undefined;
      reloadLogs();
    }, FILTER_RELOAD_DELAY_MS);
    return () => {
      if (filterTimer.current !== undefined) {
        window.clearTimeout(filterTimer.current);
        filterTimer.current = undefined;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  useEffect(
    () => () => {
      if (filterTimer.current !== undefined) window.clearTimeout(filterTimer.current);
    },
    []
  );

  const authorOptions = useMemo(() => {
    const all = new Set(knownAuthors);
    if (currentUser) all.add(currentUser);
    const others = [...all]
      .filter((author) => author && author !== currentUser)
      .sort((a, b) => a.localeCompare(b, language));
    return { self: currentUser, others };
  }, [knownAuthors, currentUser, language]);

  const hasActiveFilters = Boolean(
    filters.author.trim() || filters.keyword.trim() || filters.dateFrom || filters.dateTo
  );

  const changePage = (index: number) => {
    if (loading || index < 0 || index >= cursorsRef.current.length) return;
    void fetchLogPage(index);
  };

  const queryNow = () => {
    if (loading) return;
    if (filterTimer.current !== undefined) {
      window.clearTimeout(filterTimer.current);
      filterTimer.current = undefined;
    }
    reloadLogs();
  };

  const copy = async (value: string, key: string) => {
    try {
      await writeClipboardText(value);
      toast.success(t(key));
    } catch {
      toast.error(t("svnWorkspace.log.toast.copyFailed"));
    }
  };

  const openDetail = (entry: SvnLogEntry) => {
    setSelected(entry);
    setDialogOpen(true);
  };

  const summary = t(
    hasActiveFilters ? "svnWorkspace.log.matchedCount" : "svnWorkspace.log.loadedCount",
    { count: logs.length }
  );

  const showBlockingLoader = loading && logs.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex flex-col gap-2 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={filters.author || ANY_AUTHOR}
            onValueChange={(value) =>
              setFilters((prev) => ({ ...prev, author: value === ANY_AUTHOR ? "" : value }))
            }
          >
            <SelectTrigger
              size="sm"
              className="w-40"
              aria-label={t("svnWorkspace.log.authorPlaceholder")}
            >
              <SelectValue placeholder={t("svnWorkspace.log.authorPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_AUTHOR}>{t("svnWorkspace.common.all")}</SelectItem>
              {authorOptions.self ? (
                <SelectItem value={authorOptions.self}>{authorOptions.self}</SelectItem>
              ) : null}
              {authorOptions.others.map((author) => (
                <SelectItem key={author} value={author}>
                  {author}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search className="text-faint pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={filters.keyword}
              onChange={(event) => setFilters((prev) => ({ ...prev, keyword: event.target.value }))}
              placeholder={t("svnWorkspace.log.keywordPlaceholder")}
              aria-label={t("svnWorkspace.log.keywordPlaceholder")}
              className="h-8 pl-8 text-xs"
            />
          </div>

          <DateRangePicker
            from={filters.dateFrom}
            to={filters.dateTo}
            onChange={({ from, to }) =>
              setFilters((prev) => ({ ...prev, dateFrom: from, dateTo: to }))
            }
            placeholder={t("svnWorkspace.log.dateRangePlaceholder")}
            className="h-8 w-52 text-xs"
          />

          <Button size="sm" className="h-8" disabled={loading} onClick={queryNow}>
            <Search className="size-3.5" />
            {t("svnWorkspace.log.query")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={!hasActiveFilters && !loading}
            onClick={() => setFilters(EMPTY_FILTERS)}
          >
            <RotateCcw className="size-3.5" />
            {t("svnWorkspace.log.reset")}
          </Button>
        </div>

        <div className="text-faint flex items-center gap-2 text-xs">
          <History className="size-3.5" />
          <span aria-live="polite">{summary}</span>
          {hasActiveFilters ? (
            <span className="border-border rounded border px-1.5 py-px">
              {t("svnWorkspace.log.filtered")}
            </span>
          ) : null}
          {loading && logs.length > 0 ? (
            <span className="text-primary">{t("svnWorkspace.common.loading")}</span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-1.5 border-b px-3 py-1 text-xs">
          <span className="truncate" title={error}>
            {t("svnWorkspace.log.error")} {error}
          </span>
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col" aria-busy={loading}>
        {showBlockingLoader ? (
          <EmptyPane loading title={t("svnWorkspace.log.loading")} />
        ) : logs.length > 0 ? (
          <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
            <div className="text-faint bg-muted/30 border-border sticky top-0 z-10 grid grid-cols-[80px_150px_160px_minmax(0,1fr)_56px] border-b px-2 py-1 text-[11px] font-medium tracking-wide uppercase">
              <span>{t("svnWorkspace.log.revision")}</span>
              <span>{t("svnWorkspace.log.author")}</span>
              <span>{t("svnWorkspace.log.date")}</span>
              <span>{t("svnWorkspace.log.message")}</span>
              <span className="text-right">{t("svnWorkspace.log.changedFiles")}</span>
            </div>
            <div>
              {logs.map((entry) => (
                <div
                  key={entry.revision}
                  role="button"
                  tabIndex={0}
                  onClick={() => openDetail(entry)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openDetail(entry);
                    }
                  }}
                  className="hover:bg-muted/50 group border-border/50 grid cursor-pointer grid-cols-[80px_150px_160px_minmax(0,1fr)_56px] items-center border-b px-2 py-1 text-xs"
                >
                  <span className="font-mono font-medium">r{entry.revision}</span>
                  <span className="text-muted-foreground min-w-0 truncate" title={entry.author}>
                    {entry.author || "—"}
                  </span>
                  <span className="text-muted-foreground min-w-0 truncate">
                    {formatLogDate(entry.date, language)}
                  </span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="min-w-0 flex-1 truncate" title={entry.message}>
                      {entry.message || "—"}
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("svnWorkspace.log.detail.copyRevision")}
                        title={t("svnWorkspace.log.detail.copyRevision")}
                        onClick={(event) => {
                          event.stopPropagation();
                          void copy(
                            String(entry.revision),
                            "svnWorkspace.log.toast.revisionCopied"
                          );
                        }}
                      >
                        <Copy className="size-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("svnWorkspace.log.detail.copyMessage")}
                        title={t("svnWorkspace.log.detail.copyMessage")}
                        onClick={(event) => {
                          event.stopPropagation();
                          void copy(entry.message, "svnWorkspace.log.toast.messageCopied");
                        }}
                      >
                        <MessageSquare className="size-3" />
                      </Button>
                    </span>
                  </span>
                  <span className="text-muted-foreground text-right tabular-nums">
                    {entry.changedPaths?.length ?? 0}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <EmptyPane
            icon={History}
            title={
              hasActiveFilters
                ? t("svnWorkspace.log.empty.noMatches")
                : t("svnWorkspace.log.empty.noLogs")
            }
            description={
              hasActiveFilters
                ? t("svnWorkspace.log.empty.noMatchesHint")
                : t("svnWorkspace.log.empty.noLogsHint")
            }
          >
            {hasActiveFilters ? (
              <Button size="sm" variant="outline" onClick={() => setFilters(EMPTY_FILTERS)}>
                <RotateCcw className="size-3.5" />
                {t("svnWorkspace.log.reset")}
              </Button>
            ) : null}
          </EmptyPane>
        )}
      </div>

      <div className="border-border flex shrink-0 items-center justify-between gap-3 border-t px-3 py-1.5">
        <div className="text-faint flex shrink-0 items-center gap-2 text-xs">
          <span>{t("svnWorkspace.log.pageSize")}</span>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => updateSettings({ logLimit: Number(value) })}
          >
            <SelectTrigger
              size="sm"
              className="h-7 w-20 text-xs"
              aria-label={t("svnWorkspace.log.pageSize")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={loading || pageIndex === 0}
            onClick={() => changePage(pageIndex - 1)}
          >
            <ChevronLeft className="size-3.5" />
            {t("svnWorkspace.log.previousPage")}
          </Button>
          <span className="text-faint text-xs">
            {t("svnWorkspace.log.pageNumber", { page: pageIndex + 1 })}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={loading || !hasMore}
            onClick={() => changePage(pageIndex + 1)}
          >
            {t("svnWorkspace.log.nextPage")}
            <ChevronRight className="size-3.5" />
          </Button>
        </div>
      </div>

      <LogDetailDialog entry={selected} open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}

export default LogPanel;
