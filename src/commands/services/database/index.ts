// Database command service.
//
// Thin, one-to-one wrappers over `src-tauri/src/commands/db.rs`, which is
// itself a thin shell over `db-core`. Argument keys are camelCase here; Tauri
// maps them onto the snake_case Rust parameters.
//
// Rejected calls throw the engine's `{ code, message }` object; use
// `isDatabaseError` / `databaseErrorCode` from `./types` to branch on `code`.

import { invokeCommand } from "../../base";
import { getActiveProject } from "../../project-context";
import type {
  CompletionModel,
  DataSource,
  DataSourceView,
  Databases,
  DbObjectKind,
  DbRowEdit,
  DbSettings,
  HistoryEntry,
  PlanNode,
  QueryFile,
  SchemaObjects,
  SortKey,
  SqlStatement,
  StatementOutcome,
  TableDetails,
  TableInfo,
  TablePage,
  WindowTabs,
} from "./types";

/**
 * Which of the two engines a scope-aware command works on: the app-wide one
 * behind the `/database` page, or the one belonging to the open project.
 */
export type DbScope = "app" | "project";

/**
 * The project the database commands run against. Project-scoped data sources
 * live under it, and an app-wide source with a relative SQLite path resolves
 * against it too, so it is sent with every command that takes a root. `null`
 * when this page has no project selected.
 */
function projectRoot(): string | null {
  return getActiveProject() || null;
}

/** Every data source of the scope. */
export async function dbSourceList(scope: DbScope = "app"): Promise<DataSourceView[]> {
  return await invokeCommand<{ scope: DbScope; root: string | null }, DataSourceView[]>(
    "db_sources",
    { scope, root: projectRoot() }
  );
}

/** Replaces the stored list. Ids must be unique; the order is preserved. */
export async function dbSourceSave(sources: DataSource[], scope: DbScope = "app"): Promise<void> {
  await invokeCommand<{ sources: DataSource[]; scope: DbScope; root: string | null }, void>(
    "db_save_sources",
    { sources, scope, root: projectRoot() }
  );
}

/**
 * Remembers the password for this session, and in the saved passwords when
 * `save` is set. `null` forgets it.
 */
export async function dbSourceSetPassword(
  id: string,
  password: string | null,
  save: boolean
): Promise<void> {
  await invokeCommand<
    { id: string; password: string | null; save: boolean; root: string | null },
    void
  >("db_set_password", { id, password, save, root: projectRoot() });
}

/**
 * Connects with the settings as given — they need not be saved — and returns
 * what the server calls itself: its version banner.
 */
export async function dbSourceTest(source: DataSource, password: string | null): Promise<string> {
  return await invokeCommand<
    { source: DataSource; password: string | null; root: string | null },
    string
  >("db_test", { source, password, root: projectRoot() });
}

/** Connected targets, as `<data source id>` or `<data source id>:<database>`. */
export async function dbConnectedTargets(): Promise<string[]> {
  return await invokeCommand<Record<string, never>, string[]>("db_connected", {});
}

/** Opens a pool for the data source; resolving means the server answered. */
export async function dbConnect(id: string): Promise<void> {
  await invokeCommand<{ id: string; root: string | null }, void>("db_connect", {
    id,
    root: projectRoot(),
  });
}

export async function dbDisconnect(id: string): Promise<void> {
  await invokeCommand<{ id: string; root: string | null }, void>("db_disconnect", {
    id,
    root: projectRoot(),
  });
}

/** Switches the data source's open connections between auto and manual commit. */
export async function dbSetManualCommit(id: string, manual: boolean): Promise<void> {
  await invokeCommand<{ id: string; manual: boolean; root: string | null }, void>(
    "db_set_manual_commit",
    { id, manual, root: projectRoot() }
  );
}

/** Commits or rolls back the manual-commit transaction that is open. */
export async function dbFinishTransaction(id: string, commit: boolean): Promise<void> {
  await invokeCommand<{ id: string; commit: boolean; root: string | null }, void>(
    "db_finish_transaction",
    { id, commit, root: projectRoot() }
  );
}

