// One directory pane's state: listing, sorting, selection and staleness.
//
// The loader is held in a ref so toggling "show hidden" can reload with the
// new filter without rebuilding the hook.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SftpEntry } from "@/commands/services/servers/types";
import { errorText } from "@/lib/servers/format";
import { MAX_LIST_ENTRIES, sortEntries, tooManyEntryLimit } from "./paths";
import type { SortKey, SortState } from "./types";

export type DirectoryLoader = (path: string) => Promise<SftpEntry[]>;

export type SelectionModifiers = { ctrl: boolean; shift: boolean };

export type DirectoryPane = {
  path: string;
  entries: SftpEntry[];
  loading: boolean;
  error: string | null;
  tooManyLimit: number | null;
  selection: ReadonlySet<string>;
  sort: SortState;
  setSort: (key: SortKey) => void;
  navigate: (path: string) => void;
  reload: () => void;
  selectRow: (entry: SftpEntry, modifiers: SelectionModifiers) => void;
  selectOnly: (entry: SftpEntry) => void;
};

type PaneState = {
  path: string;
  entries: SftpEntry[];
  loading: boolean;
  error: string | null;
  tooManyLimit: number | null;
};

const EMPTY_STATE: PaneState = {
  path: "",
  entries: [],
  loading: false,
  error: null,
  tooManyLimit: null,
};

export function useDirectory(loader: DirectoryLoader): DirectoryPane {
  const [state, setState] = useState<PaneState>(EMPTY_STATE);
  const [sort, setSortState] = useState<SortState>({ key: "name", direction: "asc" });
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set<string>());

  const loaderRef = useRef(loader);
  const pathRef = useRef("");
  const requestRef = useRef(0);
  const anchorRef = useRef<string | null>(null);
  const entriesRef = useRef<SftpEntry[]>([]);

  // Refs are written after commit so event handlers always see the latest
  // loader and sort order without re-creating the callbacks below.
  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);

  const load = useCallback((path: string, keepEntries = false) => {
    const token = requestRef.current + 1;
    requestRef.current = token;
    pathRef.current = path;

    setState((previous) => ({
      path,
      entries: keepEntries ? previous.entries : [],
      loading: true,
      error: null,
      tooManyLimit: null,
    }));
    setSelection(new Set<string>());
    anchorRef.current = null;

    void loaderRef.current(path).then(
      (entries) => {
        if (requestRef.current !== token) return;
        if (entries.length > MAX_LIST_ENTRIES) {
          setState({
            path,
            entries: [],
            loading: false,
            error: null,
            tooManyLimit: MAX_LIST_ENTRIES,
          });
          return;
        }
        setState({ path, entries, loading: false, error: null, tooManyLimit: null });
      },
      (error: unknown) => {
        if (requestRef.current !== token) return;
        const limit = tooManyEntryLimit(error);
        setState({
          path,
          entries: [],
          loading: false,
          error: limit ? null : errorText(error),
          tooManyLimit: limit,
        });
      }
    );
  }, []);

  const navigate = useCallback(
    (path: string) => {
      load(path);
    },
    [load]
  );

  const reload = useCallback(() => {
    if (pathRef.current) load(pathRef.current, true);
  }, [load]);

  const sorted = useMemo(() => sortEntries(state.entries, sort), [state.entries, sort]);

  useEffect(() => {
    entriesRef.current = sorted;
  }, [sorted]);

  const setSort = useCallback((key: SortKey) => {
    setSortState((previous) =>
      previous.key === key
        ? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" }
    );
  }, []);

  const selectRow = useCallback((entry: SftpEntry, modifiers: SelectionModifiers) => {
    if (modifiers.shift && anchorRef.current) {
      const list = entriesRef.current;
      const from = list.findIndex((item) => item.path === anchorRef.current);
      const to = list.findIndex((item) => item.path === entry.path);
      if (from >= 0 && to >= 0) {
        const [start, end] = from <= to ? [from, to] : [to, from];
        setSelection(new Set(list.slice(start, end + 1).map((item) => item.path)));
        return;
      }
    }

    if (modifiers.ctrl) {
      setSelection((previous) => {
        const next = new Set(previous);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
    } else {
      setSelection(new Set([entry.path]));
    }
    anchorRef.current = entry.path;
  }, []);

  const selectOnly = useCallback((entry: SftpEntry) => {
    setSelection(new Set([entry.path]));
    anchorRef.current = entry.path;
  }, []);

  return {
    path: state.path,
    entries: sorted,
    loading: state.loading,
    error: state.error,
    tooManyLimit: state.tooManyLimit,
    selection,
    sort,
    setSort,
    navigate,
    reload,
    selectRow,
    selectOnly,
  };
}
