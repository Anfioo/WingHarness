// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * SQL the object tree's actions run or paste (Rename, Drop, Truncate, SQL
 * Scripts, Modify Table), per dialect. Pure functions.
 */

import type { ColumnInfo, DbDriver } from "@/commands";

export function quoteIdent(driver: DbDriver, name: string): string {
  if (driver === "clickhouse") return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (driver === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (driver === "sqlServer") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quotes only when needed: lower-case (PostgreSQL) / upper-case (Oracle) /
 * plain words stay bare, like IDEA's SQL.
 */
export function ident(driver: DbDriver, name: string): string {
  const plain =
    driver === "postgres"
      ? /^[a-z_][a-z0-9_$]*$/
      : // Oracle folds unquoted names to upper case.
        driver === "oracle"
        ? /^[A-Z_][A-Z0-9_$]*$/
        : driver === "clickhouse"
          ? /^[A-Za-z_][A-Za-z0-9_]*$/
          : /^[A-Za-z_][A-Za-z0-9_$]*$/;
  return plain.test(name) && !RESERVED.has(name.toUpperCase()) ? name : quoteIdent(driver, name);
}

const RESERVED = new Set(
  (
    "ALL AND AS ASC BETWEEN BY CASE CHECK COLUMN CONSTRAINT CREATE CROSS DEFAULT DELETE DESC DISTINCT DROP " +
    "ELSE END EXISTS FOREIGN FROM FULL GROUP HAVING IN INDEX INNER INSERT INTO IS JOIN KEY LEFT LIKE LIMIT NOT " +
    "NULL OFFSET ON OR ORDER OUTER PRIMARY REFERENCES RIGHT SELECT SET TABLE THEN TO UNION UNIQUE UPDATE USER " +
    "USING VALUES VIEW WHEN WHERE WITH"
  ).split(" ")
);

/** `schema.name`; SQLite's `main` and an empty schema are left out. */
export function qualifiedName(driver: DbDriver, schema: string, name: string): string {
  if (!schema || (driver === "sqlite" && schema === "main")) return ident(driver, name);
  return `${ident(driver, schema)}.${ident(driver, name)}`;
}

export type DbObjectKind =
  | "table"
  | "view"
  | "materializedView"
  | "column"
  | "index"
  | "schema"
  | "function"
  | "procedure"
  | "trigger"
  | "sequence";

/** A schema object of a data source, as the actions see it. */
export interface DbObjectRef {
  kind: DbObjectKind;
  schema: string;
  /** Object name; the column's table for a column. */
  name: string;
  /** Column name (kind `column`). */
  column?: string;
  /** Table of an index or trigger (MySQL drops an index `ON` its table, PostgreSQL a trigger). */
  table?: string;
  /** Argument types of a PostgreSQL routine (tells overloads apart). */
  arguments?: string;
}

/** The object's qualified name. */
export function reference(driver: DbDriver, o: DbObjectRef): string {
  if (o.kind === "schema") return ident(driver, o.name);
  const q = qualifiedName(driver, o.schema, o.name);
  return o.kind === "column" && o.column ? `${q}.${ident(driver, o.column)}` : q;
}

export const canRename = (driver: DbDriver, o: DbObjectRef) =>
  o.kind === "table" ||
  o.kind === "column" ||
  (o.kind === "view" && driver !== "sqlite") ||
  (o.kind === "index" && driver === "postgres");

/** The statement renaming `o` to `to`. */
export function renameSql(driver: DbDriver, o: DbObjectRef, to: string): string {
  const q = qualifiedName(driver, o.schema, o.name);
  switch (o.kind) {
    case "column":
      return `alter table ${q} rename column ${ident(driver, o.column ?? "")} to ${ident(driver, to)};`;
    case "index":
      return `alter index ${q} rename to ${ident(driver, to)};`;
    case "view":
      if (driver === "postgres") return `alter view ${q} rename to ${ident(driver, to)};`;
      if (driver === "oracle") return `rename ${q} to ${ident(driver, to)};`;
      return `rename table ${q} to ${qualifiedName(driver, o.schema, to)};`;
    default:
      if (driver === "mysql" || driver === "clickhouse")
        return `rename table ${q} to ${qualifiedName(driver, o.schema, to)};`;
      return `alter table ${q} rename to ${ident(driver, to)};`;
  }
}

export interface DropOptions {
  ifExists: boolean;
  /** PostgreSQL `CASCADE`. */
  cascade: boolean;
}

export const canDrop = (driver: DbDriver, o: DbObjectRef) =>
  driver === "clickhouse"
    ? ["table", "view", "materializedView", "column", "schema"].includes(o.kind)
    : !(o.kind === "schema" && driver === "sqlite");

export const canModifyTable = (driver: DbDriver) => driver !== "clickhouse";

/** The Confirm Drop preview. */
export function dropSql(driver: DbDriver, o: DbObjectRef, opts: DropOptions): string {
  const ifExists = opts.ifExists ? "if exists " : "";
  const cascade = opts.cascade && driver === "postgres" ? " cascade" : "";
  switch (o.kind) {
    case "column":
      return `alter table ${qualifiedName(driver, o.schema, o.name)} drop column ${ifExists && driver === "postgres" ? ifExists : ""}${ident(driver, o.column ?? "")}${cascade};`;
    case "index":
      if (driver === "mysql")
        return `drop index ${ident(driver, o.name)} on ${qualifiedName(driver, o.schema, o.table ?? "")};`;
      // Oracle's DROP INDEX takes no IF EXISTS.
      if (driver === "oracle") return `drop index ${qualifiedName(driver, o.schema, o.name)};`;
      return `drop index ${ifExists}${qualifiedName(driver, o.schema, o.name)}${cascade};`;
    case "schema":
      if (driver === "oracle") return `drop user ${ident(driver, o.name)} cascade;`;
      return `drop ${driver === "mysql" || driver === "clickhouse" ? "database" : "schema"} ${ifExists}${ident(driver, o.name)}${cascade};`;
    case "materializedView":
      if (driver === "clickhouse")
        return `drop table ${ifExists}${qualifiedName(driver, o.schema, o.name)};`;
      return `drop materialized view ${ifExists}${qualifiedName(driver, o.schema, o.name)}${cascade};`;
    case "function":
    case "procedure": {
      const args = driver === "postgres" ? `(${o.arguments ?? ""})` : "";
      return `drop ${o.kind} ${ifExists}${qualifiedName(driver, o.schema, o.name)}${args}${cascade};`;
    }
    case "trigger":
      if (driver === "postgres")
        return `drop trigger ${ifExists}${ident(driver, o.name)} on ${qualifiedName(driver, o.schema, o.table ?? "")}${cascade};`;
      return `drop trigger ${ifExists}${qualifiedName(driver, o.schema, o.name)};`;
    default:
      return `drop ${o.kind} ${ifExists}${qualifiedName(driver, o.schema, o.name)}${cascade};`;
  }
}

/** Truncate (SQLite has no TRUNCATE: `delete from`). */
export function truncateSql(
  driver: DbDriver,
  schema: string,
  table: string,
  opts: { restartIdentity: boolean; cascade: boolean }
): string {
  const q = qualifiedName(driver, schema, table);
  if (driver === "sqlite") return `delete from ${q};`;
  if (
    driver === "mysql" ||
    driver === "sqlServer" ||
    driver === "clickhouse" ||
    driver === "oracle"
  )
    return `truncate table ${q};`;
  return `truncate table ${q}${opts.restartIdentity ? " restart identity" : ""}${opts.cascade ? " cascade" : ""};`;
}

export type ScriptKind = "selectAll" | "selectFirst" | "insert" | "update" | "delete";

/** The i18n key of each template's label. */
export const SCRIPT_LABELS: Record<ScriptKind, string> = {
  selectAll: "database.object.selectAll",
  selectFirst: "database.object.selectFirst",
  insert: "database.object.insert",
  update: "database.object.update",
  delete: "database.object.delete",
};

/** SQL Scripts templates (IDEA's live templates `sel`, `selc`, `ins`, `upd`, `del`). */
export function scriptSql(
  driver: DbDriver,
  kind: ScriptKind,
  schema: string,
  table: string,
  columns: readonly ColumnInfo[]
): string {
  const q = qualifiedName(driver, schema, table);
  const names = columns.map((c) => ident(driver, c.name));
  const keys = columns.filter((c) => c.primaryKey).map((c) => ident(driver, c.name));
  const where =
    (keys.length ? keys : names.slice(0, 1)).map((k) => `${k} = ?`).join(" and ") || "1 = 0";
  switch (kind) {
    case "selectAll":
      return `select *\nfrom ${q};\n`;
    case "selectFirst":
      return driver === "oracle"
        ? `select *\nfrom ${q}\nfetch first 10 rows only;\n`
        : `select *\nfrom ${q}\nlimit 10;\n`;
    case "insert":
      return `insert into ${q} (${names.join(", ")})\nvalues (${names.map(() => "?").join(", ")});\n`;
    case "update": {
      const assignments = columns
        .filter((c) => !c.primaryKey)
        .map((c) => `${ident(driver, c.name)} = ?`);
      if (driver === "clickhouse") {
        if (!assignments.length)
          throw new Error("ClickHouse sorting key columns cannot be updated.");
        return `alter table ${q}\nupdate ${assignments.join(",\n       ")}\nwhere 1 = 0;\n`;
      }
      const set = assignments.length ? assignments : names.map((n) => `${n} = ?`);
      return `update ${q}\nset ${set.join(",\n    ")}\nwhere ${where};\n`;
    }
    case "delete":
      if (driver === "clickhouse") return `alter table ${q}\ndelete\nwhere 1 = 0;\n`;
      return `delete\nfrom ${q}\nwhere ${where};\n`;
  }
}

// ---- Modify Table -----------------------------------------------------------

/** A column row of the Modify Table dialog; `original` is the column it started as (absent: new). */
export interface ColumnDraft {
  key: number;
  original: ColumnInfo | null;
  name: string;
  dataType: string;
  notNull: boolean;
  /** SQL expression; empty for none. */
  default: string;
  primaryKey: boolean;
  dropped: boolean;
}

export function draftOf(c: ColumnInfo, key: number): ColumnDraft {
  return {
    key,
    original: c,
    name: c.name,
    dataType: c.dataType,
    notNull: !c.nullable,
    default: c.default ?? "",
    primaryKey: c.primaryKey,
    dropped: false,
  };
}

function columnDefinition(driver: DbDriver, c: ColumnDraft): string {
  const fallback =
    driver === "clickhouse"
      ? "String"
      : driver === "sqlite"
        ? "TEXT"
        : driver === "oracle"
          ? "VARCHAR2(255)"
          : "text";
  let s = `${ident(driver, c.name)} ${c.dataType.trim() || fallback}`;
  if (c.default.trim()) s += ` default ${c.default.trim()}`;
  if (c.notNull && driver !== "clickhouse") s += " not null";
  return s;
}

/** `create table` for New Table. */
export function createTableSql(
  driver: DbDriver,
  schema: string,
  name: string,
  columns: readonly ColumnDraft[]
): string {
  const live = columns.filter((c) => !c.dropped && c.name.trim());
  const keys = live.filter((c) => c.primaryKey).map((c) => ident(driver, c.name));
  const items = live.map((c) => `    ${columnDefinition(driver, c)}`);
  if (keys.length && driver !== "clickhouse") items.push(`    primary key (${keys.join(", ")})`);
  return `create table ${qualifiedName(driver, schema, name)}\n(\n${items.join(",\n")}\n)${driver === "clickhouse" ? "\nengine = MergeTree\norder by tuple()" : ""};\n`;
}

/** Whether `alterTableSql` can express changing column `c` (SQLite only renames, adds and drops). */
export function canAlterColumn(driver: DbDriver, c: ColumnDraft): boolean {
  return driver !== "sqlite" || !c.original;
}

/**
 * The statements turning the table `table` into `name` with `columns`:
 * renames, added / dropped columns, and — PostgreSQL / MySQL — type,
 * nullability and default changes.
 */
export function alterTableSql(
  driver: DbDriver,
  schema: string,
  table: string,
  name: string,
  columns: readonly ColumnDraft[]
): string[] {
  if (!canModifyTable(driver)) return [];
  const out: string[] = [];
  const q = () => qualifiedName(driver, schema, table);
  for (const c of columns) {
    const o = c.original;
    if (!o) {
      if (!c.dropped && c.name.trim()) {
        // Oracle takes the added column's definition in parentheses.
        out.push(
          driver === "oracle"
            ? `alter table ${q()} add (${columnDefinition(driver, c)});`
            : `alter table ${q()} add column ${columnDefinition(driver, c)};`
        );
      }
      continue;
    }
    if (c.dropped) {
      out.push(`alter table ${q()} drop column ${ident(driver, o.name)};`);
      continue;
    }
    const renamed = c.name.trim() !== "" && c.name !== o.name;
    const changed =
      c.dataType.trim() !== o.dataType ||
      c.notNull !== !o.nullable ||
      c.default.trim() !== (o.default ?? "").trim();
    if (driver === "mysql" && (renamed || changed)) {
      out.push(
        `alter table ${q()} change column ${ident(driver, o.name)} ${columnDefinition(driver, c)};`
      );
      continue;
    }
    if (driver === "oracle") {
      const col = ident(driver, o.name);
      if (c.dataType.trim() && c.dataType.trim() !== o.dataType) {
        out.push(
          `alter table ${q()} modify (${col} ${c.dataType.trim()}${c.notNull ? " not null" : ""});`
        );
      }
      if (c.notNull !== !o.nullable) {
        out.push(
          c.notNull
            ? `alter table ${q()} modify (${col} not null);`
            : `alter table ${q()} modify (${col} null);`
        );
      }
      if (c.default.trim() !== (o.default ?? "").trim()) {
        out.push(
          c.default.trim()
            ? `alter table ${q()} modify (${col} default ${c.default.trim()});`
            : `alter table ${q()} modify (${col} default null);`
        );
      }
      if (renamed) out.push(`alter table ${q()} rename column ${col} to ${ident(driver, c.name)};`);
      continue;
    }
    if (renamed)
      out.push(
        `alter table ${q()} rename column ${ident(driver, o.name)} to ${ident(driver, c.name)};`
      );
    if (driver !== "postgres") continue;
    const col = ident(driver, renamed ? c.name : o.name);
    if (c.dataType.trim() && c.dataType.trim() !== o.dataType)
      out.push(`alter table ${q()} alter column ${col} type ${c.dataType.trim()};`);
    if (c.notNull !== !o.nullable)
      out.push(`alter table ${q()} alter column ${col} ${c.notNull ? "set" : "drop"} not null;`);
    if (c.default.trim() !== (o.default ?? "").trim())
      out.push(
        `alter table ${q()} alter column ${col} ${c.default.trim() ? `set default ${c.default.trim()}` : "drop default"};`
      );
  }
  // The rename goes last: the column statements above name the table as it was.
  if (name.trim() && name.trim() !== table)
    out.push(renameSql(driver, { kind: "table", schema, name: table }, name.trim()));
  return out;
}
