// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Physical memory: the used curve, the commit against its limit, the cache,
// and the disjoint composition of what is installed.

import { formatBytes, formatPercent } from "@/components/task-manager/format";
import { MemoryComposition } from "@/components/task-manager/memory-composition";
import {
  PerformancePanel,
  PerformanceStat,
  type PerformanceData,
} from "@/components/task-manager/performance-panel";
import { TraceChart } from "@/components/task-manager/trace-chart";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { historyValues } from "@/lib/task-manager/chart-history";
import { memoryComposition } from "@/lib/task-manager/chart-memory";

export function PerformanceMemory({ snapshot, history }: PerformanceData) {
  const { t } = useAppTranslation();
  const { system } = snapshot;
  const composition = memoryComposition(system);
  const percent = system.memTotal > 0 ? (system.memUsed / system.memTotal) * 100 : Number.NaN;

  return (
    <PerformancePanel
      id="performance-memory"
      title={t("taskManager.performance.memory.title")}
      description={`${formatBytes(system.memUsed)} / ${formatBytes(system.memTotal)}`}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <PerformanceStat
          label={t("taskManager.performance.memory.used")}
          value={formatPercent(percent, 0)}
          detail={`${formatBytes(system.memUsed)} / ${formatBytes(system.memTotal)}`}
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
      </div>

      <TraceChart
        series={[
          {
            label: t("taskManager.performance.memory.used"),
            color: CHART_COLORS.memory,
            points: historyValues(history, "mem"),
            fill: true,
          },
        ]}
        max={system.memTotal}
        unit="bytes"
        height={120}
        label={t("taskManager.performance.chart.label")}
      />

      <MemoryComposition composition={composition} />
    </PerformancePanel>
  );
}
