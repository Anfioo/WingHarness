// DTOs and error discrimination for the database tools.
//
// Mirrors `db-core/src/source.rs`, `conn.rs`, `history.rs` and `error.rs`.
// Every field is camelCase on the wire. Passwords are never part of a DTO: they
// travel separately through `db_set_password`, and the list only reports
// whether a saved one exists.

/** The wire protocol a data source speaks. */
export type DbDriver = "sqlite" | "postgres" | "mysql" | "sqlServer" | "clickhouse" | "oracle";

/** TLS mode of a connection. `prefer` is what every driver defaults to. */
export type DbSslMode = "disable" | "prefer" | "require" | "verifyCa" | "verifyFull";

/** IDEA's data source colours, used for the tree tint and the console tab. */
export type DbColor = "red" | "orange" | "yellow" | "green" | "blue" | "violet";

/** Whether a console commits each statement or waits for the user. */
export type DbTxMode = "auto" | "manual";

/** Session settings applied to every connection of a data source. */
export type DbOptions = {
  transaction: DbTxMode;
  /** PostgreSQL `search_path`. */
  defaultSchema: string;
  /** Session time zone; empty keeps the server default. */
  timeZone: string;
  /** Statements run on every new connection. */
  startupScript: string;
  keepAliveSecs: number | null;
  autoDisconnectSecs: number | null;
  /** PostgreSQL: show only the configured database, its schemas under the source. */
  singleDatabase: boolean;
  /** Oracle: directory of the Oracle Instant Client. */
  instantClient: string;
};

/** Which databases and schemas the object tree shows. */
export type DbIntrospection = {
  allDatabases: boolean;
  /** Names may use `*` and `?`. */
  databases: string[];
  allSchemas: boolean;
  schemas: string[];
  showSystem: boolean;
  showTemplates: boolean;
  /** Object filter patterns, separated by commas or spaces; empty shows all. */
  objectFilter: string;
};

/** One driver property of the Advanced tab. */
export type DbProperty = {
  name: string;
  value: string;
};

/** A stored data source. Never carries a password. */
export type DataSource = {
  id: string;
  name: string;
  driver: DbDriver;
  host: string;
  port: number | null;
  database: string;
  user: string;
  /** SQLite database file: absolute, or relative to the project root. */
  file: string | null;
  ssl: DbSslMode;
  /** Keep the password in the saved passwords. */
  savePassword: boolean;
  readOnly: boolean;
  /** Wire-compatible product preset (`cockroachdb`, `tidb`…); empty means the driver itself. */
  vendor: string;
  color: DbColor | null;
  comment: string;
  /** Connect with `url` instead of host / port / database. */
  urlOnly: boolean;
  url: string;
  /** PEM files; `~/` is the home directory. */
  sslCaFile: string;
  sslCertFile: string;
  sslKeyFile: string;
  options: DbOptions;
  introspection: DbIntrospection;
  properties: DbProperty[];
  /** Stored app-wide and listed in every project. */
  global: boolean;
};

/** A data source as the list shows it. */
export type DataSourceView = DataSource & {
  /** A pool for it is open. */
  connected: boolean;
  /** A password is stored and will be used without asking. */
  hasSavedPassword: boolean;
};

/** One column of a result set. */
export type ResultColumn = {
  name: string;
  typeName: string;
};

/** What one statement produced. */
export type QueryResult = {
  statement: string;
  columns: ResultColumn[];
  /** Cell text; `null` is SQL NULL. Binary values are `0x…` hex. */
  rows: (string | null)[][];
  /** Rows changed by a DML statement; `null` for queries. */
  affected: number | null;
  hasMore: boolean;
  elapsedMs: number;
  /** Until the server's first answer; the rest of `elapsedMs` is fetching. */
  executionMs: number;
};

/** What a catalog row calls a relation. */
export type DbTableKind = "table" | "view" | "materializedView";

/** Schema objects other than tables and columns. */
export type DbObjectKind = "function" | "procedure" | "trigger" | "sequence";

/** A table, view or materialized view of a schema. */
export type TableInfo = {
  name: string;
  kind: DbTableKind;
};

/** One column of a table. */
export type ColumnInfo = {
  name: string;
  dataType: string;
  nullable: boolean;
  /** Default expression; `null` when there is none. */
  default: string | null;
  primaryKey: boolean;
};

/** One index; the columns are in index order. */
export type IndexInfo = {
  name: string;
  unique: boolean;
  columns: string[];
};

/** A foreign key, one entry per constraint (composite keys included). */
export type ForeignKey = {
  schema: string;
  table: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
};

