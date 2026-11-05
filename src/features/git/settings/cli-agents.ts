import { useEffect, useState } from "react";
import type { CliAgentInfo } from "@/commands";
import { useAi } from "@/features/git/ai";

/**
 * Installed CLI agents, detected once and then reused.
 *
 * Detection probes every known binary for its version, so the result is kept in
 * the persisted AI settings — a reload or a new launch reads it back instead of
 * spawning the probes again. Only the settings card's refresh button re-runs it.
 */
export function useCliAgents(): {
  agents: CliAgentInfo[] | null;
  loading: boolean;
  rescan: () => void;
} {
  const agents = useAi((state) => state.cliAgents);
  const [loading, setLoading] = useState(false);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      // The first pass only fills a cache that hydration left empty; a new
      // epoch means the user asked for a fresh scan.
      if (epoch === 0 && useAi.getState().cliAgents !== null) return;
      setLoading(true);
      void useAi
        .getState()
        .refreshCliAgents()
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    // Reading the persisted value is async, so a cold start may reach this
    // point before the cache is back; waiting keeps it from being ignored.
    if (useAi.persist.hasHydrated()) {
      run();
      return () => {
        cancelled = true;
      };
    }
    const unsubscribe = useAi.persist.onFinishHydration(() => {
      unsubscribe();
      run();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [epoch]);

  return { agents, loading, rescan: () => setEpoch((value) => value + 1) };
}
