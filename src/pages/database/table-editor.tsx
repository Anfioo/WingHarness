// The data tab of one table: pages of rows sorted and filtered on the server,
// with cell edits, new rows and row deletions collected as a draft and applied
// in one transaction. A table without a primary key cannot identify its rows,
// so it is shown read-only.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Plus,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Sigma,
  SquareCode,
  SquareUser,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import {
  databaseErrorCode,
  dbApplyEdits,
  dbCancel,
  dbScopeOf,
  dbSourceList,
  dbTablePage,
  saveTextFile,
} from "@/commands";
import type { CompletionModel, DataSourceView, DbRowEdit, SortKey, TablePage } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { ColumnsPopup } from "./columns-popup";
import type { DataPanel } from "./data-panel";
import { DataView, type GridMenuItem } from "./data-view";
import { EXPORT_FORMATS, exportData, type ExportData, type ExportFormat } from "./export";
import { FilterInput } from "./filter-input";
import { ImportDialog } from "./import-dialog";
import { pageWindow } from "./result-view";
import type { GridColumn } from "./result-grid";
import {
  addRow,
  applyCell,
  buildRowEdits,
  discard,
  displayRows,
  formatOrderBy,
  hasEdits,
  markDeleted,
  parseOrderBy,
  pendingCount,
  rowState,
  unmarkDeleted,
  type EditTarget,
  type PendingEdits,
} from "./table-editor-model";

export type TableEditorProps = {
  target: string;
  schema: string;
  table: string;
  pageSize: number;
  /** The caller owns the row limit — it is a per-workspace setting. */
  onPageSizeChange: (size: number) => void;
};

/** The page sizes the toolbar offers; the store remembers the last one. */
const PAGE_SIZES = [100, 500, 1000, 5000];

/** A loaded page plus the parameter key it belongs to; a stale key means "loading". */
type LoadedPage = { key: string; page: TablePage | null; error: string | null };

