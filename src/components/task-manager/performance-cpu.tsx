// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Total processor load over the window, with one bar per logical processor.
// The frequency row stays hidden while the sampler has no frequency source.

import { formatPercent } from "@/components/task-manager/format";
import { CoreGrid } from "@/components/task-manager/core-grid";
import {
  PerformancePanel,
  PerformanceStat,
  type PerformanceData,
} from "@/components/task-manager/performance-panel";
import { TraceChart } from "@/components/task-manager/trace-chart";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { historyValues } from "@/lib/task-manager/chart-history";

export function PerformanceCpu({ snapshot, history }: PerformanceData) {
  const { t } = useAppTranslation();
  const { system, hardware } = snapshot;
  const speed = hardware.cpuMhz;

  return (
    <PerformancePanel
      id="performance-cpu"
      title={t("taskManager.performance.cpu.title")}
      description={hardware.cpu.name}
    >
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <PerformanceStat
          label={t("taskManager.performance.cpu.utilization")}
          value={formatPercent(system.cpu, 0)}
        />
        {speed !== null && speed > 0 && (
          <PerformanceStat
            label={t("taskManager.performance.cpu.speed")}
            value={`${(speed / 1000).toFixed(2)} GHz`}
          />
        )}
        <PerformanceStat
          label={t("taskManager.performance.cpu.cores")}
          value={system.logicalCpus}
        />
      </div>

      <TraceChart
        series={[
          {
            label: t("taskManager.performance.cpu.total"),
            color: CHART_COLORS.cpu,
            points: historyValues(history, "cpu"),
            fill: true,
          },
        ]}
        max={100}
        unit="percent"
        height={132}
        label={t("taskManager.performance.chart.label")}
      />

      {system.cores.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">{t("taskManager.performance.cpu.cores")}</h3>
          <CoreGrid cores={system.cores} coreMhz={hardware.coreMhz} />
        </div>
      )}
    </PerformancePanel>
  );
}
