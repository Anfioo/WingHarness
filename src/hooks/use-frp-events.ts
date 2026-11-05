// Subscriptions for the three events `frp-core` emits.
//
// `frp:state` carries a whole connection snapshot, `frp:metrics` only latency
// and tunnel states, `frp:log` one line. The hooks merge them into the page's
// snapshot map instead of replacing it, so a metrics tick never loses fields
// that only the state event carries.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { ConnectionSnapshot, LogEntry, MetricsEvent } from "@/commands/services/frp/types";

/** Event names, mirroring `frp-core/src/events.rs`. */
export const FRP_STATE_EVENT = "frp:state";
export const FRP_METRICS_EVENT = "frp:metrics";
export const FRP_LOG_EVENT = "frp:log";

/** Connection snapshots keyed by profile id. */
export type SnapshotMap = Record<string, ConnectionSnapshot>;

export type SnapshotSetter = Dispatch<SetStateAction<SnapshotMap>>;

/** Inserts or replaces one profile's snapshot. */
export function withSnapshot(map: SnapshotMap, snapshot: ConnectionSnapshot): SnapshotMap {
  return { ...map, [snapshot.profileId]: snapshot };
}

/** Applies a metrics tick; profiles the map does not know about are ignored. */
export function withMetrics(map: SnapshotMap, metrics: MetricsEvent): SnapshotMap {
  const current = map[metrics.profileId];
  if (!current) return map;
  return {
    ...map,
    [metrics.profileId]: {
      ...current,
      latencyMs: metrics.latencyMs,
      tunnelStates: metrics.tunnelStates,
    },
  };
}

/** Builds a fresh map from a `frp_connections_list` poll. */
export function toSnapshotMap(snapshots: ConnectionSnapshot[]): SnapshotMap {
  const map: SnapshotMap = {};
  for (const snapshot of snapshots) map[snapshot.profileId] = snapshot;
  return map;
}

/**
 * Subscribes to the live events for as long as `setSnapshots` stays stable.
 * `onLog` is read through a ref, so passing an inline handler does not
 * resubscribe on every render.
 */
export function useFrpEvents(
  setSnapshots: SnapshotSetter,
  onLog?: (entry: LogEntry) => void
): void {
  const logHandler = useRef(onLog);

  useEffect(() => {
    logHandler.current = onLog;
  }, [onLog]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    const unsubscribeAll = () => {
      for (const unlisten of unlisteners) unlisten();
      unlisteners.length = 0;
    };

    void (async () => {
      const handles = await Promise.all([
        listen<ConnectionSnapshot>(FRP_STATE_EVENT, (event) => {
          setSnapshots((current) => withSnapshot(current, event.payload));
        }),
        listen<MetricsEvent>(FRP_METRICS_EVENT, (event) => {
          setSnapshots((current) => withMetrics(current, event.payload));
        }),
        listen<LogEntry>(FRP_LOG_EVENT, (event) => {
          logHandler.current?.(event.payload);
        }),
      ]);

      // The effect may have been torn down while `listen` was resolving.
      if (disposed) {
        for (const unlisten of handles) unlisten();
        return;
      }
      unlisteners.push(...handles);
    })();

    return () => {
      disposed = true;
      unsubscribeAll();
    };
  }, [setSnapshots]);
}
