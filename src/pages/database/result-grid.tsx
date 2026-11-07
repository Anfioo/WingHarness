import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Filter } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { cellPreview } from "./cell-preview";
import type { GridMenuItem } from "./data-view";
import { toCsv, toTsv } from "./export";
import { compareCells, isNumericColumn, type Cell } from "./result-view";

export type GridColumn = { name: string; typeName: string };
export type GridRange = { r0: number; c0: number; r1: number; c1: number };
export type ResultGridProps = {
  columns: GridColumn[];
  rows: (string | null)[][];
  /** Editable cells (table editor). Omit for a read-only grid. */
  onChange?: (row: number, column: number, value: string | null) => void;
  /** Row overlays: unchanged | updated | inserted | deleted. */
  rowState?: (row: number) => "unchanged" | "updated" | "inserted" | "deleted";
  /** A cell changed but not yet committed (table editor). */
  isModified?: (row: number, column: number) => boolean;
  /** Sort keys shown on the header; clicking a header calls `onSort` (`add`: the user held Shift). */
  sort?: { column: string; descending: boolean }[];
  onSort?: (column: string, add: boolean) => void;
  /** Text filter per column, shown in a popover. */
  filter?: (column: string, value: string | null) => boolean;
  onFilterChange?: (column: string, patterns: Set<string> | null) => void;
  onRowDeleted?: (row: number) => void;
  /** Extra context-menu entries for the selected rows, after the built-in ones. */
  rowMenu?: (rows: number[]) => GridMenuItem[];
  /** Search hits, and the one currently stepped to. */
  isMatch?: (row: number, column: number) => boolean;
  currentMatch?: { row: number; col: number } | null;
  /** Ctrl+F / F3 inside the grid. */
  onFind?: () => void;
  /** The selection changed (`null`: nothing selected). */
  onSelectionChange?: (range: GridRange | null) => void;
  /** The number shown in a row's header; the grid's position in the whole result by default. */
  rowNumber?: (row: number) => number;
  /** Rows the column filter lists its values from, when `rows` is already shaped. */
  filterRows?: (string | null)[][];
  ariaLabel?: string;
};

const ROW_H = 28;
const HEADER_H = 28;
const ROW_NUMBER_WIDTH = 48;
const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 360;
const SAMPLE_ROWS = 50;
const FILTER_VALUE_LIMIT = 500;

/**
 * A column filter's pattern set is a `Set<string>`, so SQL NULL travels as
 * this sentinel; the caller maps it back to `null`.
 */
export const NULL_FILTER_PATTERN = "\u0000null";

function normalized(range: GridRange) {
  return {
    top: Math.min(range.r0, range.r1),
    bottom: Math.max(range.r0, range.r1),
    left: Math.min(range.c0, range.c1),
    right: Math.max(range.c0, range.c1),
  };
}

function measureWidths(columns: GridColumn[], rows: (string | null)[][]): number[] {
  return columns.map((column, index) => {
    const header = column.name.length * 8 + 36;
    const longest =
      Math.max(
        0,
        ...rows.slice(0, SAMPLE_ROWS).map((row) => Math.min((row[index] ?? "NULL").length, 60))
      ) *
        7.5 +
      20;
    return Math.max(80, Math.min(MAX_COLUMN_WIDTH, Math.max(header, longest)));
  });
}

function measureNumeric(columns: GridColumn[], rows: (string | null)[][]): boolean[] {
  return columns.map((column, index) =>
    isNumericColumn(
      column.typeName,
      rows.slice(0, SAMPLE_ROWS).map((row) => row[index] ?? null)
    )
  );
}

/** SQLite renders whole REALs as `3108.0`; IDEA shows `3108`. */
function displayed(value: string, numeric: boolean): string {
  return numeric && /^-?\d+\.0$/.test(value) ? value.slice(0, -2) : value;
}

/** A cell's text on one line: line breaks show as a muted arrow. */
function cellText(value: string, numeric: boolean): string {
  return cellPreview(displayed(value, numeric)).replace(/\r\n|\r|\n/g, " ↵ ");
}

