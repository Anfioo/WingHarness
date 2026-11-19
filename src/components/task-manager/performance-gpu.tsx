// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// One graphics adapter: overall utilization, the per-engine traces, memory in
// use, and the clocks, temperature and power the adapter reports.

import { formatBytes, formatPercent } from "@/components/task-manager/format";
import { ChartFrame } from "@/components/task-manager/chart-frame";
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
import { Sparkline } from "@/components/task-manager/sparkline";
import { TraceChart } from "@/components/task-manager/trace-chart";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { historySpanSeconds, historyValues } from "@/lib/task-manager/chart-history";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";

export function PerformanceGpu({
  snapshot,
  history,
  intervalMs,
  id,
}: PerformanceData & { id: string }) {
  const { t } = useAppTranslation();
  const gpus = snapshot.hardware.gpus;
  const index = gpus.findIndex((entry) => entry.info.id === id);
  const gpu = gpus[index];

  if (!gpu) {
    return <PerformanceEmpty>{t("taskManager.performance.gpu.notFound")}</PerformanceEmpty>;
  }

  const prefix = `gpu.${gpu.info.id}`;
  const power =
    gpu.boardPower !== null
      ? `${gpu.boardPower.toFixed(1)} W`
      : gpu.power !== null
        ? `${Math.round(gpu.power)}% ${t("taskManager.performance.gpu.powerBudget")}`
        : null;
  const spanSeconds = historySpanSeconds(intervalMs);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PerformanceDetailHeader title={`GPU ${index}`} model={gpu.info.name} />

      <TraceChart
        title={t("taskManager.performance.gpu.utilization")}
        series={[
          {
            label: t("taskManager.performance.gpu.utilization"),
            color: CHART_COLORS.gpu,
            points: historyValues(history, `${prefix}.util`),
            fill: true,
          },
        ]}
        max={100}
        unit="percent"
        spanSeconds={spanSeconds}
        height={200}
        label={t("taskManager.performance.chart.label", { seconds: spanSeconds })}
      />

      {gpu.info.engines.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">
            {t("taskManager.performance.gpu.engineUtilization")}
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5">
            {gpu.info.engines.map((engine, engineIndex) => (
              <div key={`${engine}-${engineIndex}`} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                  <span className="truncate" title={engine}>
                    {engine}
                  </span>
                  <span className="text-foreground flex-none font-semibold">
                    {formatPercent(gpu.engines[engineIndex] ?? Number.NaN, 0)}
                  </span>
                </div>
                <ChartFrame color={CHART_COLORS.gpu} className="h-12 overflow-hidden rounded-[4px]">
                  <Sparkline
                    series={[
                      {
                        points: historyValues(history, `${prefix}.e${engineIndex}`),
                        color: CHART_COLORS.gpu,
                      },
                    ]}
                    max={100}
                  />
                </ChartFrame>
              </div>
            ))}
          </div>
        </div>
      )}

      <PerformanceSummary>
        <PerformanceStats>
          <PerformanceStat
            label={t("taskManager.performance.gpu.utilization")}
            value={formatPercent(gpu.util, 0)}
          />
          <PerformanceStat
            label={t("taskManager.performance.gpu.dedicated")}
            value={formatBytes(gpu.dedicatedUsed)}
            detail={`/ ${formatBytes(gpu.info.dedicatedTotal)}`}
          />
          <PerformanceStat
            label={t("taskManager.performance.gpu.shared")}
            value={formatBytes(gpu.sharedUsed)}
            detail={`/ ${formatBytes(gpu.info.sharedTotal)}`}
          />
          {gpu.temperature !== null && (
            <PerformanceStat
              label={t("taskManager.performance.gpu.temperature")}
              value={`${Math.round(gpu.temperature)} °C`}
            />
          )}
          {gpu.fanRpm !== null && (
            <PerformanceStat
              label={t("taskManager.performance.gpu.fan")}
              value={`${gpu.fanRpm.toLocaleString()} RPM`}
            />
          )}
          {gpu.clockMhz !== null && (
            <PerformanceStat
              label={t("taskManager.performance.gpu.coreClock")}
              value={`${gpu.clockMhz.toLocaleString()} MHz`}
            />
          )}
          {gpu.memoryClockMhz !== null && (
            <PerformanceStat
              label={t("taskManager.performance.gpu.memoryClock")}
              value={`${gpu.memoryClockMhz.toLocaleString()} MHz`}
            />
          )}
          {gpu.voltageMv !== null && (
            <PerformanceStat
              label={t("taskManager.performance.gpu.coreVoltage")}
              value={`${(gpu.voltageMv / 1000).toFixed(3)} V`}
            />
          )}
          {power !== null && (
            <PerformanceStat label={t("taskManager.performance.gpu.power")} value={power} />
          )}
        </PerformanceStats>
        <PerformanceSpecs>
          {gpu.powerSource !== null && (
            <PerformanceSpec label={t("taskManager.performance.gpu.powerSource")}>
              {t(`taskManager.performance.gpu.sources.${gpu.powerSource}`)}
            </PerformanceSpec>
          )}
          <PerformanceSpec label={t("taskManager.performance.gpu.dedicated")}>
            {formatBytes(gpu.info.dedicatedTotal, 0)}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.gpu.shared")}>
            {formatBytes(gpu.info.sharedTotal, 0)}
          </PerformanceSpec>
          {gpu.boardPowerLimit !== null && (
            <PerformanceSpec label={t("taskManager.performance.gpu.powerLimit")}>
              {`${gpu.boardPowerLimit.toFixed(0)} W`}
            </PerformanceSpec>
          )}
          {gpu.info.temperatureMax !== null && (
            <PerformanceSpec label={t("taskManager.performance.gpu.maxTemperature")}>
              {`${Math.round(gpu.info.temperatureMax)} °C`}
            </PerformanceSpec>
          )}
          <PerformanceSpec label={t("taskManager.performance.gpu.engines")}>
            {gpu.info.engines.length}
          </PerformanceSpec>
          {gpu.clockMaxMhz !== null && (
            <PerformanceSpec label={t("taskManager.performance.gpu.maxCoreClock")}>
              {`${gpu.clockMaxMhz.toLocaleString()} MHz`}
            </PerformanceSpec>
          )}
        </PerformanceSpecs>
      </PerformanceSummary>
    </div>
  );
}
