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
  DataSource,
  DataSourceView,
  Databases,
  HistoryEntry,
  QueryResult,
  SchemaObjects,
  TableDetails,
  TableInfo,
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
 * Runs one statement. `request` identifies it for `dbCancel`; `skip` and
 * `maxRows` select a window of the result.
 */
export async function dbExecute(
  request: string,
  id: string,
  statement: string,
  skip = 0,
  maxRows = 500
): Promise<QueryResult> {
  return await invokeCommand<
    { request: string; id: string; statement: string; skip: number; maxRows: number },
    QueryResult
  >("db_execute", { request, id, statement, skip, maxRows });
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
