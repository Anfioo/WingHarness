// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Disk throughput: the summed read and write curves, then one row per disk
// with its own rates and the share of time it was busy.

import { formatBytes, formatPercent, formatRate } from "@/components/task-manager/format";
import {
  PerformanceEmpty,
  PerformancePanel,
  PerformanceStat,
  type PerformanceData,
} from "@/components/task-manager/performance-panel";
import { TraceChart } from "@/components/task-manager/trace-chart";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { historyPeak, historyValues } from "@/lib/task-manager/chart-history";
import { rateCeiling } from "@/lib/task-manager/chart-scale";

export function PerformanceDisk({ snapshot, history }: PerformanceData) {
  const { t } = useAppTranslation();
  const disks = snapshot.hardware.disks;
  const totalRead = disks.reduce((sum, disk) => sum + disk.read, 0);
  const totalWrite = disks.reduce((sum, disk) => sum + disk.write, 0);
  const peak = Math.max(
    historyPeak(history, "diskRead") ?? 0,
    historyPeak(history, "diskWrite") ?? 0,
    1024
  );

  return (
    <PerformancePanel id="performance-disk" title={t("taskManager.performance.disk.title")}>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <PerformanceStat
          label={t("taskManager.performance.disk.read")}
          value={formatRate(totalRead)}
        />
        <PerformanceStat
          label={t("taskManager.performance.disk.write")}
          value={formatRate(totalWrite)}
        />
      </div>

      {disks.length === 0 ? (
        <PerformanceEmpty>{t("taskManager.performance.disk.empty")}</PerformanceEmpty>
      ) : (
        <>
          <TraceChart
            series={[
              {
                label: t("taskManager.performance.disk.read"),
                color: CHART_COLORS.diskRead,
                points: historyValues(history, "diskRead"),
              },
              {
                label: t("taskManager.performance.disk.write"),
                color: CHART_COLORS.diskWrite,
                points: historyValues(history, "diskWrite"),
              },
            ]}
            max={rateCeiling(peak)}
            unit="rate"
            height={120}
            label={t("taskManager.performance.chart.label")}
          />

          <ul className="flex flex-col gap-2">
            {disks.map((disk) => (
              <li
                key={`${disk.info.index}-${disk.info.model}`}
                className="border-border/60 flex flex-wrap items-center justify-between gap-2 border-t pt-2 first:border-t-0 first:pt-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">
                    {disk.info.model ||
                      t("taskManager.performance.disk.volume", { index: disk.info.index })}
                  </p>
                  {disk.info.volumes.length > 0 && (
                    <p className="text-muted-foreground truncate text-[10px]">
                      {disk.info.volumes.join(" ")}
                    </p>
                  )}
                </div>
                <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
                  <span>
                    {t("taskManager.performance.disk.read")} {formatRate(disk.read)}
                  </span>
                  <span>
                    {t("taskManager.performance.disk.write")} {formatRate(disk.write)}
                  </span>
                  <span>
                    {t("taskManager.performance.disk.active")} {formatPercent(disk.active, 0)}
                  </span>
                  {disk.info.size > 0 && <span>{formatBytes(disk.info.size)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </PerformancePanel>
  );
}