export function TableEditor({
  target,
  schema,
  table,
  pageSize,
  onPageSizeChange,
}: TableEditorProps) {
  const { t } = useAppTranslation();

  const [source, setSource] = useState<DataSourceView | null>(null);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<SortKey[]>([]);
  const [filterText, setFilterText] = useState("");
  const [filter, setFilter] = useState("");
  const [nonce, setNonce] = useState(0);
  const [edits, setEdits] = useState<PendingEdits>(discard);
  const [loaded, setLoaded] = useState<LoadedPage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState<DbRowEdit[] | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [orderDraft, setOrderDraft] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [panel, setPanel] = useState<DataPanel>(null);
  const [importOpen, setImportOpen] = useState(false);

  const describeFailure = useCallback(
    (failure: unknown) => {
      const code = databaseErrorCode(failure);
      if (code) {
        return t(`database.error.${code}`, {
          defaultValue: (failure as { message: string }).message,
        });
      }
      return failure instanceof Error ? failure.message : String(failure);
    },
    [t]
  );

  // The driver decides how identifiers are quoted in the filter completion;
  // the read-only flag of the data source locks editing even with a key.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // A project table pages from the project's own engine.
        const list = await dbSourceList(dbScopeOf(target.split(":")[0]));
        if (!cancelled) setSource(list.find((entry) => entry.id === target.split(":")[0]) ?? null);
      } catch {
        // The driver falls back to SQLite quoting; editing stays enabled.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  // The parameters a page is fetched for. `nonce` re-reads the same page.
  const key = JSON.stringify([target, schema, table, filter, sort, offset, pageSize, nonce]);
  const pageKey = JSON.stringify([target, schema, table, filter, sort, offset, pageSize]);
  // A cancelled request may still answer; only the newest key may hold the page.
  const currentKey = useRef(key);
  currentKey.current = key;

  useEffect(() => {
    const request = crypto.randomUUID();
    let finished = false;
    void (async () => {
      try {
        const page = await dbTablePage(
          request,
          target,
          schema,
          table,
          filter || null,
          sort,
          offset,
          pageSize
        );
        if (currentKey.current === key) setLoaded({ key, page, error: null });
      } catch (failure) {
        if (databaseErrorCode(failure) !== "cancelled" && currentKey.current === key) {
          // The rows of another page must not be shown as this page's data.
          setLoaded({ key, page: null, error: describeFailure(failure) });
        }
      } finally {
        finished = true;
      }
    })();
    return () => {
      // A request the user moved past is not worth finishing.
      if (!finished) void dbCancel(request);
    };
  }, [key, target, schema, table, filter, sort, offset, pageSize, describeFailure]);

  // Another page means another set of rows, so the draft cannot follow it.
  useEffect(() => {
    setEdits(discard());
  }, [pageKey]);

  // Ctrl+F12 is the "go to column" shortcut of every data grid here.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F12" && event.ctrlKey) {
        event.preventDefault();
        setColumnsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const loading = loaded?.key !== key;
  const page = loaded?.page ?? null;
  const error = loaded?.error ?? null;
  const columns = useMemo<GridColumn[]>(
    () => (page?.result.columns ?? []).map((c) => ({ name: c.name, typeName: c.typeName })),
    [page]
  );
  const names = useMemo(() => columns.map((column) => column.name), [columns]);
  const primaryKey = useMemo(
    () => (page?.details.columns ?? []).filter((c) => c.primaryKey).map((c) => c.name),
    [page]
  );
  const editTarget = useMemo<EditTarget>(
    () => ({ columns: names, rows: page?.result.rows ?? [] }),
    [names, page]
  );
  const rows = useMemo(() => displayRows(editTarget, edits), [editTarget, edits]);
  const readOnlySource = source?.readOnly === true;
  const editable = primaryKey.length > 0 && !readOnlySource;
  const dirty = hasEdits(edits);
  const loadedRows = editTarget.rows.length;
  const pager = pageWindow({
    page: Math.floor(offset / pageSize),
    pageSize,
    rows: loadedRows,
    hasMore: page?.result.hasMore ?? false,
    total: null,
  });
  const orderInvalid = orderDraft !== null && parseOrderBy(orderDraft, names) === null;

  // The filter input completes against the table it filters, so the model has
  // the current table first (and, for the editor, only that table matters).
  const completion = useMemo<CompletionModel | null>(() => {
    const details = page?.details.columns;
    if (!details?.length) return null;
    return {
      defaultSchema: schema,
      foreignKeys: [],
      tables: [
        {
          schema,
          name: table,
          kind: "table",
          columns: details.map((c) => ({
            name: c.name,
            dataType: c.dataType,
            nullable: c.nullable,
            primaryKey: c.primaryKey,
            hasDefault: c.default !== null,
          })),
        },
      ],
    };
  }, [page, schema, table]);

  const refresh = () => setNonce((n) => n + 1);

  const changeSort = (column: string, add: boolean) => {
    setSort((current) => {
      const existing = current.find((key) => key.column === column);
      const next = !existing
        ? { column, descending: false }
        : !existing.descending
          ? { column, descending: true }
          : null;
      const rest = add ? current.filter((key) => key.column !== column) : [];
      return next ? [...rest, next] : rest;
    });
    setOffset(0);
    setOrderDraft(null);
  };

  const applyOrderBy = () => {
    if (orderDraft === null) return;
    const next = parseOrderBy(orderDraft, names);
    if (!next) return;
    setSort(next);
    setOffset(0);
    setOrderDraft(null);
  };

  const applyFilter = () => {
    setOffset(0);
    setFilter(filterText.trim());
  };

  const changePageSize = (value: string) => {
    setOffset(0);
    setOrderDraft(null);
    onPageSizeChange(Number(value));
  };

  const changeCell = (row: number, column: number, value: string | null) => {
    if (!editable) return;
    setEdits((current) => applyCell(current, editTarget, row, column, value));
  };

  // Descending order keeps the indices of later new rows stable while earlier
  // ones are dropped.
  const deleteRows = (selected: number[]) =>
    setEdits((current) =>
      [...selected]
        .sort((a, b) => b - a)
        .reduce((next, row) => markDeleted(next, editTarget, row), current)
    );

  const restoreRows = (selected: number[]) =>
    setEdits((current) =>
      selected.reduce((next, row) => (row < loadedRows ? unmarkDeleted(next, row) : next), current)
    );

  const rowMenu = (selected: number[]): GridMenuItem[] => {
    if (!editable) return [];
    const restorable = selected.some((row) => row < loadedRows && edits.deletes.has(String(row)));
    return [
      {
        id: "deleteRows",
        label: t("database.table.deleteRows"),
        destructive: true,
        disabled: selected.length === 0,
        run: () => deleteRows(selected),
      },
      {
        id: "restoreRows",
        label: t("database.table.restoreRows"),
        disabled: !restorable,
        run: () => restoreRows(selected),
      },
    ];
  };

  const submit = () => {
    const requests = buildRowEdits(editTarget.columns, editTarget.rows, primaryKey, edits);
    if (requests.length) setConfirming(requests);
  };

  const apply = async () => {
    if (!confirming) return;
    setSubmitting(true);
    try {
      await dbApplyEdits(target, schema, table, confirming);
      toast.success(t("database.table.submitted"));
      setEdits(discard());
      setConfirming(null);
      refresh();
    } catch (failure) {
      // The backend rolls the whole batch back, so the draft still describes it.
      toast.error(describeFailure(failure));
      setConfirming(null);
    } finally {
      setSubmitting(false);
    }
  };

  const exportAs = async (format: ExportFormat) => {
    if (!page) return;
    const meta = EXPORT_FORMATS.find((entry) => entry.id === format);
    if (!meta) return;
    let path: string | null = null;
    try {
      path = await save({
        defaultPath: `${table}.${meta.extension}`,
        filters: [{ name: t(meta.label), extensions: [meta.extension] }],
      });
    } catch (failure) {
      toast.error(t("database.export.failed", { error: describeFailure(failure) }));
      return;
    }
    if (!path) return;
    const data: ExportData = {
      columns,
      rows: page.result.rows,
      table,
      driver: source?.driver ?? "sqlite",
    };
    try {
      await saveTextFile(path, exportData(format, data));
      toast.success(t("database.export.saved", { name: path.split(/[\\/]/).pop() ?? path }));
    } catch (failure) {
      toast.error(t("database.export.failed", { error: describeFailure(failure) }));
    }
  };

  const imported = (count: number) => {
    setImportOpen(false);
    toast.success(t("database.table.imported", { count }));
    refresh();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("database.table.refresh")}
          title={t("database.table.refresh")}
          disabled={loading}
          onClick={refresh}
        >
          <RotateCw />
        </Button>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("database.grid.prev")}
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
          >
            <ChevronLeft />
          </Button>
          <span className="text-muted-foreground w-20 text-center font-mono text-[11px]">
            {pager.first === 0
              ? "0"
              : `${pager.first}–${pager.last}${page?.result.hasMore ? "+" : ""}`}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("database.grid.next")}
            disabled={!page?.result.hasMore || loading}
            onClick={() => setOffset(offset + pageSize)}
          >
            <ChevronRight />
          </Button>
        </div>

        <Select value={String(pageSize)} onValueChange={changePageSize}>
          <SelectTrigger
            size="sm"
            className="h-7 w-24 text-xs"
            aria-label={t("database.table.pageSize")}
            title={t("database.table.pageSize")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {t("database.table.pageSizeOption", { count: size })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex min-w-48 flex-1 items-center">
          <FilterInput
            value={filterText}
            onChange={setFilterText}
            model={completion}
            driver={source?.driver ?? "sqlite"}
            placeholder={t("database.table.filterPlaceholder")}
            onSubmit={applyFilter}
          />
        </div>

        <Input
          value={orderDraft ?? formatOrderBy(sort)}
          placeholder={t("database.table.orderBy")}
          aria-label={t("database.table.orderBy")}
          aria-invalid={orderInvalid}
          title={orderInvalid ? t("database.table.orderByInvalid") : t("database.table.orderBy")}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            "h-7 w-44 font-mono text-xs",
            orderInvalid && "border-destructive text-destructive"
          )}
          onChange={(event) => setOrderDraft(event.target.value)}
          onBlur={() => {
            if (!orderInvalid) setOrderDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              applyOrderBy();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOrderDraft(null);
            }
          }}
        />

        {loading && <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {editable && dirty && (
            <Badge variant="secondary">
              {t("database.table.changed", { count: pendingCount(edits) })}
            </Badge>
          )}

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("database.table.import")}
            title={t("database.table.import")}
            disabled={!editable}
            onClick={() => setImportOpen(true)}
          >
            <Upload />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("database.table.export")}
                title={t("database.table.export")}
                disabled={!page}
              >
                <Download />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {EXPORT_FORMATS.map((format) => (
                <DropdownMenuItem
                  key={format.id}
                  disabled={!page}
                  onSelect={() => void exportAs(format.id)}
                >
                  {t(format.label)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant={searchOpen ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={t("database.table.search")}
            aria-pressed={searchOpen}
            title={t("database.table.search")}
            onClick={() => setSearchOpen((open) => !open)}
          >
            <Search />
          </Button>

          <PanelButton
            active={panel === "record"}
            label={t("database.panel.record")}
            onClick={() => setPanel(panel === "record" ? null : "record")}
          >
            <SquareUser />
          </PanelButton>
          <PanelButton
            active={panel === "value"}
            label={t("database.panel.value")}
            onClick={() => setPanel(panel === "value" ? null : "value")}
          >
            <SquareCode />
          </PanelButton>
          <PanelButton
            active={panel === "aggregates"}
            label={t("database.panel.aggregates")}
            onClick={() => setPanel(panel === "aggregates" ? null : "aggregates")}
          >
            <Sigma />
          </PanelButton>

          {editable && (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={loading}
                title={t("database.table.addRow")}
                onClick={() => setEdits((current) => addRow(current, editTarget.columns.length))}
              >
                <Plus />
                {t("database.table.addRow")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!dirty || submitting}
                onClick={() => setEdits(discard())}
              >
                <RotateCcw />
                {t("database.table.revert")}
              </Button>
              <Button size="sm" disabled={!dirty || loading || submitting} onClick={submit}>
                <Save />
                {t("database.table.submit")}
              </Button>
            </>
          )}
        </div>
      </div>

      {page && !editable && (
        <p className="text-muted-foreground border-b px-3 py-1.5 text-xs">
          {primaryKey.length === 0
            ? t("database.table.noPrimaryKey")
            : t("database.table.readOnly")}
        </p>
      )}

      {error && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive m-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{error}</span>
        </div>
      )}

      {page ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DataView
            ariaLabel={`${schema}.${table}`}
            columns={columns}
            rows={rows}
            rowCount={rows.length}
            rowState={(row) => rowState(edits, loadedRows, row)}
            isModified={
              editable
                ? (row, column) => edits.updates.get(String(row))?.has(names[column] ?? "") === true
                : undefined
            }
            editable={editable}
            onChange={editable ? changeCell : undefined}
            sort={sort}
            onSort={changeSort}
            firstRowNumber={offset + 1}
            rowMenu={rowMenu}
            panel={panel}
            onPanelChange={setPanel}
            searchOpen={searchOpen}
            onSearchOpenChange={setSearchOpen}
          />
        </div>
      ) : (
        !error && (
          <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t("database.tree.loading")}
          </div>
        )
      )}

      <ColumnsPopup
        columns={columns}
        open={columnsOpen}
        onOpenChange={setColumnsOpen}
        onPick={() => {
          // The grid owns its scroll offset; picking closes the dialog and the
          // grid keeps its selection.
          setColumnsOpen(false);
        }}
      />

      <ImportDialog
        open={importOpen}
        target={target}
        schema={schema}
        table={table}
        columns={names}
        onOpenChange={setImportOpen}
        onImported={imported}
      />

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("database.table.confirmSubmit")}</DialogTitle>
            <DialogDescription>
              {t("database.table.confirmSubmitBody", {
                count: confirming?.length ?? 0,
                table,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={submitting} onClick={() => setConfirming(null)}>
              {t("database.form.cancel")}
            </Button>
            <Button disabled={submitting} onClick={() => void apply()}>
              {submitting ? <Loader2 className="animate-spin" /> : <Save />}
              {t("database.table.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PanelButton(props: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const { active, label, onClick, children } = props;
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="icon-sm"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
