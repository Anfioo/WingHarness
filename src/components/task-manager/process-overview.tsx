// What the details panel shows with no process selected: this computer's
// parts, one line each, and a way to open that device on the performance tab.
// A compact relative of the performance page's device list.

import type { ReactNode } from "react";
import {
  BatteryCharging,
  CircuitBoard,
  Cpu,
  HardDrive,
  MemoryStick,
  MonitorCog,
  Network,
} from "lucide-react";
import type { Snapshot } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager } from "@/hooks/use-task-manager";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { requestPerformanceTarget } from "@/lib/task-manager/performance-target";
import { formatBytes, formatGigabytes, formatLinkSpeed, formatPercent } from "./format";

type Part = {
  /** The device on the performance tab, named the way the vitals band names it. */
  device: string;
  kind: string;
  name: string;
  detail: string;
  color: string;
  icon: ReactNode;
};

function joined(...items: unknown[]): string {
  return items
    .filter((item): item is string => typeof item === "string" && item !== "")
    .join(" · ");
}

function partsOf(
  snapshot: Snapshot,
  t: (key: string, options?: Record<string, unknown>) => string
): Part[] {
  const { system, hardware } = snapshot;
  const parts: Part[] = [
    {
      device: "cpu",
      kind: t("taskManager.overview.kind.cpu"),
      name: hardware.cpu.name,
      detail: joined(
        t("taskManager.overview.cpuDetail", {
          cores: hardware.cpu.cores,
          threads: hardware.cpu.logical,
        }),
        hardware.cpu.baseMhz > 0 && `${(hardware.cpu.baseMhz / 1000).toFixed(2)} GHz`
      ),
      color: CHART_COLORS.cpu,
      icon: <Cpu className="size-4" aria-hidden />,
    },
    {
      device: "memory",
      kind: t("taskManager.overview.kind.memory"),
      name: formatGigabytes(hardware.memory.installed || system.memTotal, 0),
      detail: joined(
        hardware.memory.speed !== null && `${hardware.memory.speed} MT/s`,
        hardware.memory.slotsTotal > 0 &&
          t("taskManager.overview.slots", {
            used: hardware.memory.slotsUsed,
            total: hardware.memory.slotsTotal,
          }),
        hardware.memory.kind
      ),
      color: CHART_COLORS.memory,
      icon: <MemoryStick className="size-4" aria-hidden />,
    },
  ];

  for (const disk of hardware.disks) {
    parts.push({
      device: `disk:${disk.info.index}`,
      kind: t("taskManager.overview.kind.disk"),
      name: disk.info.model || t("taskManager.performance.disk.volume", { index: disk.info.index }),
      detail: joined(
        disk.info.size > 0 && formatBytes(disk.info.size, 0),
        disk.info.volumes.join(" "),
        disk.active > 0 && t("taskManager.vitals.diskActive", { value: Math.round(disk.active) }),
        disk.temperature !== null && `${Math.round(disk.temperature)} °C`
      ),
      color: CHART_COLORS.diskRead,
      icon: <HardDrive className="size-4" aria-hidden />,
    });
  }

  for (const nic of hardware.nics) {
    if (nic.info.kind === "virtual") continue;
    parts.push({
      device: `nic:${nic.info.id}`,
      kind: t("taskManager.overview.kind.network"),
      name: nic.info.description || nic.info.name,
      detail: joined(
        t(`taskManager.performance.network.kind.${nic.info.kind}`),
        nic.info.linkSpeed > 0 && formatLinkSpeed(nic.info.linkSpeed)
      ),
      color: CHART_COLORS.netReceived,
      icon: <Network className="size-4" aria-hidden />,
    });
  }

  for (const gpu of hardware.gpus) {
    parts.push({
      device: `gpu:${gpu.info.id}`,
      kind: t("taskManager.overview.kind.gpu"),
      name: gpu.info.name,
      detail: joined(
        gpu.info.dedicatedTotal > 0
          ? t("taskManager.overview.vram", { size: formatGigabytes(gpu.info.dedicatedTotal, 0) })
          : t("taskManager.overview.sharedMemory"),
        formatPercent(gpu.util, 0)
      ),
      color: CHART_COLORS.gpu,
      icon: <CircuitBoard className="size-4" aria-hidden />,
    });
  }

  for (const battery of hardware.batteries) {
    parts.push({
      device: `bat:${battery.info.id}`,
      kind: t("taskManager.overview.kind.battery"),
      name:
        joined(battery.info.manufacturer, battery.info.name) ||
        t("taskManager.performance.battery.title"),
      detail: formatPercent(battery.percent, 0),
      color: CHART_COLORS.battery,
      icon: <BatteryCharging className="size-4" aria-hidden />,
    });
  }

  return parts;
}

export function ProcessOverview() {
  const { t } = useAppTranslation();
  const page = useTaskManager();
  const snapshot = page.snapshot;
  const parts = snapshot ? partsOf(snapshot, t) : [];

  const open = (device: string) => {
    requestPerformanceTarget(device);
    page.setActiveTab("performance");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="flex items-start gap-2.5">
        <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
          <MonitorCog className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">{t("taskManager.overview.title")}</div>
          <div className="text-muted-foreground text-xs">{t("taskManager.overview.hint")}</div>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-0.5">
        {parts.map((part) => (
          <button
            key={part.device}
            type="button"
            title={t("taskManager.vitals.open", { device: part.name })}
            onClick={() => open(part.device)}
            className="hover:bg-muted/60 focus-visible:ring-ring/50 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-md"
              style={{
                color: part.color,
                backgroundColor: `color-mix(in srgb, ${part.color} 12%, transparent)`,
              }}
            >
              {part.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-muted-foreground block text-[11px]">{part.kind}</span>
              <span className="block truncate text-xs font-medium">{part.name}</span>
              {part.detail ? (
                <span className="text-muted-foreground block truncate text-[11px]">
                  {part.detail}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
