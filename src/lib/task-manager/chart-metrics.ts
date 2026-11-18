// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The numbers the performance charts record, one value per snapshot.

import type { Snapshot } from "@/commands";

/** Every series the tab's history keeps, in one stable order. */
export const SNAPSHOT_SERIES = [
  "cpu",
  "mem",
  "diskRead",
  "diskWrite",
  "netRx",
  "netTx",
  "gpu",
] as const;

export type SnapshotSeries = (typeof SNAPSHOT_SERIES)[number];

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * The sum of the devices' rates, or null when there is no device to read.
 * An unavailable device rate makes the whole total unknown.
 */
function sum(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

/** Machine-wide readings for one frame: totals across disks and adapters, the busiest GPU. */
export function snapshotMetrics(snapshot: Snapshot): Record<SnapshotSeries, number | null> {
  const { system, hardware } = snapshot;
  const gpus = hardware.gpus;
  return {
    cpu: finite(system.cpu),
    mem: finite(system.memUsed),
    diskRead: sum(hardware.disks.map((disk) => disk.read)),
    diskWrite: sum(hardware.disks.map((disk) => disk.write)),
    netRx: sum(hardware.nics.map((nic) => nic.rx)),
    netTx: sum(hardware.nics.map((nic) => nic.tx)),
    gpu: gpus.length === 0 ? null : finite(Math.max(...gpus.map((gpu) => gpu.util))),
  };
}