/**
 * Splits `text` into the statements the editor runs. `from` and `to` are
 * UTF-16 offsets of a selection; an empty selection means the statement at
 * the caret.
 */
export async function dbStatements(
  id: string,
  text: string,
  from: number,
  to: number
): Promise<SqlStatement[]> {
  return await invokeCommand<
    { id: string; text: string; from: number; to: number; root: string | null },
    SqlStatement[]
  >("db_statements", { id, text, from, to, root: projectRoot() });
}

/**
 * Runs a batch of statements in order. `request` identifies the batch for
 * `dbCancel`; `skip` and `maxRows` select a window of each result. A failing
 * statement is reported in its own outcome, not thrown.
 */
export async function dbExecute(
  request: string,
  id: string,
  statements: SqlStatement[],
  skip = 0,
  maxRows = 500
): Promise<StatementOutcome[]> {
  return await invokeCommand<
    {
      request: string;
      id: string;
      statements: SqlStatement[];
      skip: number;
      maxRows: number;
      root: string | null;
    },
    StatementOutcome[]
  >("db_execute", { request, id, statements, skip, maxRows, root: projectRoot() });
}

/** One page of a table, ordered and filtered on the server. */
export async function dbTablePage(
  request: string,
  id: string,
  schema: string,
  table: string,
  filter: string | null,
  sort: SortKey[],
  offset: number,
  limit: number
): Promise<TablePage> {
  return await invokeCommand<
    {
      request: string;
      id: string;
      schema: string;
      table: string;
      filter: string | null;
      sort: SortKey[];
      offset: number;
      limit: number;
      root: string | null;
    },
    TablePage
  >("db_table_page", {
    request,
    id,
    schema,
    table,
    filter,
    sort,
    offset,
    limit,
    root: projectRoot(),
  });
}

/** Applies the pending row edits in one transaction; a rejection rolls them all back. */
export async function dbApplyEdits(
  id: string,
  schema: string,
  table: string,
  edits: DbRowEdit[]
): Promise<number> {
  return await invokeCommand<
    { id: string; schema: string; table: string; edits: DbRowEdit[]; root: string | null },
    number
  >("db_apply_edits", { id, schema, table, edits, root: projectRoot() });
}

/** The `CREATE TABLE` statement of a table, read-only. */
export async function dbDdl(id: string, schema: string, table: string): Promise<string> {
  return await invokeCommand<
    { id: string; schema: string; table: string; root: string | null },
    string
  >("db_ddl", { id, schema, table, root: projectRoot() });
}

/** The definition of a routine, trigger or sequence, read-only. */
export async function dbObjectDdl(
  id: string,
  schema: string,
  kind: DbObjectKind,
  name: string
): Promise<string> {
  return await invokeCommand<
    { id: string; schema: string; kind: DbObjectKind; name: string; root: string | null },
    string
  >("db_object_ddl", { id, schema, kind, name, root: projectRoot() });
}

/** The tables, columns and foreign keys the SQL editor completes names from. */
export async function dbCompletion(id: string): Promise<CompletionModel> {
  return await invokeCommand<{ id: string; root: string | null }, CompletionModel>(
    "db_completion",
    { id, root: projectRoot() }
  );
}

/** Asks the statement running as `request` to stop; `false` if it already finished. */
export async function dbCancel(request: string): Promise<boolean> {
  return await invokeCommand<{ request: string }, boolean>("db_cancel", { request });
}

/** The statements this data source ran, newest first. */
export async function dbHistory(id: string): Promise<HistoryEntry[]> {
  return await invokeCommand<{ id: string; root: string | null }, HistoryEntry[]>("db_history", {
    id,
    root: projectRoot(),
  });
}

/** Forgets statements of the history; all of them when `texts` is `null`. */
export async function dbRemoveHistory(id: string, texts: string[] | null): Promise<void> {
  await invokeCommand<{ id: string; texts: string[] | null; root: string | null }, void>(
    "db_remove_history",
    { id, texts, root: projectRoot() }
  );
}

