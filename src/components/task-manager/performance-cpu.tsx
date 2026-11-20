// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The CPU detail view: total (user and kernel) or per-logical-processor charts,
// with the hybrid-core P/E filter, the live figures and the processor facts.

import { useState } from "react";
import { formatBytes, formatPercent } from "@/components/task-manager/format";
import { CoreGrid } from "@/components/task-manager/core-grid";
import {
  PerformanceDetailHeader,
  PerformanceSpec,
  PerformanceSpecs,
  PerformanceStat,
  PerformanceStats,
  PerformanceSummary,
  SegmentedControl,
  type PerformanceData,
} from "@/components/task-manager/performance-panel";
import { TraceChart } from "@/components/task-manager/trace-chart";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { historySpanSeconds, historyValues } from "@/lib/task-manager/chart-history";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";

type CpuMode = "overall" | "logical";
type CoreFilter = "all" | "p" | "e";

/** Uptime to the second: days, then hh:mm:ss, so the figure keeps its width. */
function uptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(Math.floor((total % 86400) / 3600))}:${pad(
    Math.floor((total % 3600) / 60)
  )}:${pad(total % 60)}`;
  const days = Math.floor(total / 86400);
  return days > 0 ? `${days}d ${clock}` : clock;
}

export function PerformanceCpu({ snapshot, history, intervalMs }: PerformanceData) {
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

  const spanSeconds = historySpanSeconds(intervalMs);

  /** The mean clock of the P or E cores, or null when the CPU does not report one. */
  const meanMhz = (efficient: boolean): number | null => {
    const values = hardware.coreMhz.filter(
      (mhz, index) => (cpu.threads[index]?.efficient ?? false) === efficient && mhz > 0
    );
    if (values.length === 0) return null;
    return values.reduce((sum, mhz) => sum + mhz, 0) / values.length;
  };
  const pMhz = hybrid ? meanMhz(false) : null;
  const eMhz = hybrid ? meanMhz(true) : null;

  return (
    <div className="flex min-h-full flex-col gap-4">
      <PerformanceDetailHeader title={t("taskManager.performance.cpu.title")} model={cpu.name} />

      <div className="-mt-1 flex flex-wrap items-center justify-end gap-2">
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
      </div>

      {mode === "overall" ? (
        <TraceChart
          className="-mb-1"
          title={t("taskManager.performance.cpu.utilization")}
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
              fill: true,
              dashed: true,
            },
          ]}
          max={100}
          unit="percent"
          spanSeconds={spanSeconds}
          fill
          label={t("taskManager.performance.chart.label", { seconds: spanSeconds })}
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

      <PerformanceSummary>
        <PerformanceStats>
          <PerformanceStat
            label={t("taskManager.performance.cpu.utilization")}
            value={formatPercent(system.cpu, 0)}
          />
          <PerformanceStat
            label={t("taskManager.performance.cpu.speed")}
            value={`${((hardware.cpuMhz ?? 0) / 1000).toFixed(2)} GHz`}
          />
          {pMhz !== null && (
            <PerformanceStat
              label={t("taskManager.performance.cpu.pCoreSpeed")}
              value={`${(pMhz / 1000).toFixed(2)} GHz`}
            />
          )}
          {eMhz !== null && (
            <PerformanceStat
              label={t("taskManager.performance.cpu.eCoreSpeed")}
              value={`${(eMhz / 1000).toFixed(2)} GHz`}
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
            value={uptime(system.uptimeMs)}
          />
        </PerformanceStats>
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
          {(["l1", "l2", "l3"] as const).map((level) => (
            <PerformanceSpec
              key={level}
              label={t("taskManager.performance.cpu.cache", { level: level.slice(1) })}
            >
              {cpu[level] > 0 ? formatBytes(cpu[level]) : "—"}
            </PerformanceSpec>
          ))}
        </PerformanceSpecs>
      </PerformanceSummary>
    </div>
  );
}
