// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.
//
// Pending row edits of the table data editor. Pure functions: no React, no IPC.
//
// A page is read from the server, so the editor never rewrites SQL. It only
// records which cells changed, which loaded rows are marked for deletion and
// which rows are new, then `buildRowEdits` turns that into the `DbRowEdit[]`
// the backend compiles into one transaction.

import type { CellValue, DbRowEdit, SortKey } from "@/commands";

/** One cell: text, or SQL NULL. */
export type Cell = string | null;

/** The page the draft is against. */
export type EditTarget = {
  /** Column names in page order. */
  columns: string[];
  /** Rows as the server returned them. */
  rows: Cell[][];
};

/**
 * Pending changes. Rows are keyed by their index in the displayed grid: the
 * first `rows.length` rows are the loaded page, the rest are new rows.
 */
export type PendingEdits = {
  /** Loaded row index (as a string) → column name → new value. */
  updates: Map<string, Map<string, Cell>>;
  /** Loaded row indices marked for deletion. */
  deletes: Set<string>;
  /** New rows, one cell per column of the page. */
  inserts: Cell[][];
};

export function emptyEdits(): PendingEdits {
  return { updates: new Map(), deletes: new Set(), inserts: [] };
}

/** Drops every pending change. */
export function discard(): PendingEdits {
  return emptyEdits();
}

export function hasEdits(edits: PendingEdits): boolean {
  return edits.updates.size > 0 || edits.deletes.size > 0 || edits.inserts.length > 0;
}

/** Rows a submit would touch, for the "N changed rows" label. */
export function pendingCount(edits: PendingEdits): number {
  let updates = 0;
  for (const row of edits.updates.keys()) if (!edits.deletes.has(row)) updates++;
  return updates + edits.deletes.size + edits.inserts.length;
}

/** The rows the grid shows: the page with its updates applied, then the new rows. */
export function displayRows(target: EditTarget, edits: PendingEdits): Cell[][] {
  const loaded = target.rows.map((row, index) => {
    const changes = edits.updates.get(String(index));
    if (!changes || changes.size === 0) return row;
    return target.columns.map((name, column) => {
      const change = changes.get(name);
      return change === undefined ? (row[column] ?? null) : change;
    });
  });
  return [...loaded, ...edits.inserts.map((row) => [...row])];
}

/**
 * Records one cell of the displayed grid. Setting a loaded cell back to its
 * original value drops the override, so a row edited and undone is unchanged.
 */
export function applyCell(
  edits: PendingEdits,
  target: EditTarget,
  row: number,
  column: number,
  value: Cell
): PendingEdits {
  const name = target.columns[column];
  if (name === undefined) return edits;

  if (row >= target.rows.length) {
    const index = row - target.rows.length;
    const inserts = edits.inserts.map((cells, i) => {
      if (i !== index) return cells;
      const next = [...cells];
      next[column] = value;
      return next;
    });
    return { ...edits, inserts };
  }

  const updates = new Map(edits.updates);
  const changes = new Map(updates.get(String(row)));
  if ((target.rows[row]?.[column] ?? null) === value) changes.delete(name);
  else changes.set(name, value);
  if (changes.size) updates.set(String(row), changes);
  else updates.delete(String(row));
  return { ...edits, updates };
}

/** Marks a loaded row for deletion; a new row is simply dropped. */
export function markDeleted(edits: PendingEdits, target: EditTarget, row: number): PendingEdits {
  if (row >= target.rows.length) {
    const index = row - target.rows.length;
    return { ...edits, inserts: edits.inserts.filter((_, i) => i !== index) };
  }
  const deletes = new Set(edits.deletes);
  deletes.add(String(row));
  return { ...edits, deletes };
}

/** Takes a loaded row back out of the deletion set. */
export function unmarkDeleted(edits: PendingEdits, row: number): PendingEdits {
  const deletes = new Set(edits.deletes);
  deletes.delete(String(row));
  return { ...edits, deletes };
}

/** Appends an empty row of `columnCount` cells. */
export function addRow(edits: PendingEdits, columnCount: number): PendingEdits {
  return { ...edits, inserts: [...edits.inserts, Array<Cell>(columnCount).fill(null)] };
}

