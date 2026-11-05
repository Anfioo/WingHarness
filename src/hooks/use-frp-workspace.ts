// Workspace loader shared by the five FRP tabs.
//
// The page shell owns this hook; tabs receive its result. Loading is one
// parallel round of the four list commands, connection state arrives through
// `frp:state` / `frp:metrics`, and a 5-second `frp_connections_list` poll acts
// as a fallback for a missed event.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  frpConnectionsList,
  frpProfilesList,
  frpRuntimesList,
  frpTunnelsList,
  isFrpError,
} from "@/commands";
import type { FrpProfile, LogEntry, RuntimeView, TunnelView } from "@/commands/services/frp/types";
import { frpErrorOutput, frpFailureKey } from "@/lib/frp/format";
import { toSnapshotMap, useFrpEvents, type SnapshotMap } from "@/hooks/use-frp-events";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** How often the page falls back to polling while events are quiet. */
export const FRP_POLL_INTERVAL_MS = 5000;

export type FrpWorkspace = {
  profiles: FrpProfile[];
  tunnels: TunnelView[];
  runtimes: RuntimeView[];
  /** Keyed by profile id; only profiles with a known process appear. */
  snapshots: SnapshotMap;
  /** True during the first load and during an explicit reload. */
  loading: boolean;
  /** Localized banner text for the last failed load or action. */
  error: string | null;
  reload: () => Promise<void>;
  /** Runs an action with the shared error banner; rethrows for the caller. */
  runAction: <T>(action: () => Promise<T>) => Promise<T>;
  /** Clears the banner without running anything. */
  dismissError: () => void;
};

export function useFrpWorkspace(options?: { onLog?: (entry: LogEntry) => void }): FrpWorkspace {
  const { t } = useAppTranslation();
  const [profiles, setProfiles] = useState<FrpProfile[]>([]);
  const [tunnels, setTunnels] = useState<TunnelView[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeView[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const describe = useCallback(
    (failure: unknown): string => {
      const key = frpFailureKey(failure);
      if (!key) {
        return failure instanceof Error ? failure.message : String(failure);
      }
      // The code carries the meaning; the engine's message adds the specifics
      // (which field, which port) that a generic translation cannot.
      const message = isFrpError(failure) ? failure.message.trim() : "";
      // A rejected config explains itself through frpc's own output; without
      // it the banner only says "rejected" and gives the user nothing to fix.
      const output = frpErrorOutput(failure);
      if (output) return `${t(key)} ${output}`;
      return message ? `${t(key)}: ${message}` : t(key);
    },
    [t]
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [profileView, tunnelList, runtimeList, connections] = await Promise.all([
        frpProfilesList(),
        frpTunnelsList(),
        frpRuntimesList(),
        frpConnectionsList(),
      ]);
      if (!mounted.current) return;
      setProfiles(profileView.profiles);
      setTunnels(tunnelList);
      setRuntimes(runtimeList);
      setSnapshots(toSnapshotMap(connections));
      setError(null);
    } catch (failure) {
      if (mounted.current) setError(describe(failure));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [describe]);

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setInterval(() => {
      frpConnectionsList()
        .then((connections) => {
          if (!cancelled) setSnapshots(toSnapshotMap(connections));
        })
        .catch(() => {
          // Events are the primary channel; a failed poll is not worth a banner.
        });
    }, FRP_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useFrpEvents(setSnapshots, options?.onLog);

  const runAction = useCallback(
    async <T>(action: () => Promise<T>): Promise<T> => {
      setError(null);
      try {
        return await action();
      } catch (failure) {
        if (mounted.current) setError(describe(failure));
        throw failure;
      }
    },
    [describe]
  );

  const dismissError = useCallback(() => setError(null), []);

  return useMemo(
    () => ({
      profiles,
      tunnels,
      runtimes,
      snapshots,
      loading,
      error,
      reload,
      runAction,
      dismissError,
    }),
    [profiles, tunnels, runtimes, snapshots, loading, error, reload, runAction, dismissError]
  );
}
