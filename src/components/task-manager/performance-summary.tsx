// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The five summary cards: the current reading and the highest one in the
// rolling window. Clicking a card scrolls to the panel behind it.

import type { Snapshot } from "@/commands";
import { formatBytes, formatPercent, formatRate } from "@/components/task-manager/format";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import {
  historyCombinedPeak,
  historyPeak,
  type ChartHistory,
} from "@/lib/task-manager/chart-history";

type Card = {
  target: string;
  label: string;
  color: string;
  value: string;
  detail?: string;
  percent: number;
  peak: string;
};

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

function scrollToPanel(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function PerformanceSummary({
  snapshot,
  history,
}: {
  snapshot: Snapshot;
  history: ChartHistory;
}) {
  const { t } = useAppTranslation();
  const { system, hardware } = snapshot;

  const memPercent = system.memTotal > 0 ? (system.memUsed / system.memTotal) * 100 : Number.NaN;
  const diskRead = hardware.disks.reduce((sum, disk) => sum + disk.read, 0);
  const diskWrite = hardware.disks.reduce((sum, disk) => sum + disk.write, 0);
  const diskBusy = hardware.disks.reduce((busiest, disk) => Math.max(busiest, disk.active), 0);
  const netRx = hardware.nics.reduce((sum, nic) => sum + nic.rx, 0);
  const netTx = hardware.nics.reduce((sum, nic) => sum + nic.tx, 0);
  const linkSpeed = hardware.nics.reduce((sum, nic) => sum + nic.info.linkSpeed, 0);
  const gpu =
    hardware.gpus.length === 0 ? null : Math.max(...hardware.gpus.map((entry) => entry.util));
  const gpuMemory = hardware.gpus.reduce(
    (sum, entry) => ({
      used: sum.used + entry.dedicatedUsed,
      total: sum.total + entry.info.dedicatedTotal,
    }),
    { used: 0, total: 0 }
  );

  const diskPeak = historyCombinedPeak(history, ["diskRead", "diskWrite"]);
  const netPeak = historyCombinedPeak(history, ["netRx", "netTx"]);

  const cards: Card[] = [
    {
      target: "performance-cpu",
      label: t("taskManager.performance.cpu.title"),
      color: CHART_COLORS.cpu,
      value: formatPercent(system.cpu, 0),
      percent: clampPercent(system.cpu),
      peak: formatPercent(historyPeak(history, "cpu") ?? Number.NaN, 0),
    },
    {
      target: "performance-memory",
      label: t("taskManager.performance.memory.title"),
      color: CHART_COLORS.memory,
      value: formatPercent(memPercent, 0),
      detail: `${formatBytes(system.memUsed)} / ${formatBytes(system.memTotal)}`,
      percent: clampPercent(memPercent),
      peak: formatBytes(historyPeak(history, "mem") ?? Number.NaN),
    },
    {
      target: "performance-disk",
      label: t("taskManager.performance.disk.title"),
      color: CHART_COLORS.diskRead,
      value: formatRate(hardware.disks.length > 0 ? diskRead + diskWrite : Number.NaN),
      detail:
        hardware.disks.length > 0
          ? `${t("taskManager.performance.disk.active")} ${formatPercent(diskBusy, 0)}`
          : t("taskManager.performance.disk.empty"),
      percent: clampPercent(diskBusy),
      peak: formatRate(diskPeak ?? Number.NaN),
    },
    {
      target: "performance-network",
      label: t("taskManager.performance.network.title"),
      color: CHART_COLORS.netReceived,
      value: formatRate(hardware.nics.length > 0 ? netRx + netTx : Number.NaN),
      detail:
        hardware.nics.length > 0
          ? `${t("taskManager.performance.network.received")} ${formatRate(netRx)} · ${t(
              "taskManager.performance.network.sent"
            )} ${formatRate(netTx)}`
          : t("taskManager.performance.network.empty"),
      percent: clampPercent(linkSpeed > 0 ? ((netRx + netTx) * 8 * 100) / linkSpeed : 0),
      peak: formatRate(netPeak ?? Number.NaN),
    },
    {
      target: "performance-gpu",
      label: t("taskManager.performance.gpu.title"),
      color: CHART_COLORS.gpu,
      value: formatPercent(gpu ?? Number.NaN, 0),
      detail:
        gpuMemory.total > 0
          ? `${t("taskManager.performance.gpu.memory")} ${formatBytes(gpuMemory.used)} / ${formatBytes(
              gpuMemory.total
            )}`
          : undefined,
      percent: clampPercent(gpu ?? 0),
      peak: formatPercent(historyPeak(history, "gpu") ?? Number.NaN, 0),
    },
  ];

  return (
    <section
      aria-label={t("taskManager.performance.summary.label")}
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
    >
      {cards.map((card) => (
        <button
          key={card.target}
          type="button"
          onClick={() => scrollToPanel(card.target)}
          className="border-border bg-card hover:border-primary/50 hover:bg-accent/40 flex min-w-0 flex-col gap-2 rounded-xl border p-3 text-left transition-colors"
        >
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">{card.label}</span>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: card.color }}
            />
          </span>
          <span className="text-xl leading-none font-semibold tabular-nums">{card.value}</span>
          <span className="bg-muted h-1 overflow-hidden rounded-full">
            <span
              className="block h-full rounded-full"
              style={{ width: `${card.percent}%`, backgroundColor: card.color }}
            />
          </span>
          {card.detail && (
            <span className="text-muted-foreground truncate text-[10px]" title={card.detail}>
              {card.detail}
            </span>
          )}
          <span className="text-muted-foreground flex items-baseline justify-between gap-2 text-[10px]">
            <span>{t("taskManager.performance.summary.peak")}</span>
            <span className="text-foreground tabular-nums">{card.peak}</span>
          </span>
        </button>
      ))}
    </section>
  );
}
