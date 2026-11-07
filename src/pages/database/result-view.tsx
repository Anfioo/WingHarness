import { useEffect, useMemo, useState, type ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import { saveTextFile, type QueryResult } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  EXPORT_FORMATS,
  exportData,
  toCsv,
  toTsv,
  type ExportData,
  type ExportFormat,
} from "./export";
import { NULL_FILTER_PATTERN, ResultGrid, type GridColumn } from "./result-grid";
import { pageWindow, visibleRows, type LocalFilter, type LocalSort } from "./result-view";
import { analyze } from "./sql/analyze";

export type ResultViewProps = {
  result: QueryResult;
  /** Table-editor mode: the caller owns paging and passes it as `paging`. */
  editable?: boolean;
  /** Page request for server-paged results (table editor); omit for the console's client pager. */
  paging?: { page: number; pageSize: number; hasMore: boolean; onPage: (page: number) => void };
};

const PAGE_SIZES = [100, 500, 1000];

/** The table a query reads (target of exported SQL inserts), else a neutral name. */
function exportTable(statement: string): string {
  try {
    return (
      analyze(statement, statement.length, "sqlite").refs.find(
        (ref) => ref.depth === 0 && ref.kind === "table"
      )?.name ?? "result"
    );
  } catch {
    return "result";
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One result set: its toolbar (row count, elapsed time, copy, export), the
 * grid and the pager. Console results sort and filter on the client; a table
 * editor passes `paging` and owns the server round trip.
 *
 * The grid stays read-only here: `ResultViewProps` carries no `onChange` or
 * `onSort`, so the table editor drives `ResultGrid` itself.
 */
export function ResultView(props: ResultViewProps): ReactNode {
  const { result, paging } = props;
  const { t } = useAppTranslation();

  const [sort, setSort] = useState<LocalSort | null>(null);
  const [filter, setFilter] = useState<LocalFilter>(new Map());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(() => Math.max(result.rows.length, 1));

  // Another result set (a re-run, another page) starts without shaping state.
  useEffect(() => {
    setSort(null);
    setFilter(new Map());
    setPage(0);
    setPageSize(Math.max(result.rows.length, 1));
  }, [result]);

  const columns = useMemo<GridColumn[]>(
    () => result.columns.map((column) => ({ name: column.name, typeName: column.typeName })),
    [result.columns]
  );
  const value = useMemo(() => {
    const rows = result.rows;
    return (row: number, col: number) => rows[row]?.[col] ?? null;
  }, [result.rows]);

  const local = !paging;
  const order = useMemo(
    () => (local ? visibleRows(result.rows.length, value, filter, sort) : []),
    [local, result.rows.length, value, filter, sort]
  );

  const size = paging ? Math.max(paging.pageSize, 1) : pageSize;
  const currentPage = paging ? paging.page : page;
  const totalRows = local ? order.length : result.rows.length;
  const offset = currentPage * size;
  const displayed = local
    ? order.slice(offset, offset + size).map((row) => result.rows[row] ?? [])
    : result.rows;
  const hasMore = paging ? paging.hasMore : result.hasMore;
  const windowState = pageWindow({
    page: currentPage,
    pageSize: size,
    rows: displayed.length,
    hasMore,
    total: local && !result.hasMore ? totalRows : null,
  });
  // `count` is a number for i18next; a paged result appends `+` to it.
  const totalCount = windowState.total ?? windowState.last + 1;
  const range = `${windowState.first}-${windowState.last} ${t("database.grid.of", {
    count: totalCount,
  })}${windowState.total === null ? "+" : ""}`;
  const canNext = paging ? paging.hasMore : offset + size < totalRows;
  const lastPage = windowState.lastPage;

  const go = (next: number) => {
    if (paging) paging.onPage(Math.max(0, next));
    else setPage(Math.max(0, next));
  };

  const changeSort = (name: string) => {
    const column = columns.findIndex((entry) => entry.name === name);
    if (column < 0) return;
    setSort((current) =>
      current?.column !== column
        ? { column, descending: false }
        : !current.descending
          ? { ...current, descending: true }
          : null
    );
    setPage(0);
  };

  const filterValue = (name: string, cell: string | null) => {
    const column = columns.findIndex((entry) => entry.name === name);
    const allowed = column >= 0 ? filter.get(column) : undefined;
    return !allowed || allowed.has(cell);
  };

  const changeFilter = (name: string, patterns: Set<string> | null) => {
    const column = columns.findIndex((entry) => entry.name === name);
    if (column < 0) return;
    const next = new Map(filter);
    if (patterns === null) {
      next.delete(column);
    } else {
      next.set(
        column,
        new Set([...patterns].map((pattern) => (pattern === NULL_FILTER_PATTERN ? null : pattern)))
      );
    }
    setFilter(next);
    setPage(0);
  };

  const copyAll = async (format: "tsv" | "csv") => {
    const head = columns.map((column) => column.name);
    try {
      await navigator.clipboard.writeText(
        format === "tsv" ? toTsv(head, result.rows) : toCsv(head, result.rows)
      );
    } catch {
      toast.error(t("database.grid.copyFailed"));
    }
  };

  const exportAs = async (format: ExportFormat) => {
    const meta = EXPORT_FORMATS.find((entry) => entry.id === format);
    if (!meta) return;
    const data: ExportData = {
      columns: result.columns,
      rows: result.rows,
      table: exportTable(result.statement),
      driver: "sqlite",
    };
    let path: string | null = null;
    try {
      path = await save({
        defaultPath: `result.${meta.extension}`,
        filters: [{ name: t(meta.label), extensions: [meta.extension] }],
      });
    } catch (error) {
      toast.error(t("database.export.failed", { error: errorMessage(error) }));
      return;
    }
    if (!path) return;
    try {
      await saveTextFile(path, exportData(format, data));
      toast.success(t("database.export.saved", { name: baseName(path) }));
    } catch (error) {
      toast.error(t("database.export.failed", { error: errorMessage(error) }));
    }
  };

  const sizes = PAGE_SIZES.includes(pageSize)
    ? PAGE_SIZES
    : [...PAGE_SIZES, pageSize].sort((a, b) => a - b);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1 text-xs">
        <span className="text-muted-foreground">
          {t("database.grid.rows", { count: totalRows })}
        </span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-muted-foreground">
          {t("database.window.executionTime", { ms: result.executionMs })}
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          title={t("database.grid.copyTsv")}
          onClick={() => void copyAll("tsv")}
        >
          <Copy className="size-3" />
          {t("database.grid.copyTsv")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          title={t("database.grid.copyCsv")}
          onClick={() => void copyAll("csv")}
        >
          {t("database.grid.copyCsv")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs" title={t("database.export.title")}>
              <Download className="size-3" />
              {t("database.export.title")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {EXPORT_FORMATS.map((format) => (
              <DropdownMenuItem key={format.id} onSelect={() => void exportAs(format.id)}>
                {t(format.label)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {columns.length === 0 ? (
        <div className="text-muted-foreground p-3 text-sm">
          {result.affected !== null
            ? t("database.window.affected", { count: result.affected })
            : t("database.console.resultsEmpty")}
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1">
            <ResultGrid
              columns={columns}
              rows={displayed}
              sort={
                local && sort
                  ? [{ column: columns[sort.column]?.name ?? "", descending: sort.descending }]
                  : undefined
              }
              onSort={local ? changeSort : undefined}
              filter={local ? filterValue : undefined}
              onFilterChange={local ? changeFilter : undefined}
            />
          </div>
          <div className="flex items-center gap-1 border-t px-2 py-1 text-xs">
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("database.grid.first")}
              disabled={currentPage === 0}
              onClick={() => go(0)}
            >
              <ChevronsLeft className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("database.grid.prev")}
              disabled={currentPage === 0}
              onClick={() => go(currentPage - 1)}
            >
              <ChevronLeft className="size-3" />
            </Button>
            <span className="text-muted-foreground px-1 tabular-nums">{range}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("database.grid.next")}
              disabled={!canNext}
              onClick={() => go(currentPage + 1)}
            >
              <ChevronRight className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("database.grid.last")}
              disabled={lastPage === null || currentPage >= lastPage}
              onClick={() => go(lastPage ?? currentPage)}
            >
              <ChevronsRight className="size-3" />
            </Button>
            {!paging && (
              <Select
                value={String(pageSize)}
                onValueChange={(next) => {
                  setPageSize(Number(next));
                  setPage(0);
                }}
              >
                <SelectTrigger size="sm" className="ml-auto h-6 w-20 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sizes.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </>
      )}
    </div>
  );
}
