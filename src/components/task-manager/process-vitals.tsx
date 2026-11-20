// The vitals band above the process table: one card per resource, each with
// the current reading and the same 60-sample window the performance tab
// keeps. A card is a button: it opens that device on the performance tab.

import { useEffect, useState } from "react";
import type { DiskStats, GpuStats } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager } from "@/hooks/use-task-manager";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import {
  createHistory,
  historyValues,
  pushHistory,
  type ChartHistory,
} from "@/lib/task-manager/chart-history";
import { SNAPSHOT_SERIES, snapshotMetrics } from "@/lib/task-manager/chart-metrics";
import { rateCeiling } from "@/lib/task-manager/chart-scale";
import { requestPerformanceTarget } from "@/lib/task-manager/performance-target";
import { cn } from "@/lib/utils";
import { formatGigabytes, formatPercent, formatRate } from "./format";
import { Sparkline, type SparkSeries } from "./sparkline";

/** The combined series this band records beside the snapshot's own. */
const VITAL_SERIES = [...SNAPSHOT_SERIES, "diskTotal", "netTotal"] as const;

/** Floors, so an idle machine still draws a readable line instead of noise. */
const DISK_FLOOR = 1024 * 1024;
const NET_FLOOR = 128 * 1024;

function combine(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  return left + right;
}

/** A formatted reading split into its number and its unit, e.g. `12.3` / `MiB/s`. */
function splitValue(text: string): { value: string; unit: string } {
  const space = text.lastIndexOf(" ");
  if (space === -1) return { value: text, unit: "" };
  return { value: text.slice(0, space), unit: text.slice(space + 1) };
}

/** The highest reading of one series, at least `floor`. */
function peakOf(history: ChartHistory, key: string, floor: number): number {
  let peak = floor;
  for (const value of historyValues(history, key)) {
    if (value !== null && value > peak) peak = value;
  }
  return peak;
}

function Vital({
  title,
  sub,
  value,
  unit,
  series,
  max,
  onOpen,
  label,
}: {
  title: string;
  sub?: string;
  value: string;
  unit?: string;
  series: readonly SparkSeries[];
  max: number;
  onOpen: () => void;
  label: string;
}) {
  const { t } = useAppTranslation();
  return (
    <button
      type="button"
      title={t("taskManager.vitals.open", { device: label })}
      onClick={onOpen}
      style={{ containerType: "inline-size" }}
      className="border-border hover:bg-muted/40 focus-visible:ring-ring/50 relative flex min-w-0 flex-col overflow-hidden border-l px-4 pt-2.5 text-left transition-colors first:border-l-0 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-muted-foreground shrink-0 text-xs">{title}</span>
        {sub ? (
          <span className="text-muted-foreground min-w-0 truncate text-xs tabular-nums">{sub}</span>
        ) : null}
      </div>
      {/* The unit ends in an ellipsis in a narrow card; the tooltip keeps the
          whole reading. */}
      <div
        className="mt-0.5 flex min-w-0 items-baseline gap-1.5 whitespace-nowrap"
        title={unit ? `${value} ${unit}` : value}
      >
        <span className="shrink-0 text-[clamp(16px,33cqw,34px)] leading-none font-light tracking-tight tabular-nums">
          {value}
        </span>
        {unit ? (
          <span className="text-muted-foreground min-w-0 truncate text-[clamp(9px,15cqw,13px)]">
            {unit}
          </span>
        ) : null}
      </div>
      <div className="pointer-events-none absolute inset-x-1 top-[60px] bottom-1">
        <Sparkline series={series} max={max} />
      </div>
    </button>
  );
}