/**
 * A pasted block as a rectangle of cells. Tabs win over commas, so Excel and
 * a spreadsheet's CSV both land right; without either the text is one cell.
 * Quotes protect a delimiter or a line break, as in RFC 4180.
 */
export function parseBlock(text: string): Cell[][] {
  const clean = text.replace(/\r\n?/g, "\n");
  const delimiter = clean.includes("\t") ? "\t" : clean.includes(",") ? "," : null;
  if (!delimiter) return [[clean.endsWith("\n") ? clean.slice(0, -1) : clean]];
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (clean[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  rows.push(row);
  // A trailing newline ends the last row instead of adding an empty one.
  if (clean.endsWith("\n")) rows.pop();
  return rows;
}

/**
 * The result grid: virtualised rows, resizable columns, rectangular cell
 * selection (click, shift-click, arrows, Ctrl+A), copy as TSV / CSV, NULL
 * rendering, sortable headers, a per-column local filter and in-place editing
 * when `onChange` is given.
 *
 * Pure display: it never reorders or rewrites `rows`; sorting, filtering and
 * edits go up through the callbacks. While a cell is being edited its row is
 * forced into the virtual range, so scrolling or a re-render cannot unmount
 * the input and lose an IME composition (plan R7).
 */
export function ResultGrid(props: ResultGridProps) {
  const {
    columns,
    rows,
    onChange,
    rowState,
    isModified,
    sort,
    onSort,
    filter,
    onFilterChange,
    onRowDeleted,
    rowMenu,
    isMatch,
    currentMatch,
    onFind,
    onSelectionChange,
    rowNumber,
    filterRows,
    ariaLabel,
  } = props;
  const { t } = useAppTranslation();

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [selection, setSelection] = useState<GridRange | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: number; text: string } | null>(null);
  const [multiEdit, setMultiEdit] = useState<{ row: number; col: number; text: string } | null>(
    null
  );
  const [preview, setPreview] = useState<{ row: number; col: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: number; col: number } | null>(null);

  const columnKey = useMemo(
    () => columns.map((column) => `${column.name}\u0000${column.typeName}`).join("\u0001"),
    [columns]
  );
  const [widths, setWidths] = useState<number[]>(() => measureWidths(columns, rows));
  const [numeric, setNumeric] = useState<boolean[]>(() => measureNumeric(columns, rows));

  useEffect(() => {
    setWidths(measureWidths(columns, rows));
    setNumeric(measureNumeric(columns, rows));
    setSelection(null);
    setEditing(null);
    // Re-measure only when the column set changes; the rows are sampled once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnKey]);

  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  const editingRow = editing?.row ?? null;
  const rangeExtractor = useCallback(
    (range: Range) => {
      const items = defaultRangeExtractor(range);
      if (editingRow !== null && editingRow < rows.length && !items.includes(editingRow)) {
        items.push(editingRow);
        items.sort((a, b) => a - b);
      }
      return items;
    },
    [editingRow, rows.length]
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    rangeExtractor,
  });

  const box = selection ? normalized(selection) : null;
  const isSelected = (row: number, col: number) =>
    box !== null && row >= box.top && row <= box.bottom && col >= box.left && col <= box.right;
  const menuRows = box
    ? Array.from({ length: box.bottom - box.top + 1 }, (_, index) => box.top + index)
    : menu
      ? [menu.row]
      : [];

  // The side panel follows the selection; the parent owns the range it renders.
  useEffect(() => {
    onSelectionChange?.(selection);
  }, [onSelectionChange, selection]);

  // Another page or a filtered row set can shrink the grid under the selection.
  useEffect(() => {
    setSelection((current) => {
      if (!current) return current;
      const fits =
        rows.length > 0 &&
        columns.length > 0 &&
        current.r0 < rows.length &&
        current.r1 < rows.length &&
        current.c0 < columns.length &&
        current.c1 < columns.length;
      return fits ? current : null;
    });
  }, [columns.length, rows.length]);

  const matchRow = currentMatch?.row ?? null;
  const matchCol = currentMatch?.col ?? null;
  useEffect(() => {
    if (matchRow === null || matchCol === null || matchRow >= rows.length) return;
    virtualizer.scrollToIndex(matchRow, { align: "auto" });
    const element = scrollRef.current;
    if (!element) return;
    const left =
      ROW_NUMBER_WIDTH + widths.slice(0, matchCol).reduce((sum, width) => sum + width, 0);
    const right = left + (widths[matchCol] ?? 0);
    if (left < element.scrollLeft) element.scrollLeft = left;
    else if (right > element.scrollLeft + element.clientWidth)
      element.scrollLeft = right - element.clientWidth;
    // Scrolling follows the current hit only; the virtualizer is a fresh object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchRow, matchCol]);

  const writeClipboard = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      toast.error(t("database.grid.copyFailed"));
      return false;
    }
  };

  const copySelection = (format: "tsv" | "csv", header: boolean) => {
    if (!box) return;
    const cols = Array.from({ length: box.right - box.left + 1 }, (_, i) => box.left + i);
    const body: Cell[][] = [];
    for (let row = box.top; row <= box.bottom; row++)
      body.push(cols.map((col) => rows[row]?.[col] ?? null));
    const head = header ? cols.map((col) => columns[col]?.name ?? "") : null;
    void writeClipboard(format === "tsv" ? toTsv(head, body) : toCsv(head, body));
  };

  /** Copies whole rows: every column of the rows the selection covers. */
  const copyRows = (format: "tsv" | "csv", header: boolean) => {
    if (!box) return;
    const body: Cell[][] = [];
    for (let row = box.top; row <= box.bottom; row++)
      body.push(columns.map((_, col) => rows[row]?.[col] ?? null));
    const head = header ? columns.map((column) => column.name) : null;
    void writeClipboard(format === "tsv" ? toTsv(head, body) : toCsv(head, body)).then((ok) => {
      if (ok) toast.success(t("database.result.copied"));
    });
  };

  /**
   * Writes a pasted block from the active cell on. The part that does not fit
   * the grid is dropped rather than failing the whole paste.
   */
  const pasteBlock = async () => {
    if (!onChange || !selection) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast.error(t("database.result.pasteFailed"));
      return;
    }
    const block = parseBlock(text);
    let written = 0;
    let total = 0;
    for (let r = 0; r < block.length; r++) {
      for (let c = 0; c < block[r]!.length; c++) {
        total++;
        const row = selection.r1 + r;
        const col = selection.c1 + c;
        if (row >= rows.length || col >= columns.length) continue;
        if (rowState?.(row) === "deleted") continue;
        onChange(row, col, block[r]![c]!);
        written++;
      }
    }
    if (written < total) {
      toast.warning(
        t("database.result.pastePartial", {
          written,
          total,
        })
      );
    }
  };

  const commitEdit = () => {
    if (editing && onChange) {
      const previous = rows[editing.row]?.[editing.col] ?? null;
      const text = editing.text;
      if (text !== (previous ?? "") || (previous === null && text !== "")) {
        onChange(editing.row, editing.col, text);
      }
    }
    setEditing(null);
    scrollRef.current?.focus({ preventScroll: true });
  };

  const startEdit = (row: number, col: number) => {
    if (!onChange || rowState?.(row) === "deleted") return;
    setEditing({ row, col, text: rows[row]?.[col] ?? "" });
  };

  const scrollColumnIntoView = (col: number) => {
    const element = scrollRef.current;
    if (!element) return;
    const left = ROW_NUMBER_WIDTH + widths.slice(0, col).reduce((sum, width) => sum + width, 0);
    const right = left + (widths[col] ?? 0);
    if (left < element.scrollLeft) element.scrollLeft = left;
    else if (right > element.scrollLeft + element.clientWidth)
      element.scrollLeft = right - element.clientWidth;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if ((mod && key === "f") || event.key === "F3") {
      event.preventDefault();
      onFind?.();
      return;
    }
    if (mod && key === "c") {
      event.preventDefault();
      copySelection(event.shiftKey ? "csv" : "tsv", false);
      return;
    }
    if (mod && key === "v" && onChange) {
      event.preventDefault();
      void pasteBlock();
      return;
    }
    if (mod && key === "a") {
      event.preventDefault();
      if (rows.length && columns.length) {
        setSelection({ r0: 0, c0: 0, r1: rows.length - 1, c1: columns.length - 1 });
      }
      return;
    }
    if (!selection) return;
    if (event.key === "Enter" && event.shiftKey && onChange) {
      const cell = { row: selection.r1, col: selection.c1 };
      event.preventDefault();
      setMultiEdit({ ...cell, text: rows[cell.row]?.[cell.col] ?? "" });
      return;
    }
    if ((event.key === "Enter" || event.key === "F2") && onChange) {
      event.preventDefault();
      startEdit(selection.r1, selection.c1);
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const row = Math.max(0, Math.min(rows.length - 1, selection.r1 + move[0]));
    const col = Math.max(0, Math.min(columns.length - 1, selection.c1 + move[1]));
    setSelection(
      event.shiftKey ? { ...selection, r1: row, c1: col } : { r0: row, c0: col, r1: row, c1: col }
    );
    virtualizer.scrollToIndex(row, { align: "auto" });
    scrollColumnIntoView(col);
  };

  const selectCell = (row: number, col: number, extend: boolean) => {
    setSelection(
      extend && selection
        ? { ...selection, r1: row, c1: col }
        : { r0: row, c0: col, r1: row, c1: col }
    );
  };

  const onCellMouseDown = (event: ReactMouseEvent, row: number, col: number) => {
    if (event.button !== 0) {
      if (!isSelected(row, col)) selectCell(row, col, false);
      return;
    }
    if (editing) commitEdit();
    event.preventDefault();
    scrollRef.current?.focus({ preventScroll: true });
    dragging.current = true;
    selectCell(row, col, event.shiftKey);
  };

  const startResize = (event: ReactMouseEvent, col: number) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const start = widths[col] ?? 120;
    const move = (moveEvent: globalThis.MouseEvent) => {
      if (!(moveEvent.buttons & 1)) {
        up();
        return;
      }
      setWidths((current) =>
        current.map((width, index) =>
          index === col ? Math.max(MIN_COLUMN_WIDTH, start + moveEvent.clientX - startX) : width
        )
      );
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const openContextMenu = (event: ReactMouseEvent, row: number, col: number) => {
    event.preventDefault();
    setMenu({
      x: Math.min(event.clientX, Math.max(0, window.innerWidth - 200)),
      y: Math.min(event.clientY, Math.max(0, window.innerHeight - 180)),
      row,
      col,
    });
  };

  const setSelectionNull = () => {
    if (!onChange || !box) return;
    for (let row = box.top; row <= box.bottom; row++) {
      for (let col = box.left; col <= box.right; col++) onChange(row, col, null);
    }
  };

  const totalWidth = ROW_NUMBER_WIDTH + widths.reduce((sum, width) => sum + width, 0);
  const template = `${ROW_NUMBER_WIDTH}px ${widths.map((width) => `${width}px`).join(" ")}`;
  const selectedValue = preview ? (rows[preview.row]?.[preview.col] ?? null) : null;

  return (
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-rowcount={rows.length}
      aria-colcount={columns.length}
      className="bg-background relative h-full overflow-auto outline-none"
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="relative"
        style={{ width: totalWidth, height: virtualizer.getTotalSize() + HEADER_H }}
      >
        <div
          role="row"
          className="bg-muted/50 sticky top-0 z-20 grid"
          style={{ width: totalWidth, height: HEADER_H, gridTemplateColumns: template }}
        >
          <div className="bg-muted/50 border-r border-b" aria-hidden="true" />
          {columns.map((column, col) => {
            const sorted = sort?.find((key) => key.column === column.name);
            return (
              <div
                key={`${column.name}\u0000${col}`}
                role="columnheader"
                title={`${column.name}: ${column.typeName}`}
                onClick={onSort ? (event) => onSort(column.name, event.shiftKey) : undefined}
                className={cn(
                  "bg-muted/50 relative flex h-full min-w-0 items-center gap-1 border-r border-b px-2 text-xs font-medium select-none",
                  onSort && "hover:bg-accent cursor-pointer"
                )}
              >
                <span className="truncate">{column.name}</span>
                {sorted &&
                  (sorted.descending ? (
                    <ArrowDown className="size-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <ArrowUp className="size-3 shrink-0" aria-hidden="true" />
                  ))}
                {onFilterChange && (
                  <ColumnFilter
                    column={column}
                    columnIndex={col}
                    rows={filterRows ?? rows}
                    filter={filter}
                    onChange={(patterns) => onFilterChange(column.name, patterns)}
                  />
                )}
                <span
                  className="hover:bg-primary/40 absolute top-0 right-0 h-full w-1 cursor-col-resize"
                  onMouseDown={(event) => startResize(event, col)}
                  onClick={(event) => event.stopPropagation()}
                  aria-hidden="true"
                />
              </div>
            );
          })}
        </div>

        {virtualizer.getVirtualItems().map((item) => {
          const row = item.index;
          const state = rowState?.(row) ?? "unchanged";
          return (
            <div
              key={item.key}
              role="row"
              className={cn(
                "absolute top-0 left-0 grid",
                state === "deleted" && "bg-destructive/10 text-destructive/80",
                state === "updated" && "bg-amber-500/10",
                state === "inserted" && "bg-emerald-500/10"
              )}
              style={{
                width: totalWidth,
                height: ROW_H,
                gridTemplateColumns: template,
                transform: `translateY(${item.start + HEADER_H}px)`,
              }}
            >
              <div
                className="bg-muted/30 text-muted-foreground flex items-center justify-end border-r border-b px-2 text-xs tabular-nums select-none"
                onMouseDown={(event) => {
                  if (event.button !== 0) return;
                  if (editing) commitEdit();
                  event.preventDefault();
                  scrollRef.current?.focus({ preventScroll: true });
                  const last = columns.length - 1;
                  setSelection(
                    event.shiftKey && selection
                      ? { ...selection, r1: row, c1: last }
                      : { r0: row, c0: 0, r1: row, c1: last }
                  );
                }}
                onContextMenu={(event) => {
                  if (!isSelected(row, 0)) selectCell(row, 0, false);
                  openContextMenu(event, row, 0);
                }}
              >
                {state === "inserted" ? "+" : (rowNumber?.(row) ?? row + 1)}
              </div>
              {columns.map((column, col) => {
                if (editing && editing.row === row && editing.col === col) {
                  return (
                    <div key={col} className="border-border/60 border-r border-b">
                      <input
                        autoFocus
                        aria-label={column.name}
                        className="bg-background ring-primary h-full w-full border-0 px-1 text-xs ring-2 outline-none ring-inset"
                        value={editing.text}
                        onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                        onMouseDown={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onBlur={commitEdit}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.nativeEvent.isComposing) return;
                          if (event.key === "Enter" && event.shiftKey) {
                            event.preventDefault();
                            const cell = {
                              row: editing.row,
                              col: editing.col,
                              text: editing.text,
                            };
                            commitEdit();
                            setMultiEdit(cell);
                          } else if (event.key === "Enter") {
                            event.preventDefault();
                            commitEdit();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setEditing(null);
                            scrollRef.current?.focus({ preventScroll: true });
                          }
                        }}
                      />
                    </div>
                  );
                }
                const value = rows[row]?.[col] ?? null;
                const matched = isMatch?.(row, col) ?? false;
                const hit = currentMatch?.row === row && currentMatch.col === col;
                return (
                  <div
                    key={col}
                    role="gridcell"
                    className={cn(
                      "border-border/60 flex min-w-0 items-center overflow-hidden border-r border-b px-2 text-xs",
                      numeric[col] && "justify-end tabular-nums",
                      matched && "bg-amber-200/60 dark:bg-amber-300/20",
                      isModified?.(row, col) && "bg-amber-500/15",
                      isSelected(row, col) && "bg-primary/20",
                      hit && "ring-2 ring-amber-500 ring-inset"
                    )}
                    onMouseDown={(event) => onCellMouseDown(event, row, col)}
                    onMouseEnter={() => {
                      if (dragging.current)
                        setSelection((current) =>
                          current ? { ...current, r1: row, c1: col } : current
                        );
                    }}
                    onDoubleClick={() => {
                      if (onChange) startEdit(row, col);
                      else setPreview({ row, col });
                    }}
                    onContextMenu={(event) => {
                      if (!isSelected(row, col)) selectCell(row, col, false);
                      openContextMenu(event, row, col);
                    }}
                  >
                    {value === null ? (
                      <span className="text-muted-foreground italic">
                        {t("database.grid.null")}
                      </span>
                    ) : (
                      <span className="truncate">{cellText(value, numeric[col] ?? false)}</span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {preview && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{columns[preview.col]?.name ?? t("database.grid.column")}</DialogTitle>
            </DialogHeader>
            <div className="bg-muted/30 max-h-80 overflow-auto rounded-md border p-2">
              {selectedValue === null ? (
                <span className="text-muted-foreground text-sm italic">
                  {t("database.grid.null")}
                </span>
              ) : (
                <pre className="font-mono text-xs break-all whitespace-pre-wrap">
                  {selectedValue}
                </pre>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => void writeClipboard(selectedValue ?? "")}>
                {t("database.grid.copy")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {multiEdit && onChange && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setMultiEdit(null);
          }}
        >
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>{t("database.grid.editDialogTitle")}</DialogTitle>
              <DialogDescription>{t("database.grid.editDialogHint")}</DialogDescription>
            </DialogHeader>
            <Textarea
              autoFocus
              className="min-h-40 font-mono text-xs"
              value={multiEdit.text}
              onChange={(event) => setMultiEdit({ ...multiEdit, text: event.target.value })}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setMultiEdit(null)}>
                {t("database.grid.cancel")}
              </Button>
              <Button
                onClick={() => {
                  onChange(
                    multiEdit.row,
                    multiEdit.col,
                    multiEdit.text === "" ? null : multiEdit.text
                  );
                  setMultiEdit(null);
                  scrollRef.current?.focus({ preventScroll: true });
                }}
              >
                {t("database.grid.save")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(null);
            }}
          />
          <div
            role="menu"
            className="bg-popover text-popover-foreground fixed z-50 min-w-40 rounded-md border p-1 shadow-md"
            style={{ left: menu.x, top: menu.y }}
          >
            <MenuItem
              onClick={() => {
                copySelection("tsv", false);
                setMenu(null);
              }}
            >
              {t("database.grid.copyTsv")}
            </MenuItem>
            <MenuItem
              onClick={() => {
                copySelection("csv", false);
                setMenu(null);
              }}
            >
              {t("database.grid.copyCsv")}
            </MenuItem>
            <div className="bg-border -mx-1 my-1 h-px" />
            <MenuItem
              onClick={() => {
                copyRows("tsv", true);
                setMenu(null);
              }}
            >
              {t("database.result.copyWithHeader")}
            </MenuItem>
            <MenuItem
              onClick={() => {
                copyRows("tsv", false);
                setMenu(null);
              }}
            >
              {t("database.result.copyRowsTsv")}
            </MenuItem>
            <MenuItem
              onClick={() => {
                copyRows("csv", false);
                setMenu(null);
              }}
            >
              {t("database.result.copyRowsCsv")}
            </MenuItem>
            <div className="bg-border -mx-1 my-1 h-px" />
            {onChange && (
              <MenuItem
                onClick={() => {
                  setSelectionNull();
                  setMenu(null);
                }}
              >
                {t("database.grid.null")}
              </MenuItem>
            )}
            <MenuItem
              onClick={() => {
                setPreview({ row: menu.row, col: menu.col });
                setMenu(null);
              }}
            >
              {t("database.grid.preview")}
            </MenuItem>
            {onRowDeleted && (
              <MenuItem
                onClick={() => {
                  onRowDeleted(menu.row);
                  setMenu(null);
                }}
              >
                {t("database.table.deleteRow")}
              </MenuItem>
            )}
            {rowMenu && menuRows.length > 0 && (
              <>
                <div className="bg-border -mx-1 my-1 h-px" />
                {rowMenu(menuRows).map((item) => (
                  <MenuItem
                    key={item.id}
                    disabled={item.disabled}
                    destructive={item.destructive}
                    onClick={() => {
                      item.run();
                      setMenu(null);
                    }}
                  >
                    {item.label}
                  </MenuItem>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem(props: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const { children, onClick, disabled, destructive } = props;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        "hover:bg-accent hover:text-accent-foreground flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs",
        destructive && "text-destructive",
        disabled && "pointer-events-none opacity-50"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ColumnFilter(props: {
  column: GridColumn;
  columnIndex: number;
  rows: (string | null)[][];
  filter?: (column: string, value: string | null) => boolean;
  onChange: (patterns: Set<string> | null) => void;
}) {
  const { column, columnIndex, rows, filter, onChange } = props;
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const { values, truncated } = useMemo(() => {
    if (!open) return { values: [] as Array<{ value: Cell; count: number }>, truncated: false };
    const counts = new Map<Cell, number>();
    for (const row of rows) {
      const value = row[columnIndex] ?? null;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const all = [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => compareCells(a.value, b.value));
    return { values: all.slice(0, FILTER_VALUE_LIMIT), truncated: all.length > FILTER_VALUE_LIMIT };
  }, [open, rows, columnIndex]);

  const checked = (value: Cell) => (filter ? filter(column.name, value) : true);
  const active =
    !!filter && rows.slice(0, SAMPLE_ROWS).some((row) => !checked(row[columnIndex] ?? null));
  const shown = query
    ? values.filter((entry) =>
        (entry.value ?? t("database.grid.null")).toLowerCase().includes(query.toLowerCase())
      )
    : values;
  const allChecked = values.every((entry) => checked(entry.value));

  const toggle = (value: Cell, on: boolean) => {
    if (!on) {
      const allowed = new Set<string>();
      for (const entry of values) {
        if (entry.value !== value && checked(entry.value)) {
          allowed.add(entry.value === null ? NULL_FILTER_PATTERN : entry.value);
        }
      }
      onChange(allowed);
      return;
    }
    const allowed = new Set<string>();
    for (const entry of values) {
      if (entry.value === value || checked(entry.value)) {
        allowed.add(entry.value === null ? NULL_FILTER_PATTERN : entry.value);
      }
    }
    if (!truncated && allowed.size === values.length) onChange(null);
    else onChange(allowed);
  };

  const toggleAll = () => {
    if (allChecked) {
      // Unchecking every value hides every row of this column.
      onChange(new Set());
      return;
    }
    onChange(null);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t("database.grid.filter")} ${column.name}`}
          title={t("database.grid.filter")}
          className={cn(
            "text-muted-foreground hover:bg-accent ml-auto flex size-4 shrink-0 items-center justify-center rounded-sm",
            active && "text-primary"
          )}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <Filter className="size-3" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-60 p-2"
        onClick={(event) => event.stopPropagation()}
      >
        <Input
          autoFocus
          aria-label={column.name}
          placeholder={column.name}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-7 text-xs"
        />
        <label className="hover:bg-accent mt-2 flex items-center gap-2 rounded-sm px-1 py-1 text-xs">
          <input
            type="checkbox"
            className="accent-primary"
            checked={allChecked}
            onChange={toggleAll}
          />
          <span>{t("database.grid.filter")}</span>
        </label>
        <div className="mt-1 max-h-56 overflow-auto">
          {shown.map((entry) => (
            <label
              key={entry.value ?? "\u0000null"}
              className="hover:bg-accent flex items-center gap-2 rounded-sm px-1 py-1 text-xs"
            >
              <input
                type="checkbox"
                className="accent-primary"
                checked={checked(entry.value)}
                onChange={(event) => toggle(entry.value, event.target.checked)}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  entry.value === null && "text-muted-foreground italic"
                )}
              >
                {entry.value === null ? t("database.grid.null") : entry.value}
              </span>
              <span className="text-muted-foreground tabular-nums">{entry.count}</span>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
