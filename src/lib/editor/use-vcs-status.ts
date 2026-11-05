import { useCallback, useEffect, useRef, useState } from "react";
import { repoIgnoredPaths, repoStatus } from "@/commands";
import { vcsKinds, type VcsKind } from "@/lib/editor/vcs-decorations";

/** How stale the tree may look while nothing tells us a file changed. */
const REFRESH_INTERVAL_MS = 20_000;
/** Saves arrive in bursts — a format-on-save rewrites several files in a row. */
const SAVE_DEBOUNCE_MS = 300;

function sameKinds(a: Map<string, VcsKind>, b: Map<string, VcsKind>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, kind] of a) if (b.get(path) !== kind) return false;
  return true;
}

/**
 * The working copy's change set, in the shape the file tree colours itself with.
 *
 * Refreshed on mount, on window focus, every twenty seconds, and on demand after
 * a save. A folder that is not a repository — or a backend that cannot read it —
 * answers with an empty map, which leaves the tree plain rather than failing the
 * page.
 */
export function useVcsStatus(repo: string | null): {
  kinds: Map<string, VcsKind>;
  /** Debounced, for the save callback. */
  refresh: () => void;
} {
  const [kinds, setKinds] = useState<Map<string, VcsKind>>(() => new Map());
  const sequence = useRef(0);
  const pending = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!repo) {
      setKinds((current) => (current.size ? new Map() : current));
      return;
    }
    const run = ++sequence.current;
    try {
      const [status, ignored] = await Promise.all([repoStatus(repo), repoIgnoredPaths(repo)]);
      if (run !== sequence.current) return;
      const next = vcsKinds(status.files, ignored);
      setKinds((current) => (sameKinds(current, next) ? current : next));
    } catch (err) {
      if (run !== sequence.current) return;
      // Not a repository (or not readable as one): show no colours, not an error.
      console.error("project vcs status:", err);
      setKinds((current) => (current.size ? new Map() : current));
    }
  }, [repo]);

  const refresh = useCallback(() => {
    if (pending.current !== null) window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      pending.current = null;
      void load();
    }, SAVE_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      if (pending.current !== null) {
        window.clearTimeout(pending.current);
        pending.current = null;
      }
    };
  }, [load]);

  return { kinds, refresh };
}
