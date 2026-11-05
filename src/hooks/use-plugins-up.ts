import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pluginsProbe, pluginsRunning, type PluginView } from "@/commands";

/** How often to re-check the addresses. */
const POLL_INTERVAL = 2000;

/**
 * Which plugins are up, decided by whether their address answers.
 *
 * **This is the criterion, not the process table.** A plugin's page can be
 * served by an instance this app never started — one left over from an earlier
 * run, or launched by hand — and the process table knows nothing about it. The
 * user's rule is the honest one: if the page is there, it is running. It also
 * needs no bookkeeping to survive an app restart, which is exactly when a naive
 * "did we start it?" answer goes wrong.
 *
 * A plugin with no `ui` has no address to ask, so for those the process table is
 * all there is.
 *
 * `up` is `null` until the first round answers, which is not the same as
 * "nothing is up": a caller that acted on an empty set too early would report a
 * running plugin as stopped.
 */
export function usePluginsUp(plugins: PluginView[]): {
  up: Set<string> | null;
  known: boolean;
  refresh: () => Promise<void>;
} {
  const [up, setUp] = useState<Set<string> | null>(null);
  const alive = useRef(true);

  // A stable description of what to watch. Callers re-render with a fresh array
  // every time, so depending on the array itself would restart the poll on
  // every render.
  const key = useMemo(
    () =>
      plugins
        .filter((plugin) => plugin.error === null)
        .map((plugin) => `${plugin.id}\u0000${plugin.ui ?? ""}`)
        .sort()
        .join("\u0001"),
    [plugins]
  );

  // The list behind that key, read through a ref so the poll below can depend on
  // the key alone. Written in an effect, not during render, so it lands before
  // the poll effect below runs on that same commit.
  const targets = useRef<PluginView[]>([]);
  useEffect(() => {
    targets.current = plugins.filter((plugin) => plugin.error === null);
  }, [plugins]);

  const read = useCallback(async () => {
    const list = targets.current;

    try {
      const addressed = list.filter((plugin) => plugin.ui);
      // Only needed for plugins with nothing to probe.
      const running = addressed.length === list.length ? null : new Set(await pluginsRunning());

      const next = new Set<string>();
      await Promise.all(
        list.map(async (plugin) => {
          if (!plugin.ui) {
            if (running?.has(plugin.id)) next.add(plugin.id);
            return;
          }
          try {
            if (await pluginsProbe(plugin.ui)) next.add(plugin.id);
          } catch {
            // A failed probe is simply "not up".
          }
        })
      );

      if (alive.current) setUp(next);
    } catch (error) {
      // Keep the last answer: a hiccup must not make a live plugin look down.
      console.error("Failed to check which plugins are up:", error);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- the key is the change signal

  useEffect(() => {
    alive.current = true;
    void read();
    const timer = setInterval(() => void read(), POLL_INTERVAL);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [read]);

  return { up, known: up !== null, refresh: read };
}
