// The shapes and small helpers the database page and the project page's
// database panel share.
//
// Both have their own store — one per data source window, one per project —
// but a query document, a result tab and a console line mean the same thing in
// both, and keeping one definition is what lets the editor, the result views
// and the object tree be reused as-is.

import {
  isDatabaseError,
  type DataSource,
  type DataSourceView,
  type DbSettings,
  type PlanNode,
  type SqlStatement,
  type StatementOutcome,
} from "@/commands";

export type DatabaseTab =
  | { kind: "query"; file: string }
  | { kind: "table"; target: string; schema: string; table: string };

export type QueryDoc = {
  file: string;
  text: string;
  savedText: string;
  loading: boolean;
  error: string | null;
};

export type OutputLine = {
  id: number;
  time: number;
  kind: "info" | "statement" | "result" | "error";
  text: string;
};

export type ResultTab = {
  id: number;
  title: string;
  /** The statement that produced this tab (a plan tab carries the explained statement). */
  statement: SqlStatement;
  /** `null` for a plan tab: it has no result set. */
  outcome: StatementOutcome | null;
  /** `null` for a result tab; non-null for a plan tab. */
  plan: PlanNode[] | null;
  page: number;
  pageSize: number;
  total: number | null;
  busy: boolean;
};

export type ConnectionState = {
  status: "idle" | "connecting" | "connected" | "error";
  error: string | null;
  needsPassword: boolean;
};

export const DEFAULT_SETTINGS: DbSettings = { version: 1, consoleRows: 500, tablePageSize: 500 };
export const CONSOLE_ROWS_MIN = 100;
export const CONSOLE_ROWS_MAX = 50_000;
export const TABLE_PAGE_SIZE_MIN = 100;
export const TABLE_PAGE_SIZE_MAX = 5_000;
/** The newest result tabs kept; older ones are dropped. */
export const MAX_RESULT_TABS = 12;
/** The newest output lines kept per tab. */
export const MAX_OUTPUT_LINES = 2_000;

export const IDLE_CONNECTION: ConnectionState = {
  status: "idle",
  error: null,
  needsPassword: false,
};

/** A tab's stable identity; the same rule `windows.json` records are read back with. */
export function tabKey(tab: DatabaseTab): string {
  return tab.kind === "query"
    ? `query:${tab.file}`
    : `table:${tab.target}\u0000${tab.schema}\u0000${tab.table}`;
}

/** The English text of a rejected command, whatever shape it arrived in. */
export function errorText(error: unknown): string {
  if (isDatabaseError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A data source name as a file name on every platform the app targets. */
export function queryFileBase(name: string): string {
  const cleaned = Array.from(name)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f && !`\\/:*?"<>|`.includes(char);
    })
    .join("")
    .trim()
    .replace(/[. ]+$/, "");
  return cleaned || "query";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function emptyDoc(file: string, text: string, error: string | null): QueryDoc {
  return { file, text, savedText: error ? "" : text, loading: false, error };
}

/** The view carries two fields the stored settings do not; drop them on save. */
export function asSource(view: DataSourceView): DataSource {
  const source = { ...view } as Partial<DataSourceView>;
  delete source.connected;
  delete source.hasSavedPassword;
  return source as DataSource;
}
