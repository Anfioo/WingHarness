// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// One graphics adapter: overall utilization, the per-engine traces, memory in
// use, and the clocks, temperature and power the adapter reports.

import { formatBytes, formatPercent } from "@/components/task-manager/format";
import {
  PerformanceDetailHeader,
  PerformanceEmpty,
  PerformanceSpec,
  PerformanceSpecs,
  PerformanceStat,
  type PerformanceData,
} from "@/components/task-manager/performance-panel";
import { Sparkline } from "@/components/task-manager/sparkline";
import { TraceChart } from "@/components/task-manager/trace-chart";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { historyValues } from "@/lib/task-manager/chart-history";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";

export function PerformanceGpu({ snapshot, history, id }: PerformanceData & { id: string }) {
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

  return (
    <div className="flex flex-col gap-4">
      <PerformanceDetailHeader title={`GPU ${index}`} model={gpu.info.name} />

      <TraceChart
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
        height={150}
        label={t("taskManager.performance.gpu.engineUtilization")}
      />

      {gpu.info.engines.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">
            {t("taskManager.performance.gpu.engineUtilization")}
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
            {gpu.info.engines.map((engine, engineIndex) => (
              <div
                key={`${engine}-${engineIndex}`}
                className="border-border/60 bg-card flex flex-col gap-1.5 rounded-lg border p-2"
              >
                <div className="flex items-center justify-between gap-2 text-[10px]">
                  <span className="truncate" title={engine}>
                    {engine}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatPercent(gpu.engines[engineIndex] ?? Number.NaN, 0)}
                  </span>
                </div>
                <div style={{ color: CHART_COLORS.gpu }}>
                  <Sparkline
                    series={[
                      {
                        points: historyValues(history, `${prefix}.e${engineIndex}`),
                        color: CHART_COLORS.gpu,
                      },
                    ]}
                    max={100}
                    className="h-8"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
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
      </div>

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
    </div>
  );
}
