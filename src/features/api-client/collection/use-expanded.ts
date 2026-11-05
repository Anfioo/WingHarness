import { useCallback, useEffect, useRef, useState } from "react";

/** sessionStorage key holding the expanded node ids for one workspace. */
function storageKey(workspaceId: string): string {
  return `api-client-tree-expanded:${workspaceId}`;
}

/** Read the persisted set of expanded ids, or `null` when nothing is stored yet. */
function readExpanded(key: string): Set<string> | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return null;
  }
}

/** Persist the expanded ids; a failure (private mode, full quota) is non-fatal. */
function writeExpanded(key: string, expanded: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify([...expanded]));
  } catch {
    // Expansion simply won't survive this session.
  }
}

export interface ExpandedNodes {
  expanded: ReadonlySet<string>;
  toggle: (id: string) => void;
  expand: (id: string) => void;
}

/**
 * Expanded-node ids for a collection tree, remembered for the lifetime of the
 * session (`sessionStorage`, keyed per workspace). Opening a workspace for the
 * first time has nothing stored, so `defaults` seed the initial expansion —
 * usually its top-level collections, so an imported spec shows its requests.
 */
export function useExpandedNodes(workspaceId: string, defaults: string[]): ExpandedNodes {
  const key = storageKey(workspaceId);
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded(key) ?? new Set());
  const activeKey = useRef(key);
  const seeded = useRef(readExpanded(key) !== null);

  // Switch to the new workspace's remembered state when the workspace changes.
  useEffect(() => {
    if (activeKey.current === key) return;
    activeKey.current = key;
    const stored = readExpanded(key);
    seeded.current = stored !== null;
    setExpanded(stored ?? new Set());
  }, [key]);

  // Seed the defaults once the tree (and so `defaults`) is available.
  useEffect(() => {
    if (seeded.current || defaults.length === 0) return;
    seeded.current = true;
    setExpanded(new Set(defaults));
  }, [defaults]);

  useEffect(() => {
    if (!seeded.current) return;
    writeExpanded(key, expanded);
  }, [key, expanded]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expand = useCallback((id: string) => {
    setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  return { expanded, toggle, expand };
}
