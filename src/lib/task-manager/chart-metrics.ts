// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The numbers the performance charts record, one value per snapshot.
//
// The machine-wide totals feed the device list's CPU and memory entries; every
// disk, adapter, GPU and battery also records its own keys, so the detail view
// and the list's sparkline chart the same series.

import type { Snapshot } from "@/commands";

/** Series that always exist, before any device has been seen. */
export const SNAPSHOT_SERIES = [
  "cpu",
  "cpuKernel",
  "mem",
  "diskRead",
  "diskWrite",
  "netRx",
  "netTx",
  "gpu",
] as const;

export type SnapshotSeries = (typeof SNAPSHOT_SERIES)[number];

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

/** Machine-wide and per-device readings for one frame. */
export function snapshotMetrics(snapshot: Snapshot): Record<string, number | null> {
  const { system, hardware } = snapshot;
  const gpus = hardware.gpus;
  const metrics: Record<string, number | null> = {
    cpu: finite(system.cpu),
    cpuKernel: finite(system.cpuKernel),
    mem: finite(system.memUsed),
    diskRead: sum(hardware.disks.map((disk) => disk.read)),
    diskWrite: sum(hardware.disks.map((disk) => disk.write)),
    netRx: sum(hardware.nics.map((nic) => nic.rx)),
    netTx: sum(hardware.nics.map((nic) => nic.tx)),
    gpu: gpus.length === 0 ? null : finite(Math.max(...gpus.map((gpu) => gpu.util))),
  };

  // Logical processors: the per-core chart grids index these by thread identity.
  hardware.cpu.threads.forEach((thread, index) => {
    metrics[`core.${thread.group}.${thread.processor}`] = finite(system.cores[index]);
  });

  for (const disk of hardware.disks) {
    const prefix = `disk.${disk.info.index}`;
    metrics[`${prefix}.active`] = finite(disk.active);
    metrics[`${prefix}.read`] = finite(disk.read);
    metrics[`${prefix}.write`] = finite(disk.write);
  }

  for (const nic of hardware.nics) {
    const prefix = `nic.${nic.info.id}`;
    metrics[`${prefix}.rx`] = finite(nic.rx);
    metrics[`${prefix}.tx`] = finite(nic.tx);
  }

  for (const gpu of hardware.gpus) {
    const prefix = `gpu.${gpu.info.id}`;
    metrics[`${prefix}.util`] = finite(gpu.util);
    metrics[`${prefix}.dedicated`] = finite(gpu.dedicatedUsed);
    metrics[`${prefix}.shared`] = finite(gpu.sharedUsed);
    gpu.info.engines.forEach((_, index) => {
      metrics[`${prefix}.e${index}`] = finite(gpu.engines[index]);
    });
  }

  for (const battery of hardware.batteries) {
    const prefix = `bat.${battery.info.id}`;
    metrics[`${prefix}.pct`] = finite(battery.percent);
    metrics[`${prefix}.rate`] = finite(battery.rate);
    metrics[`${prefix}.capacity`] = finite(battery.capacity);
    metrics[`${prefix}.voltage`] = finite(battery.voltage);
  }

  return metrics;
}
