// Database command service.
//
// Thin, one-to-one wrappers over `src-tauri/src/commands/db.rs`, which is
// itself a thin shell over `db-core`. Argument keys are camelCase here; Tauri
// maps them onto the snake_case Rust parameters.
//
// Rejected calls throw the engine's `{ code, message }` object; use
// `isDatabaseError` / `databaseErrorCode` from `./types` to branch on `code`.

import { invokeCommand } from "../../base";
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

/** Every data source of the current project, plus the app-wide ones. */
export async function dbSourceList(): Promise<DataSourceView[]> {
  return await invokeCommand<Record<string, never>, DataSourceView[]>("db_sources", {});
}

/** Replaces the stored list. Ids must be unique; the order is preserved. */
export async function dbSourceSave(sources: DataSource[]): Promise<void> {
  await invokeCommand<{ sources: DataSource[] }, void>("db_save_sources", { sources });
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
  await invokeCommand<{ id: string; password: string | null; save: boolean }, void>(
    "db_set_password",
    { id, password, save }
  );
}

/**
 * Connects with the settings as given — they need not be saved — and returns
 * what the server calls itself: its version banner.
 */
export async function dbSourceTest(source: DataSource, password: string | null): Promise<string> {
  return await invokeCommand<{ source: DataSource; password: string | null }, string>("db_test", {
    source,
    password,
  });
}

/** Connected targets, as `<data source id>` or `<data source id>:<database>`. */
export async function dbConnectedTargets(): Promise<string[]> {
  return await invokeCommand<Record<string, never>, string[]>("db_connected", {});
}

/** Opens a pool for the data source; resolving means the server answered. */
export async function dbConnect(id: string): Promise<void> {
  await invokeCommand<{ id: string }, void>("db_connect", { id });
}

export async function dbDisconnect(id: string): Promise<void> {
  await invokeCommand<{ id: string }, void>("db_disconnect", { id });
}

/** Switches the data source's open connections between auto and manual commit. */
export async function dbSetManualCommit(id: string, manual: boolean): Promise<void> {
  await invokeCommand<{ id: string; manual: boolean }, void>("db_set_manual_commit", {
    id,
    manual,
  });
}

/** Commits or rolls back the manual-commit transaction that is open. */
export async function dbFinishTransaction(id: string, commit: boolean): Promise<void> {
  await invokeCommand<{ id: string; commit: boolean }, void>("db_finish_transaction", {
    id,
    commit,
  });
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
    { id: string; text: string; from: number; to: number },
    SqlStatement[]
  >("db_statements", { id, text, from, to });
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
    { request: string; id: string; statements: SqlStatement[]; skip: number; maxRows: number },
    StatementOutcome[]
  >("db_execute", { request, id, statements, skip, maxRows });
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
    },
    TablePage
  >("db_table_page", { request, id, schema, table, filter, sort, offset, limit });
}

/** Applies the pending row edits in one transaction; a rejection rolls them all back. */
export async function dbApplyEdits(
  id: string,
  schema: string,
  table: string,
  edits: DbRowEdit[]
): Promise<number> {
  return await invokeCommand<
    { id: string; schema: string; table: string; edits: DbRowEdit[] },
    number
  >("db_apply_edits", { id, schema, table, edits });
}

/** The `CREATE TABLE` statement of a table, read-only. */
export async function dbDdl(id: string, schema: string, table: string): Promise<string> {
  return await invokeCommand<{ id: string; schema: string; table: string }, string>("db_ddl", {
    id,
    schema,
    table,
  });
}

/** The definition of a routine, trigger or sequence, read-only. */
export async function dbObjectDdl(
  id: string,
  schema: string,
  kind: DbObjectKind,
  name: string
): Promise<string> {
  return await invokeCommand<
    { id: string; schema: string; kind: DbObjectKind; name: string },
    string
  >("db_object_ddl", { id, schema, kind, name });
}

