// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Process search: a case-insensitive match over the name, the PID and the
// image path. A purely numeric query also matches PID prefixes, which is how
// typing the first digits of a PID narrows the list while the query is typed.

import type { ProcessRow } from "@/commands";

export type ProcessMatcher = (process: ProcessRow) => boolean;

/** The matcher for `query`, or null when the query does not filter anything. */
export function createProcessMatcher(query: string): ProcessMatcher | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const numeric = /^\d+$/.test(needle);

  return (process) => {
    if (numeric && String(process.pid).startsWith(needle)) return true;
    if (process.name.toLowerCase().includes(needle)) return true;
    if (process.path?.toLowerCase().includes(needle)) return true;
    return false;
  };
}
