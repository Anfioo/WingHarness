// The project page's database panel: its open/closed state, the project's data
// sources, one connection per source, the SQL and table tabs, and the text and
// results behind them.
//
// Unlike the database windows — one store per window, created by a React
// provider — there is exactly one project panel and it lives as long as the
// page, so this is a module-level singleton. Nothing it holds is persisted
// through `localStorage`: the data sources, the query files and the settings
// belong to the backend's project engine, and the tabs themselves are not
// restored across restarts by design.

import { create } from "zustand";

import {
  databaseErrorCode,
  dbConnect,
  dbConnectedTargets,
  dbDisconnect,
  dbFinishTransaction,
  dbProjectQueries,
  dbProjectQueryRead,
  dbProjectQueryWrite,
  dbProjectSaveSettings,
  dbProjectSettings,
  dbProjectSourceList,
  dbProjectSourceSave,
  dbSetManualCommit,
  dbSourceSetPassword,
  getConfig,
  projectRead,
  projectWrite,
  type DataSourceView,
  type DbSettings,
} from "@/commands";
import {
  asSource,
  clamp,
  CONSOLE_ROWS_MAX,
  CONSOLE_ROWS_MIN,
  DEFAULT_SETTINGS,
  emptyDoc,
  errorText,
  IDLE_CONNECTION,
  MAX_OUTPUT_LINES,
  MAX_RESULT_TABS,
  queryFileBase,
  TABLE_PAGE_SIZE_MAX,
  TABLE_PAGE_SIZE_MIN,
  type ConnectionState,
  type OutputLine,
  type QueryDoc,
  type ResultTab,
} from "@/pages/database/model";

/** How long a typed body waits before it is written to its file. */
const WRITE_DEBOUNCE_MS = 800;

/** What a tab is, before it is given an id. */
export type ProjectDbTabBody =
  | { kind: "query"; sourceId: string; file: string }
  | { kind: "sqlFile"; sourceId: string; path: string }
  | { kind: "table"; sourceId: string; target: string; schema: string; table: string };

export type ProjectDbTab = ProjectDbTabBody & { id: string };

/** A tab's identity. Deterministic, so opening the same file twice selects one tab. */
export function projectTabId(tab: ProjectDbTabBody): string {
  switch (tab.kind) {
    case "query":
      return `query:${tab.file}`;
    case "sqlFile":
      return `file:${tab.path}`;
    case "table":
      return `table:${tab.target}\u0000${tab.schema}\u0000${tab.table}`;
  }
}

function makeTab(body: ProjectDbTabBody): ProjectDbTab {
  return { ...body, id: projectTabId(body) };
}

/** A project path as codelet's URIs spell it: `/`-rooted. */
export function normalizeProjectPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** The tab a project `.sql` file opens as; `sql-extension.ts` has to agree. */
export function sqlFileTabId(path: string): string {
  return projectTabId({ kind: "sqlFile", sourceId: "", path: normalizeProjectPath(path) });
}

/** Whether a tab holds a SQL editor, as opposed to a table's data. */
export function isSqlTab(
  tab: ProjectDbTab
): tab is Extract<ProjectDbTab, { kind: "query" | "sqlFile" }> {
  return tab.kind === "query" || tab.kind === "sqlFile";
}

/** The label a database tab carries in the editor's tab strip. */
export function projectTabTitle(tab: ProjectDbTab): string {
  if (tab.kind === "query") return tab.file;
  if (tab.kind === "sqlFile") return tab.path.split("/").pop() ?? tab.path;
  return `${tab.schema}.${tab.table}`;
}

