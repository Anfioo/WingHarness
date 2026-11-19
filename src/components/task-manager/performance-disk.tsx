// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// One physical disk: busy time, transfer rates, response time and the drive's
// facts. The device list chooses which disk this shows.

import { formatBytes, formatPercent, formatRate } from "@/components/task-manager/format";
import { diskKind, diskTitle } from "@/components/task-manager/performance-devices";
import {
  PerformanceDetailHeader,
  PerformanceEmpty,
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
import { rateCeiling } from "@/lib/task-manager/chart-scale";

export function PerformanceDisk({
  snapshot,
  history,
  intervalMs,
  index,
}: PerformanceData & { index: number }) {
  const { t } = useAppTranslation();
  const disk = snapshot.hardware.disks.find((entry) => entry.info.index === index);

  if (!disk) {
    return <PerformanceEmpty>{t("taskManager.performance.disk.removed")}</PerformanceEmpty>;
  }

  const prefix = `disk.${disk.info.index}`;
  const peak = Math.max(disk.read, disk.write, 1024);
  const spanSeconds = historySpanSeconds(intervalMs);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PerformanceDetailHeader
        title={diskTitle(disk, t)}
        model={disk.info.model || diskKind(disk, t)}
      />

      <TraceChart
        title={t("taskManager.performance.disk.active")}
        series={[
          {
            label: t("taskManager.performance.disk.active"),
            color: CHART_COLORS.diskRead,
            points: historyValues(history, `${prefix}.active`),
            fill: true,
          },
        ]}
        max={100}
        unit="percent"
        spanSeconds={spanSeconds}
        height={170}
        label={t("taskManager.performance.chart.label", { seconds: spanSeconds })}
      />

      <TraceChart
        title={t("taskManager.performance.disk.transferRate")}
        series={[
          {
            label: t("taskManager.performance.disk.read"),
            color: CHART_COLORS.diskRead,
            points: historyValues(history, `${prefix}.read`),
          },
          {
            label: t("taskManager.performance.disk.write"),
            color: CHART_COLORS.diskWrite,
            points: historyValues(history, `${prefix}.write`),
            dashed: true,
          },
        ]}
        max={rateCeiling(peak)}
        unit="rate"
        spanSeconds={spanSeconds}
        height={160}
        label={t("taskManager.performance.chart.label", { seconds: spanSeconds })}
      />

      <PerformanceSummary>
        <PerformanceStats>
          <PerformanceStat
            label={t("taskManager.performance.disk.active")}
            value={formatPercent(disk.active, 0)}
          />
          <PerformanceStat
            label={t("taskManager.performance.disk.responseTime")}
            value={`${disk.responseMs.toFixed(1)} ms`}
          />
          <PerformanceStat
            label={t("taskManager.performance.disk.read")}
            value={formatRate(disk.read)}
          />
          <PerformanceStat
            label={t("taskManager.performance.disk.write")}
            value={formatRate(disk.write)}
          />
          {disk.temperature !== null && (
            <PerformanceStat
              label={t("taskManager.performance.disk.temperature")}
              value={`${Math.round(disk.temperature)} °C`}
            />
          )}
        </PerformanceStats>
        <PerformanceSpecs>
          <PerformanceSpec label={t("taskManager.performance.disk.capacity")}>
            {disk.info.size > 0 ? formatBytes(disk.info.size, 0) : "—"}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.disk.type")}>
            {diskKind(disk, t) || "—"}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.disk.volumes")}>
            {disk.info.volumes.join(" ") || "—"}
          </PerformanceSpec>
          {disk.info.removable && (
            <PerformanceSpec label={t("taskManager.performance.disk.removable")}>
              {t("taskManager.performance.disk.yes")}
            </PerformanceSpec>
          )}
          {disk.temperatureWarning !== null && (
            <PerformanceSpec label={t("taskManager.performance.disk.warningTemperature")}>
              {`${Math.round(disk.temperatureWarning)} °C`}
            </PerformanceSpec>
          )}
        </PerformanceSpecs>
      </PerformanceSummary>
    </div>
  );
}
