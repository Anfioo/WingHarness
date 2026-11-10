// The preview window's selection session: what the space agent handed over,
// which of those files is on screen, and how the arrow keys move through them.
//
// The window is a singleton that is hidden rather than destroyed, so this hook
// keeps no history: every hand-off replaces the list, and the arrow keys follow
// the file manager's own selection when its Shell COM is reachable.

import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  cancelFileNavigation,
  hidePreview,
  initialPaths,
  inspectFile,
  navigateFileSelection,
} from "@/commands";

export interface PreviewEntry {
  path: string;
  name: string;
  size?: number;
}

/** The part of `sp:preview-files` the window uses; `fileManager` is ignored. */
interface PreviewFilesPayload {
  paths: string[];
  text: boolean;
}

interface SessionState {
  entries: PreviewEntry[];
  index: number;
  text: boolean;
  /** Bumped on every hand-off; the host remounts on it to re-read a path. */
  showId: number;
}

const PREVIEW_FILES_EVENT = "sp:preview-files";
const PREVIEW_CLOSED_EVENT = "sp:preview-closed";

const EMPTY_STATE: SessionState = {
  entries: [],
  index: -1,
  text: false,
  showId: 0,
};

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// inspectFile canonicalizes its answer, so the entries and the paths the Shell
// reports back for navigation can be compared directly.
async function toEntries(paths: string[]): Promise<PreviewEntry[]> {
  const inspected = await Promise.allSettled(paths.map((path) => inspectFile(path)));
  const entries: PreviewEntry[] = [];
  for (const result of inspected) {
    // A path that vanished is simply dropped.
    if (result.status !== "fulfilled") continue;
    entries.push({ path: result.value.path, name: result.value.name, size: result.value.size });
  }
  return entries;
}

// A path the file manager moved to may not be part of the original selection;
// then the window follows that new single selection instead of a stale list.
function select(state: SessionState, entry: PreviewEntry): SessionState {
  const found = state.entries.findIndex((candidate) => candidate.path === entry.path);
  return found >= 0 ? { ...state, index: found } : { ...state, entries: [entry], index: 0 };
}

function step(state: SessionState, direction: 1 | -1): SessionState {
  const total = state.entries.length;
  if (state.index < 0 || total === 0) return state;
  return { ...state, index: (state.index + direction + total) % total };
}

export function usePreviewWindowSession(): {
  entries: PreviewEntry[];
  current: PreviewEntry | null;
  index: number;
  text: boolean;
  showId: number;
  setCurrentPath: (path: string) => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  close: () => Promise<void>;
} {
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  // Async inspection must not overwrite a hand-off that arrived after it.
  const request = useRef(0);
  // The agent repeats the first hand-off to cover a late listener; applying the
  // repeat would remount the host and drop an edit the user just started.
  const lastKey = useRef<string | null>(null);
  const stateRef = useRef(state);
  const navigating = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const apply = useCallback((payload: PreviewFilesPayload) => {
    const key = `${payload.text ? "text" : "auto"}:${payload.paths.join("\n")}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    const id = ++request.current;
    void toEntries(payload.paths).then((entries) => {
      if (id !== request.current) return;
      setState((current) => ({
        entries,
        index: entries.length > 0 ? 0 : -1,
        text: payload.text,
        showId: current.showId + 1,
      }));
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let received = false;
    const stops: UnlistenFn[] = [];
    const keep = (pending: Promise<UnlistenFn>) => {
      void pending.then(
        (stop) => (disposed ? stop() : stops.push(stop)),
        (error: unknown) => console.error("Failed to listen for a preview window event:", error)
      );
    };

    const filesReady = listen<PreviewFilesPayload>(PREVIEW_FILES_EVENT, (event) => {
      received = true;
      apply(event.payload);
    });
    keep(filesReady);
    keep(
      listen(PREVIEW_CLOSED_EVENT, () => {
        request.current++;
        // A later hand-off of the same selection is a new show, not a repeat.
        lastKey.current = null;
        setState((current) => ({
          ...current,
          entries: [],
          index: -1,
          text: false,
        }));
      })
    );

    // The window may have mounted after the first hand-off; the agent keeps
    // that payload until the window is hidden again. Last one to arrive wins,
    // and the listener is up first so nothing can slip between the two.
    void filesReady
      .then(() => initialPaths())
      .then((pending) => {
        if (disposed || received || pending.paths.length === 0) return;
        apply(pending);
      })
      .catch((error: unknown) =>
        console.error("Failed to read the pending preview selection:", error)
      );

    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [apply]);

  const move = useCallback(async (direction: 1 | -1) => {
    if (navigating.current) return;
    const session = stateRef.current;
    const entry = session.entries[session.index];
    if (!entry) return;

    navigating.current = true;
    try {
      let target: PreviewEntry | null = null;
      try {
        const path = await navigateFileSelection(entry.path, direction);
        if (path) {
          const info = await inspectFile(path);
          target = { path: info.path, name: info.name, size: info.size };
        }
      } catch {
        // No Shell COM behind the file manager: the local list takes over.
        target = null;
      }
      setState((current) => {
        // A newer hand-off replaced the list while this move was in flight.
        if (current.entries !== session.entries) return current;
        return target ? select(current, target) : step(current, direction);
      });
    } finally {
      navigating.current = false;
    }
  }, []);

  const next = useCallback(() => move(1), [move]);
  const previous = useCallback(() => move(-1), [move]);

  const setCurrentPath = useCallback((path: string) => {
    setState((current) => select(current, { path, name: baseName(path) }));
  }, []);

  const close = useCallback(async () => {
    // `sp_hide_preview` also drops the pending hand-off; the navigation cancel
    // keeps a move in flight from following a window that is going away.
    await Promise.allSettled([hidePreview(), cancelFileNavigation()]);
  }, []);

  return {
    entries: state.entries,
    current: state.entries[state.index] ?? null,
    index: state.index,
    text: state.text,
    showId: state.showId,
    setCurrentPath,
    next,
    previous,
    close,
  };
}