export type ProjectDbActions = {
  openPanel(): void;
  closePanel(): void;
  togglePanel(): void;
  openDock(): void;
  closeDock(): void;
  toggleDock(): void;
  loadSources(): Promise<void>;
  removeSource(sourceId: string): Promise<void>;
  connect(sourceId: string, password?: string): Promise<ConnectionState>;
  disconnect(sourceId: string): Promise<void>;
  setManualCommit(sourceId: string, manual: boolean): Promise<void>;
  finishTransaction(sourceId: string, commit: boolean): Promise<void>;
  openQuery(sourceId: string, file?: string): Promise<string | null>;
  openSqlFile(path: string, sourceId?: string): Promise<string | null>;
  openTable(sourceId: string, target: string, schema: string, table: string): string;
  select(tabId: string): void;
  close(tabId: string): void;
  setText(tabId: string, text: string): void;
  flush(tabId: string): Promise<void>;
  reloadFile(tabId: string): Promise<void>;
  overwriteFile(tabId: string): Promise<void>;
  setTabSource(tabId: string, sourceId: string): void;
  appendSql(sourceId: string, sql: string): Promise<void>;
  setResults(key: string, results: ResultTab[]): void;
  patchResult(key: string, id: number, patch: Partial<ResultTab>): void;
  removeResult(key: string, id: number): void;
  setActiveResult(key: string, id: number | "output"): void;
  appendOutput(key: string, line: Omit<OutputLine, "id" | "time"> & { time?: number }): void;
  clearOutput(key: string): void;
  setConsoleRows(rows: number): Promise<void>;
  setTablePageSize(size: number): Promise<void>;
  resetView(): void;
};

export type ProjectDbState = {
  panelOpen: boolean;
  dockOpen: boolean;
  sources: DataSourceView[];
  sourcesStatus: "idle" | "loading" | "ready" | "error";
  sourcesError: string | null;
  /** The project root is unset, so there is no project workspace to read. */
  noProject: boolean;
  connections: Record<string, ConnectionState>;
  manualCommits: Record<string, boolean>;
  pendingTx: Record<string, boolean>;
  settings: DbSettings;
  tabs: ProjectDbTab[];
  active: string | null;
  /** The SQL tab the results dock follows when `active` is a table. */
  lastSqlTab: string | null;
  /** The source a new SQL tab starts on. */
  lastSourceId: string | null;
  docs: Record<string, QueryDoc>;
  /** The tag a project `.sql` file was read or last written with. */
  etags: Record<string, string | null>;
  /** The file changed underneath and the write was refused. */
  conflicts: Record<string, boolean>;
  saving: Record<string, boolean>;
  results: Record<string, ResultTab[]>;
  outputs: Record<string, OutputLine[]>;
  activeResult: Record<string, number | "output">;
} & ProjectDbActions;

const INITIAL = {
  panelOpen: false,
  dockOpen: false,
  sources: [] as DataSourceView[],
  sourcesStatus: "idle" as "idle" | "loading" | "ready" | "error",
  sourcesError: null as string | null,
  noProject: false,
  connections: {} as Record<string, ConnectionState>,
  manualCommits: {} as Record<string, boolean>,
  pendingTx: {} as Record<string, boolean>,
  settings: DEFAULT_SETTINGS,
  tabs: [] as ProjectDbTab[],
  active: null as string | null,
  lastSqlTab: null as string | null,
  lastSourceId: null as string | null,
  docs: {} as Record<string, QueryDoc>,
  etags: {} as Record<string, string | null>,
  conflicts: {} as Record<string, boolean>,
  saving: {} as Record<string, boolean>,
  results: {} as Record<string, ResultTab[]>,
  outputs: {} as Record<string, OutputLine[]>,
  activeResult: {} as Record<string, number | "output">,
};

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
let outputSeq = 0;

/** The connection of a source that has none recorded yet. */
export function connectionOf(
  connections: Record<string, ConnectionState>,
  sourceId: string
): ConnectionState {
  return connections[sourceId] ?? IDLE_CONNECTION;
}

/** Whether the file on disk is no longer the one `etag` was read from. */
async function changedOnDisk(path: string, etag: string | null): Promise<boolean> {
  if (!etag) return false;
  try {
    const current = await projectRead(path);
    return (current.etag ?? null) !== etag;
  } catch {
    return false;
  }
}

