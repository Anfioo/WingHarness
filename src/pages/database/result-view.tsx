// One result set: its toolbar (row count, elapsed time, search, panel, rerun,
// copy, export) and the grid with its pager. The loaded page is a window into
// the query, so paging and counting ask the server again.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Sigma,
  SquareCode,
  SquareUser,
} from "lucide-react";
import { toast } from "sonner";
import {
  databaseErrorCode,
  dbSourceList,
  saveTextFile,
  type DbDriver,
  type QueryResult,
} from "@/commands";
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
import i18n from "@/i18n";
import type { DataPanel } from "./data-panel";
import { DataView } from "./data-view";
import {
  EXPORT_FORMATS,
  exportData,
  toCsv,
  toTsv,
  type ExportData,
  type ExportFormat,
} from "./export";
import { countResult, loadResultPage } from "./result-actions";
import type { GridColumn } from "./result-grid";
import { pageWindow } from "./result-view";
import { analyze } from "./sql/analyze";
import { findParams } from "./sql/params";
import type { ResultTab } from "./store";

export type ResultViewProps = {
  tabKey: string;
  tab: ResultTab;
  sourceId: string;
  target: string;
  onRerun(): void;
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

function columnsOf(result: QueryResult): GridColumn[] {
  return result.columns.map((column) => ({ name: column.name, typeName: column.typeName }));
}

async function copyAll(result: QueryResult, format: "tsv" | "csv"): Promise<void> {
  try {
    const head = result.columns.map((column) => column.name);
    await navigator.clipboard.writeText(
      format === "tsv" ? toTsv(head, result.rows) : toCsv(head, result.rows)
    );
  } catch {
    toast.error(i18n.t("database.grid.copyFailed"));
  }
}

async function saveExport(data: ExportData, format: ExportFormat): Promise<void> {
  const meta = EXPORT_FORMATS.find((entry) => entry.id === format);
  if (!meta) return;
  let path: string | null = null;
  try {
    path = await save({
      defaultPath: `result.${meta.extension}`,
      filters: [{ name: i18n.t(meta.label), extensions: [meta.extension] }],
    });
  } catch (error) {
    toast.error(i18n.t("database.export.failed", { error: errorMessage(error) }));
    return;
  }
  if (!path) return;
  try {
    await saveTextFile(path, exportData(format, data));
    toast.success(i18n.t("database.export.saved", { name: baseName(path) }));
  } catch (error) {
    toast.error(i18n.t("database.export.failed", { error: errorMessage(error) }));
  }
}

export function ResultView(props: ResultViewProps): ReactNode {
  return <TabResultView {...props} />;
}

function TabResultView(props: {
  tabKey: string;
  tab: ResultTab;
  sourceId: string;
  target: string;
  onRerun(): void;
}): ReactNode {
  const { tabKey, tab, sourceId, target, onRerun } = props;
  const { t } = useAppTranslation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [panel, setPanel] = useState<DataPanel>(null);
  const [driver, setDriver] = useState<DbDriver>("sqlite");

  // The dialect only matters for the export quoting and for reading parameters;
  // the neutral driver is a safe fallback when the list cannot be read.
  useEffect(() => {
    let live = true;
    dbSourceList()
      .then((sources) => {
        if (!live) return;
        const found = sources.find((source) => source.id === sourceId)?.driver;
        if (found) setDriver(found);
      })
      .catch(() => {
        // Keep the fallback.
      });
    return () => {
      live = false;
    };
  }, [sourceId]);

  const result = tab.outcome?.result ?? null;
  const failure = tab.outcome?.error ?? null;
  const columns = useMemo<GridColumn[]>(() => (result ? columnsOf(result) : []), [result]);

  const params = useMemo(() => {
    try {
      return findParams(tab.statement.text, driver);
    } catch {
      return [];
    }
  }, [tab.statement.text, driver]);
  const countBlocked = params.length > 0;

  const windowState = pageWindow({
    page: tab.page,
    pageSize: tab.pageSize,
    rows: result?.rows.length ?? 0,
    hasMore: result?.hasMore ?? false,
    total: tab.total,
  });
  const known = tab.total ?? windowState.total;
  const range = `${windowState.first}-${windowState.last} ${t("database.grid.of", {
    count: known ?? windowState.last + 1,
  })}${known === null ? "+" : ""}`;
  const canNext =
    !tab.busy &&
    (tab.total !== null ? (tab.page + 1) * tab.pageSize < tab.total : (result?.hasMore ?? false));

  const go = (page: number) => {
    if (tab.busy) return;
    void loadResultPage(tabKey, tab.id, Math.max(0, page), tab.pageSize);
  };

  const sizes = PAGE_SIZES.includes(tab.pageSize)
    ? PAGE_SIZES
    : [...PAGE_SIZES, tab.pageSize].sort((a, b) => a - b);

  const togglePanel = (next: DataPanel) => setPanel((current) => (current === next ? null : next));

  const code = failure ? databaseErrorCode(failure) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1 text-xs">
        <span className="text-muted-foreground">
          {t("database.grid.rows", { count: result?.rows.length ?? 0 })}
        </span>
        <span className="text-muted-foreground/60">·</span>
        <span className="text-muted-foreground">
          {t("database.window.executionTime", { ms: result?.executionMs ?? 0 })}
        </span>
        <span className="flex-1" />
        <Button
          variant={searchOpen ? "secondary" : "ghost"}
          size="icon-xs"
          aria-pressed={searchOpen}
          aria-label={t("database.result.find")}
          title={t("database.result.find")}
          onClick={() => setSearchOpen((open) => !open)}
        >
          <Search />
        </Button>
        <Button
          variant={panel === "record" ? "secondary" : "ghost"}
          size="icon-xs"
          aria-pressed={panel === "record"}
          aria-label={t("database.panel.record")}
          title={t("database.panel.record")}
          onClick={() => togglePanel("record")}
        >
          <SquareUser />
        </Button>
        <Button
          variant={panel === "value" ? "secondary" : "ghost"}
          size="icon-xs"
          aria-pressed={panel === "value"}
          aria-label={t("database.panel.value")}
          title={t("database.panel.value")}
          onClick={() => togglePanel("value")}
        >
          <SquareCode />
        </Button>
        <Button
          variant={panel === "aggregates" ? "secondary" : "ghost"}
          size="icon-xs"
          aria-pressed={panel === "aggregates"}
          aria-label={t("database.panel.aggregates")}
          title={t("database.panel.aggregates")}
          onClick={() => togglePanel("aggregates")}
        >
          <Sigma />
        </Button>
        <span className="text-muted-foreground/60">·</span>
        <Button
          variant="ghost"
          size="xs"
          disabled={tab.busy}
          title={t("database.result.rerun")}
          onClick={onRerun}
        >
          {tab.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("database.result.rerun")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!result}
          title={t("database.grid.copyTsv")}
          onClick={() => result && void copyAll(result, "tsv")}
        >
          <Copy />
          {t("database.grid.copyTsv")}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!result}
          title={t("database.grid.copyCsv")}
          onClick={() => result && void copyAll(result, "csv")}
        >
          {t("database.grid.copyCsv")}
        </Button>
        <ExportMenu
          data={
            result
              ? {
                  columns: result.columns,
                  rows: result.rows,
                  table: exportTable(result.statement),
                  driver,
                }
              : null
          }
        />
      </div>

      {failure ? (
        <div className="border-destructive/40 bg-destructive/5 text-destructive m-3 rounded-md border px-3 py-2 text-xs break-words whitespace-pre-wrap">
          {code ? t(`database.error.${code}`, { defaultValue: failure.message }) : failure.message}
        </div>
      ) : !result ? (
        <p className="text-muted-foreground p-3 text-xs">{t("database.console.resultsEmpty")}</p>
      ) : columns.length === 0 ? (
        <p className="text-muted-foreground p-3 text-sm">
          {result.affected !== null
            ? t("database.window.affected", { count: result.affected })
            : t("database.console.resultsEmpty")}
        </p>
      ) : (
        <>
          <div className="min-h-0 flex-1">
            <DataView
              columns={columns}
              rows={result.rows}
              rowCount={result.rows.length}
              panel={panel}
              onPanelChange={setPanel}
              searchOpen={searchOpen}
              onSearchOpenChange={setSearchOpen}
              ariaLabel={target}
            />
          </div>
          <div className="flex items-center gap-1 border-t px-2 py-1 text-xs">
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("database.grid.first")}
              disabled={tab.busy || tab.page === 0}
              onClick={() => go(0)}
            >
              <ChevronsLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("database.grid.prev")}
              disabled={tab.busy || tab.page === 0}
              onClick={() => go(tab.page - 1)}
            >
              <ChevronLeft />
            </Button>
            <span className="text-muted-foreground px-1 tabular-nums">{range}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("database.grid.next")}
              disabled={!canNext}
              onClick={() => go(tab.page + 1)}
            >
              <ChevronRight />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("database.grid.last")}
              disabled={
                tab.busy || windowState.lastPage === null || tab.page >= windowState.lastPage
              }
              onClick={() => go(windowState.lastPage ?? tab.page)}
            >
              <ChevronsRight />
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="ml-1"
              disabled={tab.busy || countBlocked}
              title={countBlocked ? t("database.result.countParams") : t("database.result.count")}
              onClick={() => void countResult(tabKey, tab.id)}
            >
              {tab.busy ? t("database.result.counting") : t("database.result.count")}
            </Button>
            <Select
              value={String(tab.pageSize)}
              onValueChange={(next) => {
                if (tab.busy) return;
                void loadResultPage(tabKey, tab.id, 0, Number(next));
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
          </div>
        </>
      )}
    </div>
  );
}

function ExportMenu({ data }: { data: ExportData | null }): ReactNode {
  const { t } = useAppTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" disabled={!data} title={t("database.export.title")}>
          <Download />
          {t("database.export.title")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {EXPORT_FORMATS.map((format) => (
          <DropdownMenuItem
            key={format.id}
            disabled={!data}
            onSelect={() => data && void saveExport(data, format.id)}
          >
            {t(format.label)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
