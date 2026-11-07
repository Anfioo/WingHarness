// The state of one data source window: its tabs, the query documents behind
// them, the result tabs and console output of each tab, the row limits and the
// connection.
//
// A store instance belongs to one window, so it is created by
// `DatabaseStoreProvider` rather than existing once per module: two windows on
// two data sources must never share tabs. Everything that needs to survive a
// restart goes through the commands (`windows.json`, `settings.json` and the
// query files); nothing is kept in `localStorage`.

import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { useStore, type StoreApi } from "zustand";
import { createStore } from "zustand/vanilla";

import {
  databaseErrorCode,
  dbConnect,
  dbConnectedTargets,
  dbDisconnect,
  dbFinishTransaction,
  dbQueries,
  dbQueryRead,
  dbQueryWrite,
  dbSaveSettings,
  dbSaveWindowTabs,
  dbSettings,
  dbSourceList,
  dbSourceSetPassword,
  dbSetManualCommit,
  dbWindowTabs,
  isDatabaseError,
  type DbSettings,
  type PlanNode,
  type SqlStatement,
  type StatementOutcome,
  type TabRecord,
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

export type DatabaseActions = {
  hydrate(): Promise<void>;
  openQuery(file?: string): Promise<void>;
  openTable(target: string, schema: string, table: string): void;
  select(key: string): void;
  close(key: string): void;
  reopenClosed(): Promise<void>;
  setQueryText(file: string, text: string): void;
  flushQuery(file: string): Promise<void>;
  connect(password?: string): Promise<void>;
  disconnect(): Promise<void>;
  setManualCommit(manual: boolean): Promise<void>;
  finishTransaction(commit: boolean): Promise<void>;
  setConsoleRows(rows: number): Promise<void>;
  setTablePageSize(size: number): Promise<void>;
  setResults(key: string, results: ResultTab[]): void;
  patchResult(key: string, id: number, patch: Partial<ResultTab>): void;
  removeResult(key: string, id: number): void;
  setActiveResult(key: string, id: number | "output"): void;
  appendOutput(key: string, line: Omit<OutputLine, "id" | "time"> & { time?: number }): void;
  clearOutput(key: string): void;
};

export type DatabaseState = {
  sourceId: string;
  hydrated: boolean;
  tabs: DatabaseTab[];
  active: string | null;
  closed: DatabaseTab[];
  queries: Record<string, QueryDoc>;
  results: Record<string, ResultTab[]>;
  activeResult: Record<string, number | "output">;
  outputs: Record<string, OutputLine[]>;
  settings: DbSettings;
  connection: ConnectionState;
  manualCommit: boolean;
  pendingTx: boolean;
} & DatabaseActions;

/** A tab's stable identity; the same rule `windows.json` records are read back with. */
export function tabKey(tab: DatabaseTab): string {
  return tab.kind === "query"
    ? `query:${tab.file}`
    : `table:${tab.target}\u0000${tab.schema}\u0000${tab.table}`;
}

const DEFAULT_SETTINGS: DbSettings = { version: 1, consoleRows: 500, tablePageSize: 500 };
const CONSOLE_ROWS_MIN = 100;
const CONSOLE_ROWS_MAX = 50_000;
const TABLE_PAGE_SIZE_MIN = 100;
const TABLE_PAGE_SIZE_MAX = 5_000;
/** How long a typed query body waits before it is written to its file. */
const QUERY_WRITE_DEBOUNCE_MS = 800;
/** How long a tab change waits before `windows.json` is written. */
const TABS_DEBOUNCE_MS = 300;
/** The newest result tabs kept; older ones are dropped. */
const MAX_RESULT_TABS = 12;
/** The newest output lines kept per tab. */
const MAX_OUTPUT_LINES = 2_000;
/** The closed tabs that can still be reopened. */
const MAX_CLOSED_TABS = 20;

const IDLE_CONNECTION: ConnectionState = { status: "idle", error: null, needsPassword: false };

/** The English text of a rejected command, whatever shape it arrived in. */
function errorText(error: unknown): string {
  if (isDatabaseError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A data source name as a file name on every platform the app targets. */
function queryFileBase(name: string): string {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function toRecord(tab: DatabaseTab): TabRecord {
  return tab.kind === "query"
    ? { kind: "query", file: tab.file }
    : { kind: "table", target: tab.target, schema: tab.schema, table: tab.table };
}

function emptyDoc(file: string, text: string, error: string | null): QueryDoc {
  return { file, text, savedText: error ? "" : text, loading: false, error };
}

/** Drops stored tabs whose query file is gone, and duplicates from an older run. */
function restoreTabs(records: TabRecord[], existing: Set<string>): DatabaseTab[] {
  const seen = new Set<string>();
  const tabs: DatabaseTab[] = [];
  for (const record of records) {
    if (record.kind === "query" && !existing.has(record.file)) continue;
    const tab: DatabaseTab =
      record.kind === "query"
        ? { kind: "query", file: record.file }
        : { kind: "table", target: record.target, schema: record.schema, table: record.table };
    const key = tabKey(tab);
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push(tab);
  }
  return tabs;
}

export function createDatabaseStore(sourceId: string): StoreApi<DatabaseState> {
  const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let tabsTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPersisted = "";
  let hydrated = false;
  let outputSeq = 0;

  const store = createStore<DatabaseState>()((set, get) => {
    /** Writes the tab set, unless it is the one already on disk. */
    const persistTabs = async () => {
      if (!hydrated) return;
      const state = get();
      const record = {
        source: sourceId,
        tabs: state.tabs.map(toRecord),
        active: state.active,
      };
      const signature = JSON.stringify(record);
      if (signature === lastPersisted) return;
      lastPersisted = signature;
      try {
        await dbSaveWindowTabs(record);
      } catch {
        // The next tab change retries: a failed save must not break the window.
        lastPersisted = "";
      }
    };

    const schedulePersist = () => {
      if (!hydrated) return;
      if (tabsTimer) clearTimeout(tabsTimer);
      tabsTimer = setTimeout(() => {
        tabsTimer = null;
        void persistTabs();
      }, TABS_DEBOUNCE_MS);
    };

    /** Makes `key` the active tab; the key must name an open tab. */
    const activate = (key: string) => {
      set((state) => (state.tabs.some((tab) => tabKey(tab) === key) ? { active: key } : {}));
    };

    /** Appends the tab unless it is already open, then activates it. */
    const openTab = (tab: DatabaseTab) => {
      const key = tabKey(tab);
      set((state) =>
        state.tabs.some((current) => tabKey(current) === key)
          ? { active: key }
          : { tabs: [...state.tabs, tab], active: key }
      );
      schedulePersist();
    };

    const setDoc = (file: string, update: (doc: QueryDoc) => QueryDoc) => {
      set((state) => {
        const current = state.queries[file];
        if (!current) return {};
        return { queries: { ...state.queries, [file]: update(current) } };
      });
    };

    const persistSettings = async (settings: DbSettings) => {
      set({ settings });
      await dbSaveSettings(settings);
    };

    return {
      sourceId,
      hydrated: false,
      tabs: [],
      active: null,
      closed: [],
      queries: {},
      results: {},
      activeResult: {},
      outputs: {},
      settings: DEFAULT_SETTINGS,
      connection: IDLE_CONNECTION,
      manualCommit: false,
      pendingTx: false,

      async hydrate() {
        let settings = DEFAULT_SETTINGS;
        try {
          settings = await dbSettings();
        } catch {
          // A workspace whose settings file cannot be read still opens.
        }

        let storedTabs: TabRecord[] = [];
        let storedActive: string | null = null;
        try {
          const window = await dbWindowTabs(sourceId);
          if (window) {
            storedTabs = window.tabs;
            storedActive = window.active;
          }
        } catch {
          // No tab record yet, or a corrupt one: start with an empty window.
        }

        let files: string[] = [];
        try {
          files = (await dbQueries()).map((file) => file.name);
        } catch {
          // Without the listing no query tab can be trusted; none is restored.
        }

        const tabs = restoreTabs(storedTabs, new Set(files));
        const queries: Record<string, QueryDoc> = {};
        for (const tab of tabs) {
          if (tab.kind !== "query" || queries[tab.file]) continue;
          try {
            const text = await dbQueryRead(tab.file);
            queries[tab.file] = emptyDoc(tab.file, text, null);
          } catch (error) {
            queries[tab.file] = emptyDoc(tab.file, "", errorText(error));
          }
        }

        const active =
          storedActive && tabs.some((tab) => tabKey(tab) === storedActive)
            ? storedActive
            : tabs.length > 0
              ? tabKey(tabs[0])
              : null;

        set({
          hydrated: true,
          tabs,
          active,
          closed: [],
          queries,
          settings,
        });
        hydrated = true;
        lastPersisted = JSON.stringify({
          source: sourceId,
          tabs: tabs.map(toRecord),
          active,
        });

        try {
          const targets = await dbConnectedTargets();
          set({
            connection: targets.includes(sourceId)
              ? { status: "connected", error: null, needsPassword: false }
              : IDLE_CONNECTION,
          });
        } catch {
          // The connection state stays idle; `connect` reports the real error.
        }
      },

      async openQuery(file) {
        if (file) {
          const doc = get().queries[file];
          if (!doc) {
            const text = await dbQueryRead(file);
            set((state) => ({ queries: { ...state.queries, [file]: emptyDoc(file, text, null) } }));
          }
          openTab({ kind: "query", file });
          return;
        }

        let base = "query";
        try {
          const sources = await dbSourceList();
          base = queryFileBase(sources.find((source) => source.id === sourceId)?.name ?? base);
        } catch {
          // The default name is still a valid file name.
        }

        const existing = new Set((await dbQueries()).map((query) => query.name.toLowerCase()));
        let index = 1;
        while (existing.has(`${base} ${index}.sql`.toLowerCase())) index += 1;
        const name = `${base} ${index}.sql`;

        await dbQueryWrite(name, "");
        set((state) => ({ queries: { ...state.queries, [name]: emptyDoc(name, "", null) } }));
        openTab({ kind: "query", file: name });
      },

      openTable(target, schema, table) {
        openTab({ kind: "table", target, schema, table });
      },

      select(key) {
        activate(key);
        schedulePersist();
      },

      close(key) {
        const state = get();
        const index = state.tabs.findIndex((tab) => tabKey(tab) === key);
        if (index < 0) return;
        const tab = state.tabs[index];

        // A query's pending text has to reach its file before the doc is dropped.
        if (tab.kind === "query") void get().flushQuery(tab.file);

        const tabs = state.tabs.filter((current) => tabKey(current) !== key);
        const active =
          state.active === key
            ? tabs.length > 0
              ? tabKey(tabs[Math.min(index, tabs.length - 1)])
              : null
            : state.active;

        const closed = [...state.closed, tab].slice(-MAX_CLOSED_TABS);
        const results = { ...state.results };
        const activeResult = { ...state.activeResult };
        const outputs = { ...state.outputs };
        delete results[key];
        delete activeResult[key];
        delete outputs[key];

        set({ tabs, active, closed, results, activeResult, outputs });
        schedulePersist();
      },

      async reopenClosed() {
        while (true) {
          const state = get();
          const tab = state.closed[state.closed.length - 1];
          if (!tab) return;
          const rest = state.closed.slice(0, -1);
          set({ closed: rest });

          const key = tabKey(tab);
          if (state.tabs.some((current) => tabKey(current) === key)) continue;

          if (tab.kind === "query" && !state.queries[tab.file]) {
            try {
              const text = await dbQueryRead(tab.file);
              set((current) => ({
                queries: { ...current.queries, [tab.file]: emptyDoc(tab.file, text, null) },
              }));
            } catch {
              // The file was removed since it was closed: skip this tab.
              continue;
            }
          }

          openTab(tab);
          return;
        }
      },

      setQueryText(file, text) {
        setDoc(file, (doc) => ({ ...doc, text }));
        const pending = writeTimers.get(file);
        if (pending) clearTimeout(pending);
        writeTimers.set(
          file,
          setTimeout(() => {
            writeTimers.delete(file);
            void get().flushQuery(file);
          }, QUERY_WRITE_DEBOUNCE_MS)
        );
      },

      async flushQuery(file) {
        const pending = writeTimers.get(file);
        if (pending) {
          clearTimeout(pending);
          writeTimers.delete(file);
        }
        const doc = get().queries[file];
        if (!doc || doc.text === doc.savedText) return;
        const text = doc.text;
        try {
          await dbQueryWrite(file, text);
          setDoc(file, (current) => ({ ...current, savedText: text, error: null }));
        } catch (error) {
          setDoc(file, (current) => ({ ...current, error: errorText(error) }));
        }
      },

      async connect(password) {
        if (get().connection.status === "connecting") return;
        set({ connection: { status: "connecting", error: null, needsPassword: false } });
        try {
          if (password) await dbSourceSetPassword(sourceId, password, false);
          await dbConnect(sourceId);
          const targets = await dbConnectedTargets();
          if (!targets.includes(sourceId)) {
            set({
              connection: {
                status: "error",
                error: "The connection is not open",
                needsPassword: false,
              },
            });
            return;
          }
          set({
            connection: { status: "connected", error: null, needsPassword: false },
            pendingTx: false,
          });
        } catch (error) {
          set({
            connection: {
              status: "error",
              error: errorText(error),
              needsPassword: databaseErrorCode(error) === "auth-failed",
            },
          });
        }
      },

      async disconnect() {
        try {
          await dbDisconnect(sourceId);
          set({ connection: IDLE_CONNECTION, manualCommit: false, pendingTx: false });
        } catch (error) {
          set({
            connection: { status: "error", error: errorText(error), needsPassword: false },
          });
        }
      },

      async setManualCommit(manual) {
        await dbSetManualCommit(sourceId, manual);
        set({ manualCommit: manual });
      },

      async finishTransaction(commit) {
        await dbFinishTransaction(sourceId, commit);
        set({ pendingTx: false });
      },

      async setConsoleRows(rows) {
        const settings = {
          ...get().settings,
          consoleRows: clamp(rows, CONSOLE_ROWS_MIN, CONSOLE_ROWS_MAX),
        };
        await persistSettings(settings);
      },

      async setTablePageSize(size) {
        const settings = {
          ...get().settings,
          tablePageSize: clamp(size, TABLE_PAGE_SIZE_MIN, TABLE_PAGE_SIZE_MAX),
        };
        await persistSettings(settings);
      },

      setResults(key, results) {
        const kept = results.slice(-MAX_RESULT_TABS);
        const active = get().activeResult[key];
        const found = typeof active === "number" && kept.some((result) => result.id === active);
        set((state) => ({
          results: { ...state.results, [key]: kept },
          activeResult: {
            ...state.activeResult,
            [key]: found ? active : (kept[0]?.id ?? "output"),
          },
        }));
      },

      patchResult(key, id, patch) {
        set((state) => {
          const results = state.results[key];
          if (!results) return {};
          return {
            results: {
              ...state.results,
              [key]: results.map((result) => (result.id === id ? { ...result, ...patch } : result)),
            },
          };
        });
      },

      removeResult(key, id) {
        set((state) => {
          const results = state.results[key];
          if (!results) return {};
          const kept = results.filter((result) => result.id !== id);
          const active = state.activeResult[key];
          const next =
            active === id || !kept.some((result) => result.id === active)
              ? (kept[0]?.id ?? "output")
              : active;
          return {
            results: { ...state.results, [key]: kept },
            activeResult: { ...state.activeResult, [key]: next },
          };
        });
      },

      setActiveResult(key, id) {
        set((state) => ({ activeResult: { ...state.activeResult, [key]: id } }));
      },

      appendOutput(key, line) {
        outputSeq += 1;
        const entry: OutputLine = { ...line, id: outputSeq, time: line.time ?? Date.now() };
        set((state) => {
          const lines = [...(state.outputs[key] ?? []), entry].slice(-MAX_OUTPUT_LINES);
          return { outputs: { ...state.outputs, [key]: lines } };
        });
      },

      clearOutput(key) {
        set((state) => ({ outputs: { ...state.outputs, [key]: [] } }));
      },
    };
  });

  return store;
}

const DatabaseStoreContext = createContext<StoreApi<DatabaseState> | null>(null);

/** Creates one store per `sourceId`; a different data source gets a new store. */
export function DatabaseStoreProvider(props: { sourceId: string; children: ReactNode }): ReactNode {
  const store = useMemo(() => createDatabaseStore(props.sourceId), [props.sourceId]);
  return createElement(DatabaseStoreContext.Provider, { value: store }, props.children);
}

export function useDatabaseStore<T>(selector: (state: DatabaseState) => T): T {
  const store = useContext(DatabaseStoreContext);
  if (!store) throw new Error("useDatabaseStore must be used inside DatabaseStoreProvider");
  return useStore(store, selector);
}

/** Readable alias for `useDatabaseStore`. */
export const useDatabaseSelector = useDatabaseStore;