export const useProjectDb = create<ProjectDbState>((set, get) => {
  const setDoc = (tabId: string, update: (doc: QueryDoc) => QueryDoc) => {
    set((state) => {
      const current = state.docs[tabId];
      if (!current) return {};
      return { docs: { ...state.docs, [tabId]: update(current) } };
    });
  };

  const setConnection = (sourceId: string, connection: ConnectionState) => {
    set((state) => ({ connections: { ...state.connections, [sourceId]: connection } }));
  };

  /** Appends the tab unless it is already open, then activates it. */
  const openTab = (tab: ProjectDbTab) => {
    set((state) =>
      state.tabs.some((current) => current.id === tab.id)
        ? { active: tab.id }
        : { tabs: [...state.tabs, tab], active: tab.id }
    );
    if (isSqlTab(tab)) set({ lastSqlTab: tab.id, lastSourceId: tab.sourceId });
  };

  /** Drops everything a closed tab owned. */
  const forget = (tabId: string) => {
    const timer = writeTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      writeTimers.delete(tabId);
    }
    set((state) => {
      const drop = <T>(record: Record<string, T>): Record<string, T> => {
        if (!(tabId in record)) return record;
        const next = { ...record };
        delete next[tabId];
        return next;
      };
      return {
        docs: drop(state.docs),
        etags: drop(state.etags),
        conflicts: drop(state.conflicts),
        saving: drop(state.saving),
        results: drop(state.results),
        outputs: drop(state.outputs),
        activeResult: drop(state.activeResult),
      };
    });
  };

  /** `<source name> <n>.sql`, the first number not taken. */
  const nextQueryName = async (sourceId: string): Promise<string> => {
    const name = get().sources.find((source) => source.id === sourceId)?.name;
    const base = name ? queryFileBase(name) : "query";
    const existing = new Set((await dbProjectQueries()).map((query) => query.name.toLowerCase()));
    let index = 1;
    while (existing.has(`${base} ${index}.sql`.toLowerCase())) index += 1;
    return `${base} ${index}.sql`;
  };

  return {
    ...INITIAL,

    openPanel: () => set({ panelOpen: true }),
    closePanel: () => set({ panelOpen: false }),
    togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
    openDock: () => set({ dockOpen: true }),
    closeDock: () => set({ dockOpen: false }),
    toggleDock: () => set((state) => ({ dockOpen: !state.dockOpen })),

    async loadSources() {
      set({ sourcesStatus: "loading", sourcesError: null });
      let noProject = false;
      try {
        noProject = !(await getConfig()).config.projectRoot;
      } catch (error) {
        set({ sourcesStatus: "error", sourcesError: errorText(error) });
        return;
      }
      if (noProject) {
        set({ noProject: true, sources: [], sourcesStatus: "ready" });
        return;
      }

      try {
        const [sources, settings] = await Promise.all([
          dbProjectSourceList(),
          dbProjectSettings().catch(() => DEFAULT_SETTINGS),
        ]);
        const connections: Record<string, ConnectionState> = {};
        for (const source of sources) {
          const previous = get().connections[source.id];
          // A connection the backend already holds is reported by the source
          // itself; anything else starts idle, unless a connect is in flight.
          connections[source.id] = source.connected
            ? { status: "connected", error: null, needsPassword: false }
            : previous?.status === "connecting"
              ? previous
              : IDLE_CONNECTION;
        }
        set({ noProject: false, sources, sourcesStatus: "ready", settings, connections });
      } catch (error) {
        set({ sourcesStatus: "error", sourcesError: errorText(error) });
      }
    },

    async removeSource(sourceId) {
      const next = get()
        .sources.filter((source) => source.id !== sourceId)
        .map(asSource);
      await dbProjectSourceSave(next);
      for (const tab of get().tabs.filter((entry) => entry.sourceId === sourceId)) {
        get().close(tab.id);
      }
      set((state) => {
        const connections = { ...state.connections };
        const manualCommits = { ...state.manualCommits };
        const pendingTx = { ...state.pendingTx };
        delete connections[sourceId];
        delete manualCommits[sourceId];
        delete pendingTx[sourceId];
        return {
          connections,
          manualCommits,
          pendingTx,
          lastSourceId: state.lastSourceId === sourceId ? null : state.lastSourceId,
        };
      });
      await get().loadSources();
    },

    async connect(sourceId, password) {
      const current = connectionOf(get().connections, sourceId);
      if (current.status === "connecting") return current;
      const finish = (state: ConnectionState): ConnectionState => {
        setConnection(sourceId, state);
        return state;
      };
      setConnection(sourceId, { status: "connecting", error: null, needsPassword: false });
      try {
        if (password) await dbSourceSetPassword(sourceId, password, false);
        await dbConnect(sourceId);
        const targets = await dbConnectedTargets();
        if (!targets.includes(sourceId)) {
          return finish({
            status: "error",
            error: "The connection is not open",
            needsPassword: false,
          });
        }
        set((state) => ({ pendingTx: { ...state.pendingTx, [sourceId]: false } }));
        return finish({ status: "connected", error: null, needsPassword: false });
      } catch (error) {
        return finish({
          status: "error",
          error: errorText(error),
          needsPassword: databaseErrorCode(error) === "auth-failed",
        });
      }
    },

    async disconnect(sourceId) {
      try {
        await dbDisconnect(sourceId);
        set((state) => ({
          connections: { ...state.connections, [sourceId]: IDLE_CONNECTION },
          manualCommits: { ...state.manualCommits, [sourceId]: false },
          pendingTx: { ...state.pendingTx, [sourceId]: false },
        }));
      } catch (error) {
        setConnection(sourceId, {
          status: "error",
          error: errorText(error),
          needsPassword: false,
        });
      }
    },

    async setManualCommit(sourceId, manual) {
      await dbSetManualCommit(sourceId, manual);
      set((state) => ({ manualCommits: { ...state.manualCommits, [sourceId]: manual } }));
    },

    async finishTransaction(sourceId, commit) {
      await dbFinishTransaction(sourceId, commit);
      set((state) => ({ pendingTx: { ...state.pendingTx, [sourceId]: false } }));
    },

    async openQuery(sourceId, file) {
      const name = file ?? (await nextQueryName(sourceId));
      const tab = makeTab({ kind: "query", sourceId, file: name });
      if (!get().docs[tab.id]) {
        try {
          // A query file is created empty; an existing one is read as it stands.
          const text = file ? await dbProjectQueryRead(name) : "";
          if (!file) await dbProjectQueryWrite(name, "");
          set((state) => ({ docs: { ...state.docs, [tab.id]: emptyDoc(name, text, null) } }));
        } catch (error) {
          set((state) => ({
            docs: { ...state.docs, [tab.id]: emptyDoc(name, "", errorText(error)) },
          }));
        }
      }
      openTab(tab);
      return tab.id;
    },

    async openSqlFile(path, sourceId) {
      // A project may hold `.sql` files before any data source is configured;
      // the tab still opens, and says so until one is picked.
      const source = sourceId ?? get().lastSourceId ?? get().sources[0]?.id ?? "";
      const normalized = normalizeProjectPath(path);
      const tab = makeTab({ kind: "sqlFile", sourceId: source, path: normalized });
      if (!get().docs[tab.id]) {
        try {
          const file = await projectRead(normalized);
          set((state) => ({
            docs: { ...state.docs, [tab.id]: emptyDoc(normalized, file.text, null) },
            etags: { ...state.etags, [tab.id]: file.etag ?? null },
          }));
        } catch (error) {
          set((state) => ({
            docs: { ...state.docs, [tab.id]: emptyDoc(normalized, "", errorText(error)) },
            etags: { ...state.etags, [tab.id]: null },
          }));
        }
      }
      openTab(tab);
      return tab.id;
    },

    openTable(sourceId, target, schema, table) {
      const tab = makeTab({ kind: "table", sourceId, target, schema, table });
      openTab(tab);
      return tab.id;
    },

    select(tabId) {
      const tab = get().tabs.find((entry) => entry.id === tabId);
      if (!tab) return;
      if (isSqlTab(tab)) set({ active: tabId, lastSqlTab: tabId, lastSourceId: tab.sourceId });
      else set({ active: tabId });
    },

    close(tabId) {
      const state = get();
      const index = state.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      // Text that has not reached its file yet still has to.
      if (state.docs[tabId]) void state.flush(tabId);

      const tabs = state.tabs.filter((tab) => tab.id !== tabId);
      const active =
        state.active === tabId
          ? tabs.length > 0
            ? tabs[Math.min(index, tabs.length - 1)].id
            : null
          : state.active;
      const lastSqlTab =
        state.lastSqlTab === tabId
          ? (tabs.find((tab) => isSqlTab(tab))?.id ?? null)
          : state.lastSqlTab;
      set({ tabs, active, lastSqlTab });
      forget(tabId);
    },

    setText(tabId, text) {
      setDoc(tabId, (doc) => ({ ...doc, text }));
      const pending = writeTimers.get(tabId);
      if (pending) clearTimeout(pending);
      writeTimers.set(
        tabId,
        setTimeout(() => {
          writeTimers.delete(tabId);
          void get().flush(tabId);
        }, WRITE_DEBOUNCE_MS)
      );
    },

    async flush(tabId) {
      const pending = writeTimers.get(tabId);
      if (pending) {
        clearTimeout(pending);
        writeTimers.delete(tabId);
      }
      const doc = get().docs[tabId];
      const tab = get().tabs.find((entry) => entry.id === tabId);
      if (!doc || !tab || doc.text === doc.savedText) return;
      const text = doc.text;
      set((state) => ({ saving: { ...state.saving, [tabId]: true } }));
      try {
        if (tab.kind === "query") {
          await dbProjectQueryWrite(doc.file, text);
          setDoc(tabId, (current) => ({ ...current, savedText: text, error: null }));
        } else {
          const etag = get().etags[tabId] ?? null;
          const written = await projectWrite(doc.file, text, etag ?? undefined);
          set((state) => ({
            etags: { ...state.etags, [tabId]: written.etag },
            conflicts: { ...state.conflicts, [tabId]: false },
          }));
          setDoc(tabId, (current) => ({ ...current, savedText: text, error: null }));
        }
      } catch (error) {
        // A refused `.sql` write is usually the file having changed underneath;
        // whether to reload or to write over it is the reader's call.
        const conflict =
          tab.kind === "sqlFile" && (await changedOnDisk(doc.file, get().etags[tabId] ?? null));
        set((state) => ({ conflicts: { ...state.conflicts, [tabId]: conflict } }));
        setDoc(tabId, (current) => ({ ...current, error: errorText(error) }));
      } finally {
        set((state) => ({ saving: { ...state.saving, [tabId]: false } }));
      }
    },

    async reloadFile(tabId) {
      const doc = get().docs[tabId];
      if (!doc) return;
      try {
        const file = await projectRead(doc.file);
        setDoc(tabId, () => emptyDoc(doc.file, file.text, null));
        set((state) => ({
          etags: { ...state.etags, [tabId]: file.etag ?? null },
          conflicts: { ...state.conflicts, [tabId]: false },
        }));
      } catch (error) {
        setDoc(tabId, (current) => ({ ...current, error: errorText(error) }));
      }
    },

    async overwriteFile(tabId) {
      const doc = get().docs[tabId];
      if (!doc) return;
      set((state) => ({ saving: { ...state.saving, [tabId]: true } }));
      try {
        const written = await projectWrite(doc.file, doc.text);
        set((state) => ({
          etags: { ...state.etags, [tabId]: written.etag },
          conflicts: { ...state.conflicts, [tabId]: false },
        }));
        setDoc(tabId, (current) => ({ ...current, savedText: current.text, error: null }));
      } catch (error) {
        setDoc(tabId, (current) => ({ ...current, error: errorText(error) }));
      } finally {
        set((state) => ({ saving: { ...state.saving, [tabId]: false } }));
      }
    },

    setTabSource(tabId, sourceId) {
      set((state) => ({
        tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, sourceId } : tab)),
        lastSourceId: sourceId,
        // The results of one server mean nothing against another.
        results: { ...state.results, [tabId]: [] },
        activeResult: { ...state.activeResult, [tabId]: "output" },
      }));
    },

    async appendSql(sourceId, sql) {
      const state = get();
      // The statement belongs to the source it was generated for: a SQL tab of
      // that source wins over whichever tab happens to be in front.
      const open =
        state.tabs.find((tab) => isSqlTab(tab) && tab.sourceId === sourceId) ??
        state.tabs.find((tab) => isSqlTab(tab) && tab.id === state.active);
      const tabId = open?.id ?? (await get().openQuery(sourceId));
      if (!tabId) return;
      const doc = get().docs[tabId];
      if (!doc) return;
      const text = doc.text.trim().length === 0 ? sql : `${doc.text.trimEnd()}\n\n${sql}`;
      get().setText(tabId, text);
      await get().flush(tabId);
    },

    setResults(key, results) {
      const kept = results.slice(-MAX_RESULT_TABS);
      set((state) => {
        const active = state.activeResult[key];
        const found = typeof active === "number" && kept.some((result) => result.id === active);
        return {
          results: { ...state.results, [key]: kept },
          activeResult: {
            ...state.activeResult,
            [key]: found ? active : (kept[0]?.id ?? "output"),
          },
        };
      });
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
      set((state) => ({
        outputs: {
          ...state.outputs,
          [key]: [...(state.outputs[key] ?? []), entry].slice(-MAX_OUTPUT_LINES),
        },
      }));
    },

    clearOutput(key) {
      set((state) => ({ outputs: { ...state.outputs, [key]: [] } }));
    },

    async setConsoleRows(rows) {
      const previous = get().settings;
      const settings = {
        ...previous,
        consoleRows: clamp(rows, CONSOLE_ROWS_MIN, CONSOLE_ROWS_MAX),
      };
      set({ settings });
      try {
        await dbProjectSaveSettings(settings);
      } catch {
        set({ settings: previous });
      }
    },

    async setTablePageSize(size) {
      const previous = get().settings;
      const settings = {
        ...previous,
        tablePageSize: clamp(size, TABLE_PAGE_SIZE_MIN, TABLE_PAGE_SIZE_MAX),
      };
      set({ settings });
      try {
        await dbProjectSaveSettings(settings);
      } catch {
        set({ settings: previous });
      }
    },

    resetView() {
      // Whatever is still unwritten goes to its file before the tabs go.
      for (const [tabId, doc] of Object.entries(get().docs)) {
        if (doc.text !== doc.savedText) void get().flush(tabId);
      }
      set({
        panelOpen: false,
        dockOpen: false,
        tabs: [],
        active: null,
        lastSqlTab: null,
        docs: {},
        etags: {},
        conflicts: {},
        saving: {},
        results: {},
        outputs: {},
        activeResult: {},
      });
      for (const timer of writeTimers.values()) clearTimeout(timer);
      writeTimers.clear();
    },
  };
});

/** The tab the results dock shows: the active one when it is SQL, else the last one. */
export function dockTab(state: ProjectDbState): ProjectDbTab | null {
  const active = state.tabs.find((tab) => tab.id === state.active);
  if (active && isSqlTab(active)) return active;
  return state.tabs.find((tab) => tab.id === state.lastSqlTab) ?? null;
}