export function ProcessVitals() {
  const { t } = useAppTranslation();
  const page = useTaskManager();
  const snapshot = page.snapshot;
  const [history, setHistory] = useState(() => createHistory(VITAL_SERIES));

  // One point per frame; a paused store stops delivering frames, so the window
  // freezes with the table.
  useEffect(() => {
    if (!snapshot) return;
    const metrics = snapshotMetrics(snapshot);
    setHistory((current) =>
      pushHistory(current, {
        ...metrics,
        diskTotal: combine(metrics.diskRead, metrics.diskWrite),
        netTotal: combine(metrics.netRx, metrics.netTx),
      })
    );
  }, [snapshot]);

  // Hold the band's height while the first frame is on its way, so the
  // toolbar and the table do not jump when it arrives.
  if (!snapshot) {
    return <div aria-hidden className="border-border bg-card h-32 shrink-0 rounded-lg border" />;
  }

  const { system, hardware } = snapshot;
  const memPercent = system.memTotal > 0 ? (system.memUsed / system.memTotal) * 100 : Number.NaN;
  const busiestDisk = hardware.disks.reduce<DiskStats | null>(
    (busiest, disk) => (!busiest || disk.active > busiest.active ? disk : busiest),
    null
  );
  const busiestGpu = hardware.gpus.reduce<GpuStats | null>(
    (busiest, gpu) => (!busiest || gpu.util > busiest.util ? gpu : busiest),
    null
  );
  const diskRead = hardware.disks.reduce((total, disk) => total + disk.read, 0);
  const diskWrite = hardware.disks.reduce((total, disk) => total + disk.write, 0);
  const netRx = hardware.nics.reduce((total, nic) => total + nic.rx, 0);
  const netTx = hardware.nics.reduce((total, nic) => total + nic.tx, 0);

  const open = (device: string) => {
    // A card whose device is not present (no disks, no adapters) stays put
    // instead of opening an unrelated first entry.
    if (!device) return;
    requestPerformanceTarget(device);
    page.setActiveTab("performance");
  };

  const disk = splitValue(formatRate(diskRead + diskWrite));
  const net = splitValue(formatRate(netRx + netTx));
  const memory = splitValue(formatGigabytes(system.memUsed));

  return (
    <section
      aria-label={t("taskManager.vitals.label")}
      className={cn(
        "border-border bg-card grid h-32 shrink-0 overflow-hidden rounded-lg border",
        busiestGpu
          ? "grid-cols-[1.3fr_repeat(4,minmax(0,1fr))]"
          : "grid-cols-[1.3fr_repeat(3,minmax(0,1fr))]"
      )}
    >
      <Vital
        title="CPU"
        label="CPU"
        sub={hardware.cpuMhz ? `${(hardware.cpuMhz / 1000).toFixed(2)} GHz` : undefined}
        value={String(Math.round(system.cpu))}
        unit="%"
        series={[{ points: historyValues(history, "cpu"), color: CHART_COLORS.cpu }]}
        max={100}
        onOpen={() => open("cpu")}
      />

      <Vital
        title={t("taskManager.performance.memory.title")}
        label={t("taskManager.performance.memory.title")}
        sub={formatPercent(memPercent, 0)}
        value={memory.value}
        unit={`${memory.unit} / ${formatGigabytes(system.memTotal)}`}
        series={[{ points: historyValues(history, "mem"), color: CHART_COLORS.memory }]}
        max={system.memTotal > 0 ? system.memTotal : 1}
        onOpen={() => open("memory")}
      />

      <Vital
        title={t("taskManager.vitals.disk")}
        label={t("taskManager.vitals.disk")}
        sub={
          busiestDisk
            ? t("taskManager.vitals.diskActive", { value: Math.round(busiestDisk.active) })
            : undefined
        }
        value={disk.value}
        unit={disk.unit}
        series={[{ points: historyValues(history, "diskTotal"), color: CHART_COLORS.diskRead }]}
        max={rateCeiling(peakOf(history, "diskTotal", DISK_FLOOR))}
        onOpen={() => open(busiestDisk ? `disk:${busiestDisk.info.index}` : "")}
      />

      <Vital
        title={t("taskManager.vitals.network")}
        label={t("taskManager.vitals.network")}
        sub={t("taskManager.vitals.netRates", {
          received: formatRate(netRx),
          sent: formatRate(netTx),
        })}
        value={net.value}
        unit={net.unit}
        series={[{ points: historyValues(history, "netTotal"), color: CHART_COLORS.netReceived }]}
        max={rateCeiling(peakOf(history, "netTotal", NET_FLOOR))}
        onOpen={() => open(hardware.nics[0] ? `nic:${hardware.nics[0].info.id}` : "")}
      />

      {busiestGpu ? (
        <Vital
          title="GPU"
          label="GPU"
          sub={
            busiestGpu.temperature !== null ? `${Math.round(busiestGpu.temperature)} °C` : undefined
          }
          value={String(Math.round(busiestGpu.util))}
          unit="%"
          series={[{ points: historyValues(history, "gpu"), color: CHART_COLORS.gpu }]}
          max={100}
          onOpen={() => open(`gpu:${busiestGpu.info.id}`)}
        />
      ) : null}
    </section>
  );
}
