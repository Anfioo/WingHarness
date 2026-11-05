// Frontend log buffer for the FRP console.
//
// The engine streams one event per line; keeping them in React state would
// re-render the log tab for every line. This store lives outside React and
// exposes a version-stable snapshot, so the log tab can subscribe with
// `useSyncExternalStore` and stay quiet when nothing changed.

import type { LogEntry, LogLevel } from "@/commands/services/frp/types";
import { isLogLevelAtLeast } from "./format";

/** How many lines the console keeps in memory, per plan §7.3. */
export const FRP_LOG_LIMIT = 2000;

export type FrpLogFilter = {
  /** `null` shows every profile. */
  profileId: string | null;
  /** `null` is "ALL"; otherwise the minimum severity to show. */
  minimumLevel: LogLevel | null;
  keyword: string;
};

export type FrpLogStore = {
  push(entry: LogEntry): void;
  pushAll(entries: LogEntry[]): void;
  /** Clears one profile's lines, or the whole buffer when `profileId` is null. */
  clear(profileId?: string | null): void;
  /** Oldest first; the returned array is stable until the next change. */
  snapshot(): LogEntry[];
  size(): number;
  subscribe(listener: () => void): () => void;
};

/** Keeps the lines matching every active filter, oldest first. */
export function filterLogs(entries: LogEntry[], filter: FrpLogFilter): LogEntry[] {
  const keyword = filter.keyword.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter.profileId && entry.profileId !== filter.profileId) return false;
    if (filter.minimumLevel && !isLogLevelAtLeast(entry.level, filter.minimumLevel)) return false;
    if (keyword && !entry.message.toLowerCase().includes(keyword)) return false;
    return true;
  });
}

export function createFrpLogStore(limit = FRP_LOG_LIMIT): FrpLogStore {
  const capacity = Math.max(1, Math.floor(limit));
  const ring: LogEntry[] = new Array(capacity);
  let head = 0;
  let count = 0;
  let cache: LogEntry[] | null = null;
  const listeners = new Set<() => void>();

  function invalidate(): void {
    cache = null;
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function read(): LogEntry[] {
    if (cache) return cache;
    const ordered: LogEntry[] = [];
    const start = count < capacity ? 0 : head;
    for (let index = 0; index < count; index += 1) {
      ordered.push(ring[(start + index) % capacity]);
    }
    cache = ordered;
    return ordered;
  }

  return {
    push(entry) {
      ring[head] = entry;
      head = (head + 1) % capacity;
      if (count < capacity) count += 1;
      invalidate();
      notify();
    },
    pushAll(entries) {
      if (entries.length === 0) return;
      for (const entry of entries) {
        ring[head] = entry;
        head = (head + 1) % capacity;
        if (count < capacity) count += 1;
      }
      invalidate();
      notify();
    },
    clear(profileId = null) {
      if (profileId === null) {
        count = 0;
        head = 0;
      } else {
        const kept = read().filter((entry) => entry.profileId !== profileId);
        count = Math.min(kept.length, capacity);
        head = count % capacity;
        for (let index = 0; index < count; index += 1) ring[index] = kept[index];
        // `kept` is the previous cached array; never let a stale view survive.
      }
      invalidate();
      notify();
    },
    snapshot() {
      return read();
    },
    size() {
      return count;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
