// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * Result-set export formats (IDEA's data extractors): CSV, TSV, JSON, SQL
 * INSERT statements and a Markdown table. Values arrive as text; numeric
 * columns are written unquoted where the format distinguishes them.
 *
 * This module is pure: it returns the file's text. Writing it is the caller's
 * job (`saveTextFile` after `save()` picked a path).
 */
import type { DbDriver } from "@/commands";
import { isNumericColumn, type Cell } from "./result-view";
import { quoteIdent } from "./tree-model";

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown";

/** `label` is an i18n key; the caller translates it. */
export const EXPORT_FORMATS: ReadonlyArray<{ id: ExportFormat; label: string; extension: string }> =
  [
    { id: "csv", label: "database.export.csv", extension: "csv" },
    { id: "tsv", label: "database.export.tsv", extension: "tsv" },
    { id: "json", label: "database.export.json", extension: "json" },
    { id: "sql", label: "database.export.sql", extension: "sql" },
    { id: "markdown", label: "database.export.markdown", extension: "md" },
  ];

export type ExportData = {
  columns: ReadonlyArray<{ name: string; typeName: string }>;
  rows: ReadonlyArray<readonly Cell[]>;
  /** Target of SQL inserts (the query's table, when it reads one). */
  table?: string;
  /** Dialect for identifier quoting; SQLite when omitted. */
  driver?: DbDriver;
};

/** The Export Data dialog's options (CSV, TSV and Markdown; JSON and SQL keep their shape). */
export interface ExportOptions {
  columnHeader: boolean;
  rowHeader: boolean;
  transpose: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  columnHeader: true,
  rowHeader: false,
  transpose: false,
};

/** Tab-separated values (Excel / IDEA "Copy"): NULL is empty, tabs / newlines become spaces. */
export function toTsv(
  header: readonly string[] | null,
  rows: ReadonlyArray<readonly Cell[]>
): string {
  const clean = (v: Cell) => (v ?? "").replace(/[\t\r\n]+/g, " ");
  const lines = rows.map((r) => r.map(clean).join("\t"));
  if (header) lines.unshift(header.map(clean).join("\t"));
  return lines.join("\n");
}

/** RFC 4180 CSV; NULL is an empty field. */
export function toCsv(
  header: readonly string[] | null,
  rows: ReadonlyArray<readonly Cell[]>
): string {
  const field = (v: Cell) => {
    const s = v ?? "";
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) => r.map(field).join(","));
  if (header) lines.unshift(header.map(field).join(","));
  return lines.join("\r\n");
}

/** Header and rows of a delimited export after the row header / transpose options. */
function laidOut(d: ExportData, o: ExportOptions): { head: string[] | null; rows: Cell[][] } {
  let head = d.columns.map((c) => c.name);
  let rows = d.rows.map((r) => [...r]);
  if (o.rowHeader) {
    head = ["#", ...head];
    rows = rows.map((r, i) => [String(i + 1), ...r]);
  }
  if (!o.transpose) return { head: o.columnHeader ? head : null, rows };
  return {
    head: null,
    rows: head.map((h, c) => [...(o.columnHeader ? [h] : []), ...rows.map((r) => r[c] ?? null)]),
  };
}

export function exportData(
  format: ExportFormat,
  d: ExportData,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS
): string {
  const names = d.columns.map((c) => c.name);
  const numeric = d.columns.map((c, i) =>
    isNumericColumn(
      c.typeName,
      d.rows.slice(0, 50).map((r) => r[i] ?? null)
    )
  );
  const driver = d.driver ?? "sqlite";
  switch (format) {
    case "csv": {
      const t = laidOut(d, options);
      return toCsv(t.head, t.rows);
    }
    case "tsv": {
      const t = laidOut(d, options);
      return toTsv(t.head, t.rows);
    }
    case "json": {
      const value = (v: Cell, i: number) =>
        v === null ? null : numeric[i] && Number.isFinite(Number(v)) ? Number(v) : v;
      return JSON.stringify(
        d.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, value(r[i] ?? null, i)]))),
        null,
        2
      );
    }
    case "sql": {
      const table = d.table ?? "result";
      const literal = (v: Cell, i: number) =>
        v === null
          ? "NULL"
          : numeric[i] && Number.isFinite(Number(v))
            ? v
            : `'${(driver === "clickhouse" ? v.replace(/\\/g, "\\\\") : v).replace(/'/g, "''")}'`;
      const head = `INSERT INTO ${quoteIdent(driver, table)} (${names.map((n) => quoteIdent(driver, n)).join(", ")}) VALUES`;
      return d.rows.map((r) => `${head} (${r.map(literal).join(", ")});`).join("\n");
    }
    case "markdown": {
      const cell = (v: Cell) => (v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
      const t = laidOut(d, options);
      const width = t.head?.length ?? t.rows[0]?.length ?? 0;
      // A Markdown table always has a header row: blank when left out.
      const head = t.head ?? Array.from({ length: width }, () => "");
      const align =
        options.transpose || t.head === null
          ? head.map(() => "---")
          : [...(options.rowHeader ? ["--:"] : []), ...numeric.map((n) => (n ? "--:" : "---"))];
      return [head.map(cell), align, ...t.rows.map((r) => r.map(cell))]
        .map((r) => `| ${r.join(" | ")} |`)
        .join("\n");
    }
  }
}
