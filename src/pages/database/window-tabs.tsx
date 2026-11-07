import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** One tab of a data source window: the fixed console, or one table. */
export type DatabaseTab =
  | { kind: "console" }
  | { kind: "table"; target: string; schema: string; table: string };

/** The tab a window falls back to; it cannot be closed. */
const CONSOLE_KEY = "console";
const CONSOLE_TAB: DatabaseTab = { kind: "console" };

/**
 * The key of a tab. The console is a singleton; a table is keyed by the
 * connection target as well as its name, so the same table of another
 * PostgreSQL database opens its own tab.
 */
export function tabKey(tab: DatabaseTab): string {
  return tab.kind === "console"
    ? CONSOLE_KEY
    : ["table", tab.target, tab.schema, tab.table].join("\u0000");
}

type DatabaseTabsValue = {
  tabs: DatabaseTab[];
  active: string;
  select(key: string): void;
  openConsole(): void;
  openTable(target: string, schema: string, table: string): void;
  close(key: string): void;
};

const DatabaseTabsContext = createContext<DatabaseTabsValue | null>(null);

/**
 * Holds the tabs of one data source window. Nothing is persisted or shared
 * between windows: closing the window loses its tabs.
 */
export function DatabaseTabsProvider({ children }: { sourceId: string; children: ReactNode }) {
  const [tabs, setTabs] = useState<DatabaseTab[]>([CONSOLE_TAB]);
  const [active, setActive] = useState(CONSOLE_KEY);

  const select = useCallback((key: string) => setActive(key), []);
  const openConsole = useCallback(() => setActive(CONSOLE_KEY), []);

  const openTable = useCallback((target: string, schema: string, table: string) => {
    const tab: DatabaseTab = { kind: "table", target, schema, table };
    const key = tabKey(tab);
    setTabs((current) =>
      current.some((entry) => tabKey(entry) === key) ? current : [...current, tab]
    );
    setActive(key);
  }, []);

  const close = useCallback((key: string) => {
    if (key === CONSOLE_KEY) return;
    setTabs((current) => current.filter((entry) => tabKey(entry) !== key));
    setActive((current) => (current === key ? CONSOLE_KEY : current));
  }, []);

  const value = useMemo(
    () => ({ tabs, active, select, openConsole, openTable, close }),
    [tabs, active, select, openConsole, openTable, close]
  );

  return <DatabaseTabsContext.Provider value={value}>{children}</DatabaseTabsContext.Provider>;
}

/** The tabs of the enclosing data source window. */
export function useDatabaseTabs(): DatabaseTabsValue {
  const context = useContext(DatabaseTabsContext);
  if (!context) throw new Error("useDatabaseTabs must be used inside DatabaseTabsProvider");
  return context;
}
