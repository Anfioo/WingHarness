// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The performance tab's device list: one entry per CPU, memory, disk, adapter,
// GPU and battery, each with its current reading and a sparkline. Selecting an
// entry switches the detail view; the key stays valid as long as the device
// exists.

import { useMemo } from "react";
import type { Snapshot } from "@/commands";
import { ChartFrame } from "@/components/task-manager/chart-frame";
import {
  formatGigabytes,
  formatPercent,
  formatRate,
  formatRemainingTime,
  formatWatts,
} from "@/components/task-manager/format";
import { Sparkline, type SparkSeries } from "@/components/task-manager/sparkline";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { historyPeak, historyValues, type ChartHistory } from "@/lib/task-manager/chart-history";
import { rateCeiling } from "@/lib/task-manager/chart-scale";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { cn } from "@/lib/utils";

export type PerformanceDeviceKind = "cpu" | "memory" | "disk" | "nic" | "gpu" | "battery";

export type PerformanceDevice = {
  key: string;
  kind: PerformanceDeviceKind;
  /** Disk number, for `kind === "disk"`. */
  index?: number;
  /** Adapter LUID, GPU LUID or battery id, for the other device kinds. */
  id?: string;
  title: string;
  subtitle: string;
  color: string;
  series: { key: string; color: string; dashed?: boolean }[];
  max: number;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A disk's medium and bus, e.g. `SSD (NVMe)`. */
export function diskKind(disk: Snapshot["hardware"]["disks"][number], t: Translate): string {
  const bus =
    disk.info.bus === "nvme"
      ? "NVMe"
      : disk.info.bus === "usb"
        ? "USB"
        : disk.info.bus === "sata"
          ? "SATA"
          : disk.info.bus === "sd"
            ? "SD"
            : "";
  const media =
    disk.info.ssd === true
      ? "SSD"
      : disk.info.ssd === false
        ? "HDD"
        : disk.info.removable
          ? t("taskManager.performance.disk.removableMedia")
          : "";
  return [media, bus && `(${bus})`].filter(Boolean).join(" ");
}

export function diskTitle(disk: Snapshot["hardware"]["disks"][number], t: Translate): string {
  const volume = t("taskManager.performance.disk.volume", { index: disk.info.index });
  return disk.info.volumes.length ? `${volume} (${disk.info.volumes.join(" ")})` : volume;
}

/** Every device the page can show, in the order the list presents them. */
export function buildPerformanceDevices(
  snapshot: Snapshot,
  history: ChartHistory,
  t: Translate
): PerformanceDevice[] {
  const { system, hardware } = snapshot;
  const memPercent = system.memTotal > 0 ? (system.memUsed / system.memTotal) * 100 : Number.NaN;
  const devices: PerformanceDevice[] = [
    {
      key: "cpu",
      kind: "cpu",
      title: "CPU",
      subtitle: `${formatPercent(system.cpu, 0)}${
        hardware.cpuMhz ? `  ${(hardware.cpuMhz / 1000).toFixed(2)} GHz` : ""
      }`,
      color: CHART_COLORS.cpu,
      series: [{ key: "cpu", color: CHART_COLORS.cpu }],
      max: 100,
    },
    {
      key: "memory",
      kind: "memory",
      title: t("taskManager.performance.memory.title"),
      subtitle: `${formatGigabytes(system.memUsed)} / ${formatGigabytes(
        system.memTotal
      )} (${formatPercent(memPercent, 0)})`,
      color: CHART_COLORS.memory,
      series: [{ key: "mem", color: CHART_COLORS.memory }],
      max: system.memTotal > 0 ? system.memTotal : 1,
    },
  ];

  for (const disk of hardware.disks) {
    const prefix = `disk.${disk.info.index}`;
    devices.push({
      key: prefix,
      kind: "disk",
      index: disk.info.index,
      title: diskTitle(disk, t),
      subtitle: [
        diskKind(disk, t),
        formatPercent(disk.active, 0),
        disk.temperature !== null && `${Math.round(disk.temperature)} °C`,
      ]
        .filter(Boolean)
        .join(" · "),
      color: CHART_COLORS.diskRead,
      series: [{ key: `${prefix}.active`, color: CHART_COLORS.diskRead }],
      max: 100,
    });
  }

  for (const nic of hardware.nics) {
    const prefix = `nic.${nic.info.id}`;
    devices.push({
      key: prefix,
      kind: "nic",
      id: nic.info.id,
      title: nic.info.name,
      subtitle: `↓ ${formatRate(nic.rx)} · ↑ ${formatRate(nic.tx)}`,
      color: CHART_COLORS.netReceived,
      series: [
        { key: `${prefix}.rx`, color: CHART_COLORS.netReceived },
        { key: `${prefix}.tx`, color: CHART_COLORS.netSent, dashed: true },
      ],
      max: rateCeiling(
        Math.max(
          historyPeak(history, `${prefix}.rx`) ?? 0,
          historyPeak(history, `${prefix}.tx`) ?? 0,
          16 * 1024
        )
      ),
    });
  }

  hardware.gpus.forEach((gpu, index) => {
    const prefix = `gpu.${gpu.info.id}`;
    devices.push({
      key: prefix,
      kind: "gpu",
      id: gpu.info.id,
      title: `GPU ${index}`,
      subtitle: [
        formatPercent(gpu.util, 0),
        gpu.temperature !== null && `${Math.round(gpu.temperature)} °C`,
        gpu.boardPower !== null && formatWatts(gpu.boardPower),
      ]
        .filter(Boolean)
        .join(" · "),
      color: CHART_COLORS.gpu,
      series: [{ key: `${prefix}.util`, color: CHART_COLORS.gpu }],
      max: 100,
    });
  });

  for (const battery of hardware.batteries) {
    const prefix = `bat.${battery.info.id}`;
    devices.push({
      key: prefix,
      kind: "battery",
      id: battery.info.id,
      title:
        hardware.batteries.length > 1
          ? t("taskManager.performance.battery.titleNumbered", { id: battery.info.id })
          : t("taskManager.performance.battery.title"),
      subtitle: `${formatPercent(battery.percent, 0)} · ${
        battery.state === "discharging" && battery.remaining !== null
          ? t("taskManager.performance.battery.timeLeft", {
              time: formatRemainingTime(battery.remaining),
            })
          : t(`taskManager.performance.battery.state.${battery.state}`)
      }`,
      color: CHART_COLORS.battery,
      series: [{ key: `${prefix}.pct`, color: CHART_COLORS.battery }],
      max: 100,
    });
  }

  return devices;
}

export function PerformanceDeviceList({
  devices,
  selected,
  history,
  onSelect,
}: {
  devices: readonly PerformanceDevice[];
  selected: string;
  history: ChartHistory;
  onSelect: (key: string) => void;
}) {
  const { t } = useAppTranslation();

  const resolved = useMemo(
    () =>
      devices.map((device) => ({
        device,
        series: device.series.map(
          (entry): SparkSeries => ({
            points: historyValues(history, entry.key),
            color: entry.color,
            dashed: entry.dashed,
          })
        ),
      })),
    [devices, history]
  );

  return (
    <nav
      aria-label={t("taskManager.performance.devices.label")}
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
    >
      {resolved.map(({ device, series }) => (
        <button
          key={device.key}
          type="button"
          aria-current={selected === device.key ? "true" : undefined}
          onClick={() => onSelect(device.key)}
          className={cn(
            "relative grid w-full grid-cols-[minmax(0,1fr)_76px] items-center gap-2.5 rounded-md border py-2 pr-2 pl-3 text-left transition-colors",
            selected === device.key
              ? "border-border bg-accent text-accent-foreground"
              : "hover:bg-muted/60 border-transparent"
          )}
        >
          {selected === device.key && (
            <span
              aria-hidden
              className="bg-primary absolute top-1/2 left-0 h-[18px] w-[3px] -translate-y-1/2 rounded-sm"
            />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-semibold" title={device.title}>
              {device.title}
            </span>
            <span className="text-muted-foreground truncate text-[12px] tabular-nums">
              {device.subtitle}
            </span>
          </span>
          <ChartFrame
            grid={false}
            color={device.color}
            className="relative h-10 w-[76px] shrink-0 overflow-hidden rounded-[3px]"
          >
            <Sparkline series={series} max={device.max} />
          </ChartFrame>
        </button>
      ))}
    </nav>
  );
}
