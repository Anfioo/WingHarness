// Pure helpers for the object tree: catalog-name filtering, connection
// targets, and the SQL a table's SELECT inserts.

import type {
  ColumnInfo,
  DataSourceView,
  DbDriver,
  ForeignKey,
  IndexInfo,
  TableDetails,
} from "@/commands";

/** A node's loaded children, or the reason there are none. */
export type Loaded<T> =
  | { status: "loading" }
  | { status: "ok"; value: T }
  | { status: "error"; message: string };

/** IDEA's groups under a table. */
export type TreeGroup = "columns" | "primaryKeys" | "foreignKeys" | "indexes" | "triggers";

/**
 * The node the tree toolbar acts on. Only the kinds whose object can be opened
 * or edited produce one; every other node reports `null`.
 */
export type TreeSelection = {
  target: string;
  schema: string;
  name: string;
  kind: "table" | "view" | "routine" | "sequence";
};

/** The columns that make up a table's primary key. */
export function primaryKeysOf(details: Pick<TableDetails, "columns">): ColumnInfo[] {
  return details.columns.filter((column) => column.primaryKey);
}

/** The groups a table shows, in order; empty groups are left out. */
export function groupsOf(details: TableDetails): TreeGroup[] {
  const groups: TreeGroup[] = [];
  if (details.columns.length) groups.push("columns");
  if (primaryKeysOf(details).length) groups.push("primaryKeys");
  if (details.foreignKeys.length) groups.push("foreignKeys");
  if (details.indexes.length) groups.push("indexes");
  if (details.triggers.length) groups.push("triggers");
  return groups;
}

/** How many members a group holds. */
export function groupSize(details: TableDetails, group: TreeGroup): number {
  switch (group) {
    case "columns":
      return details.columns.length;
    case "primaryKeys":
      return primaryKeysOf(details).length;
    case "foreignKeys":
      return details.foreignKeys.length;
    case "indexes":
      return details.indexes.length;
    case "triggers":
      return details.triggers.length;
  }
}

/** `columns → refTable(refColumns)`; the target's columns are left out when unknown. */
export function foreignKeyLabel(foreignKey: ForeignKey): string {
  const source = foreignKey.columns.join(", ");
  const target = foreignKey.refColumns.length
    ? `${foreignKey.refTable}(${foreignKey.refColumns.join(", ")})`
    : foreignKey.refTable;
  return `${source} → ${target}`;
}

/** `name`, marked when the index is unique. */
export function indexLabel(index: IndexInfo): string {
  return `${index.name}${index.unique ? " · unique" : ""}`;
}

/** `*` / `?` wildcard match (case-sensitive, like the server's names). */
export function matchesPattern(name: string, pattern: string): boolean {
  if (!/[*?]/.test(pattern)) return name === pattern;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * The names a Schemas tab chose to show, or all of them; `keep` (the connected
 * database) always stays visible.
 */
export function shownNames(
  names: readonly string[],
  all: boolean | undefined,
  chosen: readonly string[] | undefined,
  keep?: string | null
): string[] {
  if (all !== false) return [...names];
  const picks = (chosen ?? []).map((pattern) => pattern.trim()).filter(Boolean);
  return names.filter(
    (name) => name === keep || picks.some((pattern) => matchesPattern(name, pattern))
  );
}

/** Object filter patterns (`*`, `?`; comma or space separated); empty shows all. */
export function passesObjectFilter(name: string, filter: string | null | undefined): boolean {
  const patterns = (filter ?? "").split(/[\s,]+/).filter(Boolean);
  return (
    patterns.length === 0 ||
    patterns.some((pattern) => matchesPattern(name.toLowerCase(), pattern.toLowerCase()))
  );
}

/** A connection target: a data source id, or `<id>:<database>`. */
export function splitTarget(target: string): { id: string; database: string | null } {
  const at = target.indexOf(":");
  return at < 0
    ? { id: target, database: null }
    : { id: target.slice(0, at), database: target.slice(at + 1) || null };
}

/** The target of `database` on data source `id`; the connected one is the data source itself. */
export function targetOf(id: string, database: string | null, current: string | null): string {
  return !database || database === current ? id : `${id}:${database}`;
}

/** PostgreSQL sources show the server's databases unless Single database is set. */
export function listsDatabases(source: Pick<DataSourceView, "driver" | "options">): boolean {
  return source.driver === "postgres" && !source.options.singleDatabase;
}

/** The databases a source's Schemas tab chose to show. */
export function shownDatabases(
  source: Pick<DataSourceView, "introspection">,
  names: readonly string[],
  current: string
): string[] {
  const introspection = source.introspection;
  return shownNames(names, introspection.allDatabases, introspection.databases, current);
}

/** The schemas a source's Schemas tab chose to show. */
export function shownSchemas(
  source: Pick<DataSourceView, "introspection">,
  names: readonly string[]
): string[] {
  const introspection = source.introspection;
  return shownNames(names, introspection.allSchemas, introspection.schemas);
}

/** The object filter of a source. */
export function objectFilterOf(source: Pick<DataSourceView, "introspection">): string {
  return source.introspection.objectFilter;
}

export function quoteIdent(driver: DbDriver, name: string): string {
  switch (driver) {
    case "mysql":
      return `\`${name.replace(/`/g, "``")}\``;
    case "sqlServer":
      return `[${name.replace(/\]/g, "]]")}]`;
    case "clickhouse":
      return `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;
    default:
      return `"${name.replace(/"/g, '""')}"`;
  }
}

/** `schema.name`; SQLite's `main` and an empty schema are left out. */
export function qualifiedName(driver: DbDriver, schema: string, name: string): string {
  if (!schema || (driver === "sqlite" && schema === "main")) return quoteIdent(driver, name);
  return `${quoteIdent(driver, schema)}.${quoteIdent(driver, name)}`;
}

/** The statement inserted into the console when a table is double-clicked. */
export function selectSql(driver: DbDriver, schema: string, table: string): string {
  return `SELECT *\nFROM ${qualifiedName(driver, schema, table)};\n`;
}