/**
 * The databases of a PostgreSQL server. `id` is a connection target: the data
 * source itself, or `<id>:<database>` for one of its other databases.
 */
export async function dbDatabases(id: string): Promise<Databases> {
  return await invokeCommand<{ id: string; root: string | null }, Databases>("db_databases", {
    id,
    root: projectRoot(),
  });
}

/** The schemas of a connection target. */
export async function dbSchemas(id: string): Promise<string[]> {
  return await invokeCommand<{ id: string; root: string | null }, string[]>("db_schemas", {
    id,
    root: projectRoot(),
  });
}

/** The tables and views of `schema`. */
export async function dbTables(id: string, schema: string): Promise<TableInfo[]> {
  return await invokeCommand<{ id: string; schema: string; root: string | null }, TableInfo[]>(
    "db_tables",
    { id, schema, root: projectRoot() }
  );
}

/** Columns, indexes, foreign keys and triggers of `table`. */
export async function dbTableDetails(
  id: string,
  schema: string,
  table: string
): Promise<TableDetails> {
  return await invokeCommand<
    { id: string; schema: string; table: string; root: string | null },
    TableDetails
  >("db_table_details", { id, schema, table, root: projectRoot() });
}

/** The routines and sequences of `schema`. */
export async function dbSchemaObjects(id: string, schema: string): Promise<SchemaObjects> {
  return await invokeCommand<{ id: string; schema: string; root: string | null }, SchemaObjects>(
    "db_schema_objects",
    { id, schema, root: projectRoot() }
  );
}

/** The `.sql` files of the query directory. */
export async function dbQueries(scope: DbScope = "app"): Promise<QueryFile[]> {
  return await invokeCommand<{ scope: DbScope; root: string | null }, QueryFile[]>("db_queries", {
    scope,
    root: projectRoot(),
  });
}

export async function dbQueryRead(name: string, scope: DbScope = "app"): Promise<string> {
  return await invokeCommand<{ name: string; scope: DbScope; root: string | null }, string>(
    "db_query_read",
    { name, scope, root: projectRoot() }
  );
}

export async function dbQueryWrite(
  name: string,
  text: string,
  scope: DbScope = "app"
): Promise<void> {
  await invokeCommand<{ name: string; text: string; scope: DbScope; root: string | null }, void>(
    "db_query_write",
    { name, text, scope, root: projectRoot() }
  );
}

export async function dbQueryDelete(name: string, scope: DbScope = "app"): Promise<void> {
  await invokeCommand<{ name: string; scope: DbScope; root: string | null }, void>(
    "db_query_delete",
    { name, scope, root: projectRoot() }
  );
}

/** The tabs `source` had when its window last closed; `null` if it saved none. */
export async function dbWindowTabs(source: string): Promise<WindowTabs | null> {
  return await invokeCommand<{ source: string }, WindowTabs | null>("db_window_tabs", { source });
}

export async function dbSaveWindowTabs(tabs: WindowTabs): Promise<void> {
  await invokeCommand<{ tabs: WindowTabs }, void>("db_save_window_tabs", { tabs });
}

export async function dbSettings(scope: DbScope = "app"): Promise<DbSettings> {
  return await invokeCommand<{ scope: DbScope; root: string | null }, DbSettings>("db_settings", {
    scope,
    root: projectRoot(),
  });
}

export async function dbSaveSettings(settings: DbSettings, scope: DbScope = "app"): Promise<void> {
  await invokeCommand<{ settings: DbSettings; scope: DbScope; root: string | null }, void>(
    "db_save_settings",
    { settings, scope, root: projectRoot() }
  );
}

/** The execution plan of `statement`, as the tree the Plan tab renders. */
export async function dbExplain(id: string, statement: string): Promise<PlanNode[]> {
  return await invokeCommand<{ id: string; statement: string; root: string | null }, PlanNode[]>(
    "db_explain",
    { id, statement, root: projectRoot() }
  );
}