/** The tables, columns and foreign keys the SQL editor completes names from. */
export async function dbCompletion(id: string): Promise<CompletionModel> {
  return await invokeCommand<{ id: string }, CompletionModel>("db_completion", { id });
}

/** Asks the statement running as `request` to stop; `false` if it already finished. */
export async function dbCancel(request: string): Promise<boolean> {
  return await invokeCommand<{ request: string }, boolean>("db_cancel", { request });
}

/** The statements this data source ran, newest first. */
export async function dbHistory(id: string): Promise<HistoryEntry[]> {
  return await invokeCommand<{ id: string }, HistoryEntry[]>("db_history", { id });
}

/** Forgets statements of the history; all of them when `texts` is `null`. */
export async function dbRemoveHistory(id: string, texts: string[] | null): Promise<void> {
  await invokeCommand<{ id: string; texts: string[] | null }, void>("db_remove_history", {
    id,
    texts,
  });
}

/**
 * The databases of a PostgreSQL server. `id` is a connection target: the data
 * source itself, or `<id>:<database>` for one of its other databases.
 */
export async function dbDatabases(id: string): Promise<Databases> {
  return await invokeCommand<{ id: string }, Databases>("db_databases", { id });
}

/** The schemas of a connection target. */
export async function dbSchemas(id: string): Promise<string[]> {
  return await invokeCommand<{ id: string }, string[]>("db_schemas", { id });
}

/** The tables and views of `schema`. */
export async function dbTables(id: string, schema: string): Promise<TableInfo[]> {
  return await invokeCommand<{ id: string; schema: string }, TableInfo[]>("db_tables", {
    id,
    schema,
  });
}

/** Columns, indexes, foreign keys and triggers of `table`. */
export async function dbTableDetails(
  id: string,
  schema: string,
  table: string
): Promise<TableDetails> {
  return await invokeCommand<{ id: string; schema: string; table: string }, TableDetails>(
    "db_table_details",
    { id, schema, table }
  );
}

/** The routines and sequences of `schema`. */
export async function dbSchemaObjects(id: string, schema: string): Promise<SchemaObjects> {
  return await invokeCommand<{ id: string; schema: string }, SchemaObjects>("db_schema_objects", {
    id,
    schema,
  });
}

/** The `.sql` files of the query directory. */
export async function dbQueries(): Promise<QueryFile[]> {
  return await invokeCommand<Record<string, never>, QueryFile[]>("db_queries", {});
}

export async function dbQueryRead(name: string): Promise<string> {
  return await invokeCommand<{ name: string }, string>("db_query_read", { name });
}

export async function dbQueryWrite(name: string, text: string): Promise<void> {
  await invokeCommand<{ name: string; text: string }, void>("db_query_write", { name, text });
}

export async function dbQueryDelete(name: string): Promise<void> {
  await invokeCommand<{ name: string }, void>("db_query_delete", { name });
}

/** The tabs `source` had when its window last closed; `null` if it saved none. */
export async function dbWindowTabs(source: string): Promise<WindowTabs | null> {
  return await invokeCommand<{ source: string }, WindowTabs | null>("db_window_tabs", { source });
}

export async function dbSaveWindowTabs(tabs: WindowTabs): Promise<void> {
  await invokeCommand<{ tabs: WindowTabs }, void>("db_save_window_tabs", { tabs });
}

export async function dbSettings(): Promise<DbSettings> {
  return await invokeCommand<Record<string, never>, DbSettings>("db_settings", {});
}

export async function dbSaveSettings(settings: DbSettings): Promise<void> {
  await invokeCommand<{ settings: DbSettings }, void>("db_save_settings", { settings });
}

/** The execution plan of `statement`, as the tree the Plan tab renders. */
export async function dbExplain(id: string, statement: string): Promise<PlanNode[]> {
  return await invokeCommand<{ id: string; statement: string }, PlanNode[]>("db_explain", {
    id,
    statement,
  });
}
