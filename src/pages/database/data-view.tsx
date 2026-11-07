// The grid a result page and a table data page share: the grid itself, IDEA's
// search bar above it and the Record / Value / Aggregates panel beside it.
// Filtering, searching and sorting of the loaded rows all happen here; paging
// belongs to the caller.

import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { DataPanel as DataPanelView, type DataPanel } from "./data-panel";
import { NULL_FILTER_PATTERN, ResultGrid, type GridColumn, type GridRange } from "./result-grid";
import {
  cellMatcher,
  currentMatch as matchAt,
  findCells,
  nextMatch,
  prevMatch,
  rowMatches,
  searchState,
  visibleRows,
  type Cell,
  type LocalFilter,
  type LocalSort,
  type SearchState,
} from "./result-view";

/** One entry of the context menu a grid shows for its selected rows. */
export type GridMenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  run(): void;
};

export type DataViewProps = {
  columns: GridColumn[];
  rows: Cell[][];
  rowCount: number;
  rowState?: (row: number) => "unchanged" | "updated" | "inserted" | "deleted";
  isModified?: (row: number, col: number) => boolean;
  editable?: boolean;
  onChange?: (row: number, col: number, value: Cell) => void;
  sort?: { column: string; descending: boolean }[];
  onSort?: (column: string, add: boolean) => void;
  firstRowNumber?: number;
  rowMenu?: (rows: number[]) => GridMenuItem[];
  panel: DataPanel;
  onPanelChange(panel: DataPanel): void;
  searchOpen: boolean;
  onSearchOpenChange(open: boolean): void;
  onFind?: () => void;
  ariaLabel?: string;
};

/** Local filter and sort, tied to the column set they were made for. */
interface Shaping {
  key: string;
  filter: LocalFilter;
  sort: LocalSort | null;
}

const NO_FILTER: LocalFilter = new Map();

