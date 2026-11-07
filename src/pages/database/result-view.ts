// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * Pure helpers of the result views: IDEA's local filter and client-side sort
 * of loaded rows, search in the grid, paging of result pages, and the
 * aggregates of a selection. The chart series of the upstream module is
 * dropped: this app has no chart view.
 */

/** A cell's text; `null` is SQL NULL. */
export type Cell = string | null;

/** Column index → the values still shown (IDEA's local filter: checked values). */
export type LocalFilter = ReadonlyMap<number, ReadonlySet<Cell>>;

export interface LocalSort {
  column: number;
  descending: boolean;
}

const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
const NUMERIC_TYPE = /int|num|dec|real|float|double|money|serial|^bit$/i;

/** Numbers are right-aligned: by type, else when every sampled value is one. */
export function isNumericColumn(typeName: string, sample: readonly Cell[]): boolean {
  if (typeName && !/^(null|unknown)?$/i.test(typeName)) {
    return NUMERIC_TYPE.test(typeName) && !/point|interval/i.test(typeName);
  }
  const values = sample.filter((v): v is string => v !== null);
  return values.length > 0 && values.every((v) => NUMBER.test(v));
}

/** Numbers by value, then text; NULL first (as most databases sort ascending). */
export function compareCells(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (NUMBER.test(a) && NUMBER.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : 1;
}

/**
 * The loaded rows to show, in order: those passing every column filter and
 * the search bar's row filter, sorted by `sort` (stable, original order
 * otherwise). Rows past `fixed` (the table editor's added rows) always stay,
 * last.
 */
export function visibleRows(
  rowCount: number,
  value: (row: number, col: number) => Cell,
  filter: LocalFilter,
  sort: LocalSort | null,
  fixed = rowCount,
  match?: (row: number) => boolean
): number[] {
  const rows: number[] = [];
  for (let r = 0; r < Math.min(rowCount, fixed); r++) {
    let shown = true;
    for (const [col, allowed] of filter) {
      if (!allowed.has(value(r, col))) {
        shown = false;
        break;
      }
    }
    if (shown && match && !match(r)) shown = false;
    if (shown) rows.push(r);
  }
  if (sort) {
    const dir = sort.descending ? -1 : 1;
    rows.sort((a, b) => dir * compareCells(value(a, sort.column), value(b, sort.column)) || a - b);
  }
  for (let r = fixed; r < rowCount; r++) rows.push(r);
  return rows;
}

/** Distinct values of a column with their counts, sorted (the filter popup's list). */
export function distinctValues(
  rowCount: number,
  value: (row: number, col: number) => Cell,
  col: number,
  limit = 1000
): Array<{ value: Cell; count: number }> {
  const counts = new Map<Cell, number>();
  for (let r = 0; r < rowCount; r++) {
    const v = value(r, col);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts]
    .map(([v, count]) => ({ value: v, count }))
    .sort((a, b) => compareCells(a.value, b.value))
    .slice(0, limit);
}

/** The new filter after toggling `v` of column `col` (all checked again: no filter). */
export function toggleFilterValue(
  filter: LocalFilter,
  col: number,
  all: readonly Cell[],
  v: Cell,
  checked: boolean
): LocalFilter {
  const next = new Map(filter);
  const current = new Set(filter.get(col) ?? all);
  if (checked) current.add(v);
  else current.delete(v);
  if (all.every((x) => current.has(x))) next.delete(col);
  else next.set(col, current);
  return next;
}

export interface Aggregates {
  count: number;
  distinct: number;
  nulls: number;
  /** When every non-NULL value is a number; null otherwise. */
  sum: number | null;
  avg: number | null;
  min: Cell;
  max: Cell;
  median: number | null;
}

/** IDEA's Aggregates view of the selected cells. */
export function aggregates(cells: readonly Cell[]): Aggregates {
  const present = cells.filter((c): c is string => c !== null);
  const numbers = present.filter((c) => NUMBER.test(c)).map(Number);
  const numeric = numbers.length > 0 && numbers.length === present.length;
  const sorted = [...present].sort(compareCells);
  let median: number | null = null;
  if (numeric) {
    const n = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(n.length / 2);
    median = n.length % 2 ? n[mid]! : (n[mid - 1]! + n[mid]!) / 2;
  }
  const sum = numeric ? numbers.reduce((a, b) => a + b, 0) : null;
  return {
    count: cells.length,
    distinct: new Set(cells).size,
    nulls: cells.length - present.length,
    sum,
    avg: sum === null ? null : sum / numbers.length,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    median,
  };
}

/** A number for display: integers as is, others to at most 6 significant decimals. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(12)));
}

/** IDEA's search options of the grid's search bar. */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** The search bar's state: its query, options, row filter and current match. */
export interface SearchState extends SearchOptions {
  query: string;
  /** Show only the rows with a match (IDEA's Filter rows). */
  filterRows: boolean;
  /** Index into the match list. */
  current: number;
}

/** A search bar state with every field at its default. */
export function searchState(init: Partial<SearchState> = {}): SearchState {
  return {
    query: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    filterRows: false,
    current: 0,
    ...init,
  };
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
const WORD_CHAR = /[\p{L}\p{N}_$]/u;

/** A test of a cell's text against `query`; `null` without a query, `"invalid"` for a bad regex. */
export function cellMatcher(
  query: string,
  options: SearchOptions
): ((text: string) => boolean) | null | "invalid" {
  if (!query) return null;
  const source = options.regex ? query : query.replace(REGEX_SPECIALS, "\\$&");
  let re: RegExp;
  try {
    re = new RegExp(source, options.caseSensitive ? "gu" : "giu");
  } catch {
    return "invalid";
  }
  // Words: a match with no word character on either side (no lookbehind: older WebKit lacks it).
  return (text) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start) {
        // Step a whole code point: with the `u` flag a lastIndex inside a surrogate pair
        // snaps back to the pair's start, which would match the same empty string forever.
        re.lastIndex = start + ((text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
        if (!options.wholeWord) return true;
        continue;
      }
      if (
        !options.wholeWord ||
        (!WORD_CHAR.test(text[start - 1] ?? "") && !WORD_CHAR.test(text[end] ?? ""))
      )
        return true;
    }
    return false;
  };
}

/** A matching cell: a row of the displayed rows and a column. */
export interface CellMatch {
  row: number;
  col: number;
}

/** The cells matching `test`, row by row; `row` is the position in `rows` (display order). NULL never matches. */
export function findCells(
  rows: readonly number[],
  colCount: number,
  value: (row: number, col: number) => Cell,
  test: (text: string) => boolean
): CellMatch[] {
  const out: CellMatch[] = [];
  rows.forEach((r, row) => {
    for (let col = 0; col < colCount; col++) {
      const v = value(r, col);
      if (v !== null && test(v)) out.push({ row, col });
    }
  });
  return out;
}

/** The current match; wraps around, `null` without matches. */
export function currentMatch(matches: readonly CellMatch[], index: number): CellMatch | null {
  if (matches.length === 0) return null;
  return matches[((index % matches.length) + matches.length) % matches.length]!;
}

/** The index of the match after `index`, wrapping; 0 without matches. */
export function nextMatch(index: number, count: number): number {
  return count <= 0 ? 0 : (index + 1) % count;
}

/** The index of the match before `index`, wrapping; 0 without matches. */
export function prevMatch(index: number, count: number): number {
  return count <= 0 ? 0 : (index - 1 + count) % count;
}

/** Whether any cell of loaded row `r` matches `test`. */
export function rowMatches(
  r: number,
  colCount: number,
  value: (row: number, col: number) => Cell,
  test: (text: string) => boolean
): boolean {
  for (let col = 0; col < colCount; col++) {
    const v = value(r, col);
    if (v !== null && test(v)) return true;
  }
  return false;
}

export interface PageState {
  /** Zero-based page shown. */
  page: number;
  pageSize: number;
  /** Rows on the page. */
  rows: number;
  /** More rows follow the page. */
  hasMore: boolean;
  /** Counted rows of the whole query, when known. */
  total: number | null;
}

export interface PageWindow {
  /** One-based numbers of the first and last row shown (0 and 0 on an empty page). */
  first: number;
  last: number;
  /** Rows of the whole query: known once counted or on reaching the end. */
  total: number | null;
  /** Zero-based last page, when the total is known. */
  lastPage: number | null;
}

/** What the pager shows ("1-500 of 501+"). */
export function pageWindow({ page, pageSize, rows, hasMore, total }: PageState): PageWindow {
  const offset = page * pageSize;
  const known = total ?? (hasMore ? null : offset + rows);
  return {
    first: rows ? offset + 1 : 0,
    last: offset + rows,
    total: known,
    lastPage: known === null ? null : Math.max(0, Math.ceil(known / pageSize) - 1),
  };
}

/** A page is read by running the query again: the backend reads past the rows before it and returns only the page. */
export function pageFetch(page: number, pageSize: number): { maxRows: number; skip: number } {
  return { maxRows: pageSize, skip: page * pageSize };
}
