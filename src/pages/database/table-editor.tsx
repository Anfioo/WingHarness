// The data tab of one table: pages of rows sorted and filtered on the server,
// with cell edits, new rows and row deletions collected as a draft and applied
// in one transaction. A table without a primary key cannot identify its rows,
// so it is shown read-only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  RotateCcw,
  RotateCw,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { databaseErrorCode, dbApplyEdits, dbCancel, dbSourceList, dbTablePage } from "@/commands";
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
import { useAppTranslation } from "@/hooks/use-app-translation";
import { ColumnsPopup } from "./columns-popup";
import { FilterInput } from "./filter-input";
import { pageWindow } from "./result-view";
import { ResultGrid, type GridColumn } from "./result-grid";
import {
  addRow,
  applyCell,
  buildRowEdits,
  discard,
  displayRows,
  hasEdits,
  markDeleted,
  pendingCount,
  rowState,
  type EditTarget,
  type PendingEdits,
} from "./table-editor-model";

export type TableEditorProps = { target: string; schema: string; table: string };

/** Rows per page. The server reads one row more to tell whether another page follows. */
const PAGE_SIZE = 500;

/** A loaded page plus the parameter key it belongs to; a stale key means "loading". */
type LoadedPage = { key: string; page: TablePage | null; error: string | null };

export function TableEditor({ target, schema, table }: TableEditorProps) {
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
        const list = await dbSourceList();
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
  const key = JSON.stringify([target, schema, table, filter, sort, offset, nonce]);
  const pageKey = JSON.stringify([target, schema, table, filter, sort, offset]);
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
          PAGE_SIZE
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
  }, [key, target, schema, table, filter, sort, offset, describeFailure]);

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
  const primaryKey = useMemo(
    () => (page?.details.columns ?? []).filter((c) => c.primaryKey).map((c) => c.name),
    [page]
  );
  const editTarget = useMemo<EditTarget>(
    () => ({ columns: columns.map((c) => c.name), rows: page?.result.rows ?? [] }),
    [columns, page]
  );
  const rows = useMemo(() => displayRows(editTarget, edits), [editTarget, edits]);
  const readOnlySource = source?.readOnly === true;
  const editable = primaryKey.length > 0 && !readOnlySource;
  const dirty = hasEdits(edits);
  const loadedRows = editTarget.rows.length;
  const pager = pageWindow({
    page: Math.floor(offset / PAGE_SIZE),
    pageSize: PAGE_SIZE,
    rows: loadedRows,
    hasMore: page?.result.hasMore ?? false,
    total: null,
  });

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

  const changeSort = (column: string) => {
    setSort((current) => {
      const existing = current.find((k) => k.column === column);
      if (!existing) return [{ column, descending: false }];
      return existing.descending ? [] : [{ column, descending: true }];
    });
    setOffset(0);
  };

  const applyFilter = () => {
    setOffset(0);
    setFilter(filterText.trim());
  };

  const changeCell = (row: number, column: number, value: string | null) => {
    if (!editable) return;
    setEdits((current) => applyCell(current, editTarget, row, column, value));
  };

  const deleteRow = (row: number) => {
    setEdits((current) => markDeleted(current, editTarget, row));
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
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
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
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
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            <ChevronRight />
          </Button>
        </div>

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

        {loading && <Loader2 className="text-muted-foreground size-3.5 shrink-0 animate-spin" />}

        <div className="ml-auto flex items-center gap-2">
          {editable && (
            <>
              {dirty && (
                <Badge variant="secondary">
                  {t("database.table.changed", { count: pendingCount(edits) })}
                </Badge>
              )}
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
          <ResultGrid
            columns={columns}
            rows={rows}
            onChange={editable ? changeCell : undefined}
            rowState={(row) => rowState(edits, loadedRows, row)}
            sort={sort}
            onSort={changeSort}
            onRowDeleted={editable ? deleteRow : undefined}
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
