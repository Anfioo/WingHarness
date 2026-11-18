// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import type { SystemStats } from "@/commands";

/**
 * Disjoint parts of physical memory, in bytes.
 *
 * The system's `memUsed` overlaps with the lists, so with lists present the
 * used part is derived from the three other parts instead. Cached memory is
 * not part of this split: it overlaps every part.
 */
export type MemoryComposition = {
  total: number;
  used: number;
  modified: number | null;
  standby: number | null;
  free: number | null;
};

export function memoryComposition(
  system: Pick<SystemStats, "memTotal" | "memUsed" | "memoryLists">
): MemoryComposition {
  const total = Number.isFinite(system.memTotal) ? Math.max(0, system.memTotal) : 0;
  const lists = system.memoryLists;
  if (!lists) {
    const used = Number.isFinite(system.memUsed) ? Math.max(0, system.memUsed) : 0;
    return { total, used: Math.min(total, used), modified: null, standby: null, free: null };
  }

  // Bound each remaining part, including while independent totals change.
  const free = Math.min(total, Math.max(0, lists.free));
  const standby = Math.min(total - free, Math.max(0, lists.standby));
  const modified = Math.min(total - free - standby, Math.max(0, lists.modified));
  return { total, used: total - free - standby - modified, modified, standby, free };
}

/** A part's share of a total, clamped to 0–100 (0 when the total is unknown). */
export function compositionPercent(part: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(part)) return 0;
  return Math.min(100, Math.max(0, (part / total) * 100));
}