/** The row overlay the grid paints for `row`. */
export function rowState(
  edits: PendingEdits,
  loadedRows: number,
  row: number
): "unchanged" | "updated" | "inserted" | "deleted" {
  if (row >= loadedRows) return "inserted";
  const key = String(row);
  if (edits.deletes.has(key)) return "deleted";
  if (edits.updates.has(key)) return "updated";
  return "unchanged";
}

/**
 * The DML requests for the draft. `update` carries the original primary-key
 * values of the row and only the columns that actually changed; `delete` uses
 * the same key; `insert` lists every column of the new row. Without a primary
 * key there is no way to identify a row, so there is nothing to submit.
 */
export function buildRowEdits(
  columns: readonly string[],
  rows: ReadonlyArray<readonly Cell[]>,
  primaryKey: readonly string[],
  edits: PendingEdits
): DbRowEdit[] {
  if (primaryKey.length === 0) return [];

  const index = new Map(columns.map((name, i) => [name, i]));
  const keyOf = (row: number): CellValue[] =>
    primaryKey.map((column) => ({
      column,
      value: rows[row]?.[index.get(column) ?? -1] ?? null,
    }));

  const out: DbRowEdit[] = [];
  for (const [row, changes] of edits.updates) {
    if (edits.deletes.has(row) || changes.size === 0) continue;
    out.push({
      kind: "update",
      key: keyOf(Number(row)),
      values: [...changes].map(([column, value]) => ({ column, value })),
    });
  }
  for (const row of [...edits.deletes].map(Number).sort((a, b) => a - b)) {
    out.push({ kind: "delete", key: keyOf(row) });
  }
  for (const cells of edits.inserts) {
    out.push({
      kind: "insert",
      values: columns.map((column, i) => ({ column, value: cells[i] ?? null })),
    });
  }
  return out;
}

// The import and ORDER BY helpers below are ported from the upstream
// `model.ts`; they are pure so the dialog can preview them directly.

/** Rows of RFC 4180 text with `separator` (quoted fields, `""`, CR LF); a trailing newline adds no row. */
export function parseDelimited(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A byte-order mark is not part of the first field.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === separator) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The separator of delimited text: whichever of `,` `\t` `;` `|` the first line has most of. */
export function guessSeparator(text: string): string {
  const first = text.slice(0, text.search(/\r?\n|$/));
  const count = (separator: string) => first.split(separator).length - 1;
  // A tie keeps the earlier separator, in this order.
  return [",", "\t", ";", "|"].reduce(
    (best, separator) => (count(separator) > count(best) ? separator : best),
    ","
  );
}

/**
 * Insert edits importing `rows` into a table with `columns`: by header name
 * (case-insensitive; unknown names skipped) or by position. `emptyAsNull`
 * turns empty fields into NULL, and blank lines are dropped.
 */
export function importEdits(
  rows: string[][],
  columns: string[],
  header: boolean,
  emptyAsNull: boolean
): DbRowEdit[] {
  const target = (name: string) =>
    columns.find((column) => column.toLowerCase() === name.trim().toLowerCase()) ?? null;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const map: Array<string | null> = header ? (rows[0] ?? []).map(target) : columns.slice(0, width);
  const body = header ? rows.slice(1) : rows;
  return body
    .filter((row) => row.some((value) => value !== ""))
    .map((row) => ({
      kind: "insert",
      values: map.flatMap((column, i) =>
        column === null
          ? []
          : [
              {
                column,
                value: emptyAsNull && (row[i] ?? "") === "" ? null : (row[i] ?? null),
              },
            ]
      ),
    }));
}

/** The table editor's ORDER BY field for a sort: `name DESC, id`. */
export function formatOrderBy(sort: readonly SortKey[]): string {
  return sort.map((key) => (key.descending ? `${key.column} DESC` : key.column)).join(", ");
}

/** Parses `col [ASC|DESC], …`, matching names case-insensitively; null when a part is not a column. */
export function parseOrderBy(text: string, columns: readonly string[]): SortKey[] | null {
  const out: SortKey[] = [];
  for (const part of text
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const match = /^("?)([^"]+?)\1(?:\s+(asc|desc))?$/i.exec(part);
    const column =
      match && columns.find((entry) => entry.toLowerCase() === match[2].trim().toLowerCase());
    if (!match || !column) return null;
    out.push({ column, descending: match[3]?.toLowerCase() === "desc" });
  }
  return out;
}
