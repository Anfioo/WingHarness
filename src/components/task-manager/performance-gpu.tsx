// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Graphics: the busiest adapter's utilization over the window, then one row
// per adapter with its memory and per-engine load.

import { formatBytes, formatPercent } from "@/components/task-manager/format";
import {
  PerformanceEmpty,
  PerformancePanel,
  type PerformanceData,
} from "@/components/task-manager/performance-panel";
import { TraceChart } from "@/components/task-manager/trace-chart";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { historyValues } from "@/lib/task-manager/chart-history";

export function PerformanceGpu({ snapshot, history }: PerformanceData) {
  const { t } = useAppTranslation();
  const gpus = snapshot.hardware.gpus;

  return (
    <PerformancePanel id="performance-gpu" title={t("taskManager.performance.gpu.title")}>
      {gpus.length === 0 ? (
        <PerformanceEmpty>{t("taskManager.performance.gpu.empty")}</PerformanceEmpty>
      ) : (
        <>
          <TraceChart
            series={[
              {
                label: t("taskManager.performance.gpu.utilization"),
                color: CHART_COLORS.gpu,
                points: historyValues(history, "gpu"),
                fill: true,
              },
            ]}
            max={100}
            unit="percent"
            height={120}
            label={t("taskManager.performance.chart.label")}
          />

          <ul className="flex flex-col gap-3">
            {gpus.map((gpu) => (
              <li
                key={gpu.info.id}
                className="border-border/60 flex flex-col gap-1.5 border-t pt-2 first:border-t-0 first:pt-0"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate text-xs font-medium">{gpu.info.name}</p>
                  <span className="text-xs font-semibold tabular-nums">
                    {formatPercent(gpu.util, 0)}
                  </span>
                </div>
                <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-[10px] tabular-nums">
                  {gpu.info.dedicatedTotal > 0 && (
                    <span>
                      {t("taskManager.performance.gpu.dedicated")} {formatBytes(gpu.dedicatedUsed)}{" "}
                      / {formatBytes(gpu.info.dedicatedTotal)}
                    </span>
                  )}
                  {gpu.sharedUsed > 0 && (
                    <span>
                      {t("taskManager.performance.gpu.shared")} {formatBytes(gpu.sharedUsed)}
                    </span>
                  )}
                </div>
                {gpu.info.engines.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-muted-foreground text-[10px]">
                      {t("taskManager.performance.gpu.engines")}
                    </span>
                    {gpu.info.engines.map((engine, index) => (
                      <span
                        key={`${engine}-${index}`}
                        className="bg-muted rounded px-1.5 py-0.5 text-[10px] tabular-nums"
                      >
                        {engine} {formatPercent(gpu.engines[index] ?? Number.NaN, 0)}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </PerformancePanel>
  );
}
