import type { StateStorage } from "zustand/middleware";
import { gitStoreRead, gitStoreRemove, gitStoreWrite } from "@/commands";

/**
 * Backs the git feature's `persist` stores with the git engine's data directory
 * (`<data dir>/.git-repo`) instead of WebView2 localStorage, so a user's git
 * state moves with the rest of their app data. One file per store, named after
 * the store.
 *
 * Writes are debounced: `commitBoxHeight` is persisted on every mousemove of a
 * resize drag, which would otherwise be a file write per pixel.
 */

const WRITE_DEBOUNCE_MS = 300;

const pending = new Map<string, { value: string; timer: number }>();

function flush(name: string): void {
  const entry = pending.get(name);
  if (!entry) return;
  pending.delete(name);
  window.clearTimeout(entry.timer);
  gitStoreWrite(name, entry.value).catch((error: unknown) => {
    console.error(`Failed to persist "${name}" to the git data directory:`, error);
  });
}

function flushAll(): void {
  for (const name of Array.from(pending.keys())) flush(name);
}

// Best effort: the last debounced value should not be lost when the window goes
// away mid-drag.
window.addEventListener("beforeunload", flushAll);
window.addEventListener("pagehide", flushAll);

export const gitStateStorage: StateStorage = {
  getItem: async (name) => {
    // A value still waiting on the debounce is newer than what is on disk.
    const buffered = pending.get(name);
    if (buffered) return buffered.value;
    try {
      return await gitStoreRead(name);
    } catch (error) {
      console.error(`Failed to read "${name}" from the git data directory:`, error);
      return null;
    }
  },
  setItem: (name, value) => {
    const entry = pending.get(name);
    if (entry) window.clearTimeout(entry.timer);
    const timer = window.setTimeout(() => flush(name), WRITE_DEBOUNCE_MS);
    pending.set(name, { value, timer });
  },
  removeItem: (name) => {
    const entry = pending.get(name);
    if (entry) {
      window.clearTimeout(entry.timer);
      pending.delete(name);
    }
    gitStoreRemove(name).catch((error: unknown) => {
      console.error(`Failed to delete "${name}" from the git data directory:`, error);
    });
  },
};
