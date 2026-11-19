// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The CPU detail view: total (user and kernel) or per-logical-processor charts,
// with the hybrid-core P/E filter, the live figures and the processor facts.

import { useState } from "react";
import { formatBytes, formatDuration, formatPercent } from "@/components/task-manager/format";
import { CoreGrid } from "@/components/task-manager/core-grid";
import {
  PerformanceDetailHeader,
  PerformanceSpec,
  PerformanceSpecs,
  PerformanceStat,
  SegmentedControl,
  type PerformanceData,
} from "@/components/task-manager/performance-panel";
import { TraceChart } from "@/components/task-manager/trace-chart";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { historyValues } from "@/lib/task-manager/chart-history";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";

type CpuMode = "overall" | "logical";
type CoreFilter = "all" | "p" | "e";

export function PerformanceCpu({ snapshot, history }: PerformanceData) {
  const { t } = useAppTranslation();
  const { system, hardware } = snapshot;
  const cpu = hardware.cpu;
  const hybrid = cpu.performanceCores > 0;
  const [mode, setMode] = useState<CpuMode>("overall");
  const [filter, setFilter] = useState<CoreFilter>("all");

  const effectiveFilter = hybrid ? filter : "all";
  const indices = system.cores
    .map((_, index) => index)
    .filter((index) => {
      if (effectiveFilter === "all") return true;
      const efficient = cpu.threads[index]?.efficient ?? false;
      return effectiveFilter === "e" ? efficient : !efficient;
    });

  const coresText =
    cpu.performanceCores > 0
      ? t("taskManager.performance.cpu.coresHybrid", {
          cores: cpu.cores,
          performance: cpu.performanceCores,
          efficiency: cpu.efficiencyCores,
        })
      : String(cpu.cores);

  return (
    <div className="flex flex-col gap-4">
      <PerformanceDetailHeader title={t("taskManager.performance.cpu.title")} model={cpu.name}>
        {hybrid && mode === "logical" && (
          <SegmentedControl<CoreFilter>
            label={t("taskManager.performance.cpu.coreType")}
            value={filter}
            options={[
              { value: "all", label: t("taskManager.performance.cpu.filter.all") },
              { value: "p", label: t("taskManager.performance.cpu.filter.p") },
              { value: "e", label: t("taskManager.performance.cpu.filter.e") },
            ]}
            onChange={setFilter}
          />
        )}
        <SegmentedControl<CpuMode>
          label={t("taskManager.performance.cpu.mode")}
          value={mode}
          options={[
            { value: "overall", label: t("taskManager.performance.cpu.overall") },
            { value: "logical", label: t("taskManager.performance.cpu.logical") },
          ]}
          onChange={setMode}
        />
      </PerformanceDetailHeader>

      {mode === "overall" ? (
        <TraceChart
          series={[
            {
              label: t("taskManager.performance.cpu.total"),
              color: CHART_COLORS.cpu,
              points: historyValues(history, "cpu"),
              fill: true,
            },
            {
              label: t("taskManager.performance.cpu.kernel"),
              color: CHART_COLORS.cpu,
              points: historyValues(history, "cpuKernel"),
              dashed: true,
            },
          ]}
          max={100}
          unit="percent"
          height={180}
          label={t("taskManager.performance.chart.label")}
        />
      ) : (
        <CoreGrid
          indices={indices}
          cores={system.cores}
          threads={cpu.threads}
          coreMhz={hardware.coreMhz}
          history={history}
          hybrid={hybrid}
        />
      )}

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        <PerformanceStat
          label={t("taskManager.performance.cpu.utilization")}
          value={formatPercent(system.cpu, 0)}
        />
        {hardware.cpuMhz !== null && hardware.cpuMhz > 0 && (
          <PerformanceStat
            label={t("taskManager.performance.cpu.speed")}
            value={`${(hardware.cpuMhz / 1000).toFixed(2)} GHz`}
          />
        )}
        <PerformanceStat
          label={t("taskManager.performance.cpu.processes")}
          value={system.processCount.toLocaleString()}
        />
        <PerformanceStat
          label={t("taskManager.performance.cpu.threads")}
          value={system.threadCount.toLocaleString()}
        />
        <PerformanceStat
          label={t("taskManager.performance.cpu.handles")}
          value={system.handleCount.toLocaleString()}
        />
        <PerformanceStat
          label={t("taskManager.performance.cpu.uptime")}
          value={formatDuration(system.uptimeMs)}
        />
      </div>

      <PerformanceSpecs>
        <PerformanceSpec label={t("taskManager.performance.cpu.baseSpeed")}>
          {cpu.baseMhz > 0 ? `${(cpu.baseMhz / 1000).toFixed(2)} GHz` : "—"}
        </PerformanceSpec>
        <PerformanceSpec label={t("taskManager.performance.cpu.sockets")}>
          {cpu.sockets}
        </PerformanceSpec>
        <PerformanceSpec label={t("taskManager.performance.cpu.coreCount")}>
          {coresText}
        </PerformanceSpec>
        <PerformanceSpec label={t("taskManager.performance.cpu.logicalProcessors")}>
          {cpu.logical}
        </PerformanceSpec>
        <PerformanceSpec label={t("taskManager.performance.cpu.virtualization")}>
          {t(
            cpu.virtualization
              ? "taskManager.performance.cpu.enabled"
              : "taskManager.performance.cpu.notEnabled"
          )}
        </PerformanceSpec>
        {(["l1", "l2", "l3"] as const).map((level) =>
          cpu[level] > 0 ? (
            <PerformanceSpec
              key={level}
              label={t("taskManager.performance.cpu.cache", { level: level.slice(1) })}
            >
              {formatBytes(cpu[level])}
            </PerformanceSpec>
          ) : null
        )}
      </PerformanceSpecs>
    </div>
  );
}