export function DataView(props: DataViewProps): ReactNode {
  const {
    columns,
    rows,
    rowCount,
    rowState,
    isModified,
    editable,
    onChange,
    sort,
    onSort,
    firstRowNumber,
    rowMenu,
    panel,
    onPanelChange,
    searchOpen,
    onSearchOpenChange,
    onFind,
    ariaLabel,
  } = props;
  const { t } = useAppTranslation();

  const columnKey = useMemo(
    () => columns.map((column) => `${column.name}\u0000${column.typeName}`).join("\u0001"),
    [columns]
  );

  // A re-run query or another table starts without the previous column set's
  // filter and sort.
  const [shaping, setShaping] = useState<Shaping>({
    key: columnKey,
    filter: NO_FILTER,
    sort: null,
  });
  const current: Shaping =
    shaping.key === columnKey ? shaping : { key: columnKey, filter: NO_FILTER, sort: null };
  const { filter, sort: localSort } = current;

  const setFilter = (next: LocalFilter) => setShaping({ ...current, filter: next });
  const setLocalSort = (next: (prev: LocalSort | null) => LocalSort | null) =>
    setShaping({ ...current, sort: next(current.sort) });

  const [search, setSearch] = useState<SearchState>(() => searchState());
  const [range, setRange] = useState<GridRange | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const value = useCallback((row: number, col: number): Cell => rows[row]?.[col] ?? null, [rows]);

  const local = !onSort;
  // Display row → loaded row; `null` keeps the identity (nothing shaped it).
  const shaped = useMemo(
    () =>
      filter.size || (local && localSort)
        ? visibleRows(rowCount, value, filter, local ? localSort : null)
        : null,
    [rowCount, value, filter, local, localSort]
  );

  const options = useMemo(
    () => ({
      caseSensitive: search.caseSensitive,
      wholeWord: search.wholeWord,
      regex: search.regex,
    }),
    [search.caseSensitive, search.wholeWord, search.regex]
  );
  const matcher = useMemo(
    () => (searchOpen ? cellMatcher(search.query, options) : null),
    [searchOpen, search.query, options]
  );
  const test = typeof matcher === "function" ? matcher : null;

  const order = useMemo(() => {
    if (!test || !search.filterRows) return shaped;
    const base = shaped ?? Array.from({ length: rowCount }, (_, row) => row);
    return base.filter((row) => rowMatches(row, columns.length, value, test));
  }, [shaped, test, search.filterRows, rowCount, columns.length, value]);

  /** Display row → loaded row. */
  const at = (row: number) => (order ? (order[row] ?? row) : row);

  const shownRows = useMemo(
    () => (order ? order.map((row) => rows[row] ?? []) : rows),
    [order, rows]
  );

  const matches = useMemo(() => {
    if (!test) return [];
    const base = order ?? Array.from({ length: rowCount }, (_, row) => row);
    return findCells(base, columns.length, value, test);
  }, [test, order, rowCount, columns.length, value]);
  const matchSet = useMemo(
    () => new Set(matches.map((match) => `${match.row}:${match.col}`)),
    [matches]
  );
  const hit = matchAt(matches, search.current);

  const openSearch = useCallback(() => {
    onFind?.();
    onSearchOpenChange(true);
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  }, [onFind, onSearchOpenChange]);

  const closeSearch = () => {
    // The query stays for the next Ctrl+F; only its row filter goes away.
    setSearch((state) => ({ ...state, filterRows: false }));
    onSearchOpenChange(false);
  };

  const step = (direction: "next" | "prev") =>
    setSearch((state) => ({
      ...state,
      current:
        direction === "next"
          ? nextMatch(state.current, matches.length)
          : prevMatch(state.current, matches.length),
    }));

  const patchSearch = (patch: Partial<SearchState>) =>
    setSearch((state) => ({ ...state, ...patch, current: 0 }));

  // Local sort only when the caller does not sort on the server.
  const sortColumn = (column: string, add: boolean) => {
    if (!local) {
      onSort?.(column, add);
      return;
    }
    const col = columns.findIndex((entry) => entry.name === column);
    setLocalSort((prev) =>
      prev?.column !== col
        ? { column: col, descending: false }
        : !prev.descending
          ? { ...prev, descending: true }
          : null
    );
    void add;
  };
  const sortKeys = local
    ? localSort
      ? [{ column: columns[localSort.column]?.name ?? "", descending: localSort.descending }]
      : []
    : sort;

  const columnFilter = (column: string, v: Cell) => {
    const col = columns.findIndex((entry) => entry.name === column);
    const allowed = filter.get(col);
    return !allowed || allowed.has(v);
  };

  const changeFilter = (column: string, patterns: Set<string> | null) => {
    const col = columns.findIndex((entry) => entry.name === column);
    const next = new Map(filter);
    if (patterns === null) next.delete(col);
    else
      next.set(
        col,
        new Set([...patterns].map((pattern) => (pattern === NULL_FILTER_PATTERN ? null : pattern)))
      );
    setFilter(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    const target = event.target as HTMLElement;
    const typing =
      target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
    if (mod && event.key.toLowerCase() === "f" && !typing) {
      event.preventDefault();
      openSearch();
    }
  };

  const count = test ? matches.length : 0;
  const invalid = matcher === "invalid";

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      {searchOpen && (
        <div
          role="search"
          aria-label={t("database.result.find")}
          className="bg-muted/40 flex shrink-0 items-center gap-1 border-b px-2 py-1"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeSearch();
            } else if (event.key === "Enter" || event.key === "F3") {
              event.preventDefault();
              step(event.shiftKey ? "prev" : "next");
            } else if (event.altKey && !event.metaKey && !event.ctrlKey) {
              const toggle =
                event.code === "KeyC"
                  ? { caseSensitive: !search.caseSensitive }
                  : event.code === "KeyW"
                    ? { wholeWord: !search.wholeWord }
                    : event.code === "KeyX"
                      ? { regex: !search.regex }
                      : null;
              if (toggle) {
                event.preventDefault();
                patchSearch(toggle);
              }
            }
          }}
        >
          <Input
            ref={searchInput}
            autoFocus
            value={search.query}
            placeholder={t("database.result.findPlaceholder")}
            aria-label={t("database.result.find")}
            aria-invalid={invalid || (count === 0 && !!search.query)}
            className={cn(
              "h-7 max-w-64 text-xs",
              (invalid || (count === 0 && !!search.query)) && "border-destructive"
            )}
            onChange={(event) => patchSearch({ query: event.target.value })}
          />
          <SearchToggle
            active={search.caseSensitive}
            label={t("database.result.matchCase")}
            onClick={() => patchSearch({ caseSensitive: !search.caseSensitive })}
          >
            <CaseSensitive />
          </SearchToggle>
          <SearchToggle
            active={search.wholeWord}
            label={t("database.result.wholeWord")}
            onClick={() => patchSearch({ wholeWord: !search.wholeWord })}
          >
            <WholeWord />
          </SearchToggle>
          <SearchToggle
            active={search.regex}
            label={t("database.result.regex")}
            onClick={() => patchSearch({ regex: !search.regex })}
          >
            <Regex />
          </SearchToggle>
          <span
            aria-live="polite"
            className={cn(
              "min-w-14 px-1 text-center text-xs tabular-nums",
              (invalid || (count === 0 && !!search.query)) && "text-destructive"
            )}
          >
            {invalid
              ? t("database.result.invalidRegex")
              : !search.query
                ? ""
                : count === 0
                  ? t("database.result.noMatch")
                  : `${matches.findIndex((match) => match === hit) + 1}/${count}`}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={count === 0}
            aria-label={t("database.result.findPrev")}
            title={t("database.result.findPrev")}
            onClick={() => step("prev")}
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={count === 0}
            aria-label={t("database.result.findNext")}
            title={t("database.result.findNext")}
            onClick={() => step("next")}
          >
            <ChevronDown />
          </Button>
          <label className="ml-1 flex items-center gap-1.5 text-xs select-none">
            <input
              type="checkbox"
              className="accent-primary"
              checked={search.filterRows}
              onChange={(event) => patchSearch({ filterRows: event.target.checked })}
            />
            <span>{t("database.result.filterRows")}</span>
          </label>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label={t("database.result.closeSearch")}
            title={t("database.result.closeSearch")}
            onClick={closeSearch}
          >
            <X />
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1">
          <ResultGrid
            ariaLabel={ariaLabel}
            columns={columns}
            rows={shownRows}
            rowState={rowState && ((row) => rowState(at(row)))}
            isModified={isModified && ((row, col) => isModified(at(row), col))}
            onChange={
              (editable ?? !!onChange) && onChange
                ? (row, col, next) => onChange(at(row), col, next)
                : undefined
            }
            sort={sortKeys}
            onSort={sortColumn}
            rowMenu={rowMenu && ((menuRows) => rowMenu(menuRows.map(at)))}
            rowNumber={(row) => (firstRowNumber ?? 1) + at(row)}
            filter={filter.size ? columnFilter : undefined}
            onFilterChange={changeFilter}
            filterRows={rows}
            isMatch={test ? (row, col) => matchSet.has(`${row}:${col}`) : undefined}
            currentMatch={hit}
            onFind={openSearch}
            onSelectionChange={setRange}
          />
        </div>
        <DataPanelView
          columns={columns}
          rows={shownRows}
          selection={range}
          panel={panel}
          onPanelChange={onPanelChange}
        />
      </div>
    </div>
  );
}

function SearchToggle(props: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const { active, label, onClick, children } = props;
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      size="icon-xs"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