/** A trigger of a table. */
export type TriggerInfo = {
  name: string;
  /** `before`, `after`, `instead of`. */
  timing: string;
  /** `insert`, `update or delete`… */
  events: string;
};

/** Columns, indexes, foreign keys and triggers of a table. */
export type TableDetails = {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKey[];
  triggers: TriggerInfo[];
};

/** A function or procedure of a schema. */
export type RoutineInfo = {
  name: string;
  kind: DbObjectKind;
  arguments: string;
  /** Result type of a function; `null` for a procedure. */
  returns: string | null;
};

/** A sequence of a schema. */
export type SequenceInfo = {
  name: string;
  dataType: string;
};

/** The routines and sequences of a schema. */
export type SchemaObjects = {
  routines: RoutineInfo[];
  sequences: SequenceInfo[];
};

/** The databases of a server; `current` is the one the data source connects to. */
export type Databases = {
  current: string;
  names: string[];
};

/** One statement of a script, with its UTF-16 offsets in the editor text. */
export type SqlStatement = {
  from: number;
  to: number;
  text: string;
};

/** One `ORDER BY` term of a table page. */
export type SortKey = {
  column: string;
  descending: boolean;
};

/** One column of a row edit: the value to write, or part of the row key. */
export type CellValue = {
  column: string;
  /** `null` is SQL NULL. */
  value: string | null;
};

/** One pending change of a table editor. */
export type DbRowEdit =
  | { kind: "update"; key: CellValue[]; values: CellValue[] }
  | { kind: "insert"; values: CellValue[] }
  | { kind: "delete"; key: CellValue[] };

/** One page of a table, with the metadata the editor renders it from. */
export type TablePage = {
  result: QueryResult;
  details: TableDetails;
  offset: number;
};

/** One column of the completion model. */
export type CompletionColumn = {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  hasDefault: boolean;
};

/** One relation of the completion model. */
export type CompletionTable = {
  schema: string;
  name: string;
  kind: DbTableKind;
  columns: CompletionColumn[];
};

/** Everything the SQL editor completes names from, fetched once per connection. */
export type CompletionModel = {
  defaultSchema: string;
  tables: CompletionTable[];
  foreignKeys: ForeignKey[];
};

/** What one statement of a batch produced; `error` stays per statement. */
export type StatementOutcome = {
  statement: SqlStatement;
  result: QueryResult | null;
  error: DatabaseError | null;
};

/** One statement of a data source's history. */
export type HistoryEntry = {
  text: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
};

/** Stable categories the frontend branches on. */
export type DatabaseErrorCode =
  | "not-found"
  | "invalid"
  | "auth-failed"
  | "unreachable"
  | "cancelled"
  | "protocol"
  | "internal";

/** What a rejected command throws. `message` is English and never contains a password. */
export type DatabaseError = {
  code: DatabaseErrorCode;
  message: string;
};

/** The default settings of a new data source, mirroring `DataSource::default()`. */
export function emptyDataSource(): DataSource {
  return {
    id: crypto.randomUUID(),
    name: "",
    driver: "sqlite",
    host: "localhost",
    port: null,
    database: "",
    user: "",
    file: null,
    ssl: "prefer",
    savePassword: false,
    readOnly: false,
    vendor: "",
    color: null,
    comment: "",
    urlOnly: false,
    url: "",
    sslCaFile: "",
    sslCertFile: "",
    sslKeyFile: "",
    options: {
      transaction: "auto",
      defaultSchema: "",
      timeZone: "",
      startupScript: "",
      keepAliveSecs: null,
      autoDisconnectSecs: null,
      singleDatabase: false,
      instantClient: "",
    },
    introspection: {
      allDatabases: true,
      databases: [],
      allSchemas: true,
      schemas: [],
      showSystem: false,
      showTemplates: false,
      objectFilter: "",
    },
    properties: [],
    global: false,
  };
}

/** The default port of a driver, or `null` for SQLite. */
export function defaultPort(driver: DbDriver): number | null {
  switch (driver) {
    case "sqlite":
      return null;
    case "postgres":
      return 5432;
    case "mysql":
      return 3306;
    case "sqlServer":
      return 1433;
    case "clickhouse":
      return 8123;
    case "oracle":
      return 1521;
  }
}

/**
 * Whether `value` is a rejected database command. Tauri hands a command's
 * `Err` payload over as-is, so the shape is the Rust `DbError`.
 */
export function isDatabaseError(value: unknown): value is DatabaseError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DatabaseError>;
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

/** The error code of a rejection, or `null` when it was not one. */
export function databaseErrorCode(value: unknown): DatabaseErrorCode | null {
  return isDatabaseError(value) ? value.code : null;
}
