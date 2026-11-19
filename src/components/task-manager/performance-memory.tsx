// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The memory detail view: the used curve, the disjoint composition of physical
// memory, the paging pools and the installed modules' facts.

import { formatBytes, formatPercent } from "@/components/task-manager/format";
import { MemoryComposition } from "@/components/task-manager/memory-composition";
import {
  PerformanceDetailHeader,
  PerformanceSpec,
  PerformanceSpecs,
  PerformanceStat,
  PerformanceStats,
  PerformanceSummary,
  type PerformanceData,
} from "@/components/task-manager/performance-panel";
import { TraceChart } from "@/components/task-manager/trace-chart";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { historySpanSeconds, historyValues } from "@/lib/task-manager/chart-history";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { memoryComposition } from "@/lib/task-manager/chart-memory";

export function PerformanceMemory({ snapshot, history, intervalMs }: PerformanceData) {
  const { t } = useAppTranslation();
  const { system, hardware } = snapshot;
  const memory = hardware.memory;
  const composition = memoryComposition(system);
  const percent = system.memTotal > 0 ? (system.memUsed / system.memTotal) * 100 : Number.NaN;
  const installed = memory.installed || system.memTotal;
  const reserved = Math.max(0, memory.installed - system.memTotal);
  const spanSeconds = historySpanSeconds(intervalMs);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PerformanceDetailHeader
        title={t("taskManager.performance.memory.title")}
        model={`${formatBytes(installed, 0)}${memory.kind ? ` ${memory.kind}` : ""}`}
      />

      <TraceChart
        title={t("taskManager.performance.memory.title")}
        series={[
          {
            label: t("taskManager.performance.memory.used"),
            color: CHART_COLORS.memory,
            points: historyValues(history, "mem"),
            fill: true,
          },
        ]}
        max={system.memTotal > 0 ? system.memTotal : 1}
        unit="bytes"
        spanSeconds={spanSeconds}
        fill
        label={t("taskManager.performance.chart.label", { seconds: spanSeconds })}
      />

      <MemoryComposition composition={composition} />

      <PerformanceSummary>
        <PerformanceStats>
          <PerformanceStat
            label={t("taskManager.performance.memory.used")}
            value={formatPercent(percent, 0)}
            detail={`${formatBytes(system.memUsed)} / ${formatBytes(system.memTotal)}`}
          />
          <PerformanceStat
            label={t("taskManager.performance.memory.available")}
            value={formatBytes(system.memAvailable)}
          />
          <PerformanceStat
            label={t("taskManager.performance.memory.commit")}
            value={formatBytes(system.commitUsed)}
            detail={`/ ${formatBytes(system.commitLimit)}`}
          />
          <PerformanceStat
            label={t("taskManager.performance.memory.cached")}
            value={formatBytes(system.cached)}
          />
          <PerformanceStat
            label={t("taskManager.performance.memory.pagedPool")}
            value={formatBytes(system.kernelPaged)}
          />
          <PerformanceStat
            label={t("taskManager.performance.memory.nonPagedPool")}
            value={formatBytes(system.kernelNonpaged)}
          />
        </PerformanceStats>
        <PerformanceSpecs>
          <PerformanceSpec label={t("taskManager.performance.memory.installed")}>
            {formatBytes(installed, 0)}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.memory.speed")}>
            {memory.speed ? `${memory.speed} MT/s` : "—"}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.memory.slots")}>
            {memory.slotsTotal > 0 ? `${memory.slotsUsed} / ${memory.slotsTotal}` : "—"}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.memory.formFactor")}>
            {memory.formFactor === "onboard"
              ? t("taskManager.performance.memory.onboard")
              : (memory.formFactor ?? "—")}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.memory.type")}>
            {memory.kind ?? "—"}
          </PerformanceSpec>
          {reserved > 0 && (
            <PerformanceSpec label={t("taskManager.performance.memory.reserved")}>
              {formatBytes(reserved, 0)}
            </PerformanceSpec>
          )}
        </PerformanceSpecs>
      </PerformanceSummary>
    </div>
  );
}
