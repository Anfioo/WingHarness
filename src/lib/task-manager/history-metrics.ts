// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The five system charts of the history tab (and the battery when one was
// recorded), each with its scale, its readout and its optional second line
// such as the CPU's highest one-second sample.

import type { TFunction } from "i18next";
import type { HistoryPoint } from "@/commands";
import { formatGigabytes, formatPercent, formatRate } from "@/components/task-manager/format";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { rateCeiling, rateCeilingLabel } from "@/lib/task-manager/chart-scale";

const MB = 1024 ** 2;

export type HistoryMetricId = "cpu" | "memory" | "disk" | "network" | "gpu" | "battery";

export type HistoryMetric = {
  id: HistoryMetricId;
  label: string;
  /** A CSS color, e.g. `var(--perf-cpu)`. */
  color: string;
  /** A missing reading leaves a gap and has no readout or cursor dot. */
  value: (point: HistoryPoint) => number | null;
  /** Drawn faintly above the value, e.g. the CPU's one-second peak. */
  peak?: (point: HistoryPoint) => number | null;
  /** False when this point has no reading for the metric. */
  available?: (point: HistoryPoint) => boolean;
  /** Top of the vertical axis for a set of points. */
  max: (points: readonly HistoryPoint[]) => number;
  /** Labels the top of the axis. */
  scaleLabel: (max: number) => string;
  /** The cursor readout's main figure. */
  format: (point: HistoryPoint) => string;
  /** A second, quieter figure under the readout. */
  detail?: (point: HistoryPoint) => string | null;
};

/** The highest reading in a set, from a metric that may be missing. */
function highest(
  points: readonly HistoryPoint[],
  value: (point: HistoryPoint) => number | null
): number {
  let peak = 0;
  for (const point of points) {
    const reading = value(point);
    if (reading !== null && Number.isFinite(reading) && reading > peak) peak = reading;
  }
  return peak;
}

/** The CPU, memory, disk, network and GPU charts, plus the battery when recorded. */
export function createHistoryMetrics(t: TFunction): HistoryMetric[] {
  return [
    {
      id: "cpu",
      label: t("taskManager.history.metric.cpu"),
      color: CHART_COLORS.cpu,
      value: (point) => point.cpu,
      peak: (point) => point.cpuPeak,
      max: () => 100,
      scaleLabel: (max) => formatPercent(max, 0),
      format: (point) => formatPercent(point.cpu, 0),
      detail: (point) =>
        `${t("taskManager.history.metric.cpuPeak")} ${formatPercent(point.cpuPeak, 0)}`,
    },
    {
      id: "memory",
      label: t("taskManager.history.metric.memory"),
      color: CHART_COLORS.memory,
      value: (point) => point.memUsed,
      max: (points) =>
        Math.max(
          1,
          highest(points, (point) => point.memTotal)
        ),
      scaleLabel: (max) => formatGigabytes(max),
      format: (point) => formatGigabytes(point.memUsed),
    },
    {
      id: "disk",
      label: t("taskManager.history.metric.disk"),
      color: CHART_COLORS.diskRead,
      value: (point) => point.disk,
      // Round tops, as on the performance page: "8 MiB/s".
      max: (points) =>
        rateCeiling(
          Math.max(
            MB,
            highest(points, (point) => point.disk)
          )
        ),
      scaleLabel: (max) => rateCeilingLabel(max),
      format: (point) => formatRate(point.disk, 0),
    },
    {
      id: "network",
      label: t("taskManager.history.metric.network"),
      color: CHART_COLORS.netReceived,
      value: (point) => point.net,
      // At least 1 Mbps, so a mostly idle adapter still reads as a rate.
      max: (points) =>
        rateCeiling(
          Math.max(
            125_000,
            highest(points, (point) => point.net)
          )
        ),
      scaleLabel: (max) => rateCeilingLabel(max),
      format: (point) => formatRate(point.net, 0),
    },
    {
      id: "gpu",
      label: t("taskManager.history.metric.gpu"),
      color: CHART_COLORS.gpu,
      value: (point) => point.gpu,
      max: () => 100,
      scaleLabel: (max) => formatPercent(max, 0),
      format: (point) => formatPercent(point.gpu, 0),
    },
    {
      id: "battery",
      label: t("taskManager.history.metric.battery"),
      color: CHART_COLORS.battery,
      value: (point) => point.battery,
      available: (point) => point.battery !== null,
      max: () => 100,
      scaleLabel: (max) => formatPercent(max, 0),
      format: (point) => (point.battery === null ? "—" : formatPercent(point.battery, 0)),
    },
  ];
}

/** Drops the battery chart when every point in the window lacks a battery reading. */
export function visibleHistoryMetrics(
  metrics: readonly HistoryMetric[],
  points: readonly HistoryPoint[]
): HistoryMetric[] {
  return metrics.filter(
    (metric) => metric.id !== "battery" || points.some((point) => point.battery !== null)
  );
}
