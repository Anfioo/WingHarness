// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// One graphics adapter: the engine utilization grid (with the engines it
// charts, their layout and the split against the memory charts), dedicated
// and shared memory over the window, and the clocks, temperature and power
// the adapter reports.

import { useLayoutEffect, useRef, useState } from "react";
import { formatGigabytes, formatPercent, formatWatts } from "@/components/task-manager/format";
import { ChartFrame } from "@/components/task-manager/chart-frame";
import {
  PerformanceDetailHeader,
  PerformanceEmpty,
  PerformanceSpec,
  PerformanceSpecs,
  PerformanceStat,
  PerformanceStats,
  PerformanceSummary,
  SegmentedControl,
  type PerformanceData,
} from "@/components/task-manager/performance-panel";
import { ShareSplitter, SHARE_DEFAULT, clampShare } from "@/components/task-manager/share-splitter";
import { Sparkline } from "@/components/task-manager/sparkline";
import { TraceChart } from "@/components/task-manager/trace-chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { historySpanSeconds, historyValues } from "@/lib/task-manager/chart-history";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { ENGINE_LAYOUTS, planGrid, type EngineLayout } from "@/lib/task-manager/engine-grid";
import {
  isSmart,
  shownEngines,
  wasBusy,
  withCount,
  withEngine,
  withSmart,
  type EngineChoice,
} from "@/lib/task-manager/gpu-engines";

/** The smallest an engine chart may be, and the gap between them. */
const ENGINE_CELL = { width: 150, height: 76 };
const ENGINE_GAP = 6;

export function PerformanceGpu({
  snapshot,
  history,
  intervalMs,
  id,
}: PerformanceData & { id: string }) {
  const { t } = useAppTranslation();
  const [layout, setLayout] = useState<EngineLayout>("grid");
  const [choices, setChoices] = useState<Record<string, EngineChoice>>({});
  const [share, setShare] = useState(SHARE_DEFAULT);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });

  // The engine grid's plan follows its area, as in Argus: measure the element
  // the charts are laid out in and plan again when it changes.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const update = () => {
      const rect = grid.getBoundingClientRect();
      setGridSize((current) =>
        Math.abs(current.width - rect.width) < 0.5 && Math.abs(current.height - rect.height) < 0.5
          ? current
          : { width: rect.width, height: rect.height }
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const gpus = snapshot.hardware.gpus;
  const index = gpus.findIndex((entry) => entry.info.id === id);
  const gpu = gpus[index];

  if (!gpu) {
    return <PerformanceEmpty>{t("taskManager.performance.gpu.notFound")}</PerformanceEmpty>;
  }

  const prefix = `gpu.${gpu.info.id}`;
  const engines = gpu.info.engines;
  const model = gpu.info.name;
  const choice = choices[model];
  const busy = (engine: string) => {
    const engineIndex = engines.indexOf(engine);
    return engineIndex >= 0 && wasBusy(historyValues(history, `${prefix}.e${engineIndex}`));
  };
  const shown = shownEngines(engines, choice, busy);
  const plan =
    shown.length > 0 && gridSize.width > 0
      ? planGrid(layout, shown.length, gridSize.width, gridSize.height, ENGINE_CELL, ENGINE_GAP)
      : null;
  const choose = (next: EngineChoice) => setChoices((current) => ({ ...current, [model]: next }));

  const display = isSmart(choice) ? "smart" : String(shown.length);
  const setDisplay = (value: string) => {
    choose(
      value === "smart"
        ? withSmart(engines, choice)
        : withCount(engines, choice, Number(value), shown)
    );
  };

  const power =
    gpu.boardPower !== null
      ? formatWatts(gpu.boardPower)
      : gpu.power !== null
        ? `${Math.round(gpu.power)}% TDP`
        : null;
  const spanSeconds = historySpanSeconds(intervalMs);

  return (
    <div className="flex h-full flex-col gap-4">
      <PerformanceDetailHeader title={`GPU ${index}`} model={gpu.info.name} />

      {engines.length > 1 && (
        <div className="-mt-1 flex flex-wrap items-center justify-end gap-2">
          <Select value={display} onValueChange={setDisplay}>
            <SelectTrigger
              size="sm"
              aria-label={t("taskManager.performance.gpu.engineCount")}
              title={
                isSmart(choice) ? t("taskManager.performance.gpu.engineSmartTitle") : undefined
              }
              className="w-auto min-w-[118px] text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="smart">{t("taskManager.performance.gpu.engineSmart")}</SelectItem>
              {engines.map((_, engineIndex) => {
                const count = engineIndex + 1;
                return (
                  <SelectItem key={count} value={String(count)}>
                    {count === engines.length
                      ? t("taskManager.performance.gpu.engineCountAll", { count })
                      : t("taskManager.performance.gpu.engineCountOption", { count })}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <SegmentedControl<EngineLayout>
            label={t("taskManager.performance.gpu.layout")}
            value={layout}
            options={ENGINE_LAYOUTS.map((value) => ({
              value,
              label: t(`taskManager.performance.gpu.layouts.${value}`),
              title: t(`taskManager.performance.gpu.layoutTitles.${value}`),
            }))}
            onChange={setLayout}
          />
        </div>
      )}

      <div className="flex min-h-min flex-1 flex-col">
        <div className="text-muted-foreground flex items-baseline justify-between gap-3 text-[12px] tabular-nums">
          <span>{t("taskManager.performance.gpu.engineUtilization")}</span>
          <span>100%</span>
        </div>
        <div className="flex flex-col pt-0.5" style={{ flex: `${share} 1 0` }}>
          <div
            ref={gridRef}
            className="relative grid flex-1"
            style={{
              gap: ENGINE_GAP,
              gridTemplateColumns: plan
                ? `repeat(${plan.columns}, minmax(0, 1fr))`
                : `repeat(auto-fit, minmax(${ENGINE_CELL.width}px, 1fr))`,
              gridTemplateRows: plan ? `repeat(${plan.rows}, minmax(0, 1fr))` : undefined,
              minHeight: plan
                ? plan.stack * ENGINE_CELL.height + (plan.stack - 1) * ENGINE_GAP
                : undefined,
            }}
          >
            {shown.map((engine, slot) => {
              const engineIndex = engines.indexOf(engine);
              const place = plan?.cells[slot];
              return (
                <div
                  key={engine}
                  className="flex min-h-0 min-w-0 flex-col"
                  style={
                    place
                      ? {
                          gridArea: `${place.row} / ${place.column} / span ${place.rows} / span ${place.columns}`,
                        }
                      : undefined
                  }
                >
                  <div className="flex h-[22px] flex-none items-center justify-between gap-2 px-px pb-[3px] text-xs tabular-nums">
                    <Select
                      value={engine}
                      onValueChange={(next) =>
                        choose(withEngine(engines, choice, slot, next, shown))
                      }
                    >
                      <SelectTrigger
                        aria-label={t("taskManager.performance.gpu.engineType")}
                        className="max-w-full min-w-0 border-0 bg-transparent text-xs font-medium shadow-none focus-visible:ring-0 [&_svg]:size-3"
                        style={{ height: 18, padding: "0 2px 0 4px", marginLeft: -4, gap: 2 }}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {engines.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-foreground flex-none text-[13px] leading-none font-semibold">
                      {Math.round(gpu.engines[engineIndex] ?? 0)}
                      <span className="text-muted-foreground ml-px text-[10.5px] font-normal">
                        %
                      </span>
                    </span>
                  </div>
                  <ChartFrame
                    color={CHART_COLORS.gpu}
                    className="relative min-h-0 flex-1 overflow-hidden rounded-[4px]"
                  >
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
              );
            })}
          </div>
        </div>

        <ShareSplitter
          share={share}
          onChange={(next) => setShare(clampShare(next))}
          label={t("taskManager.performance.gpu.resize")}
        />

        <div
          className="grid min-h-[140px] grid-cols-1 gap-4 sm:grid-cols-2"
          style={{ flex: `${1 - share} 1 0` }}
        >
          <TraceChart
            title={t("taskManager.performance.gpu.dedicatedMemory")}
            series={[
              {
                label: t("taskManager.performance.gpu.dedicatedMemory"),
                color: CHART_COLORS.gpu,
                points: historyValues(history, `${prefix}.dedicated`),
                fill: true,
              },
            ]}
            max={gpu.info.dedicatedTotal || 1}
            unit="bytes"
            formatValue={formatGigabytes}
            spanSeconds={spanSeconds}
            fill
            fillMin={64}
            className="h-full"
            label={t("taskManager.performance.chart.label", { seconds: spanSeconds })}
          />
          <TraceChart
            title={t("taskManager.performance.gpu.sharedMemory")}
            series={[
              {
                label: t("taskManager.performance.gpu.sharedMemory"),
                color: CHART_COLORS.gpu,
                points: historyValues(history, `${prefix}.shared`),
                fill: true,
              },
            ]}
            max={gpu.info.sharedTotal || 1}
            unit="bytes"
            formatValue={formatGigabytes}
            spanSeconds={spanSeconds}
            fill
            fillMin={64}
            className="h-full"
            label={t("taskManager.performance.chart.label", { seconds: spanSeconds })}
          />
        </div>
      </div>

      <PerformanceSummary>
        <PerformanceStats>
          <PerformanceStat
            label={t("taskManager.performance.gpu.utilization")}
            value={formatPercent(gpu.util, 0)}
            detail={t(`taskManager.performance.gpu.utilSource.${gpu.utilSource}`)}
          />
          <PerformanceStat
            label={t("taskManager.performance.gpu.dedicatedMemory")}
            value={formatGigabytes(gpu.dedicatedUsed)}
            detail={`/ ${formatGigabytes(gpu.info.dedicatedTotal)}`}
          />
          <PerformanceStat
            label={t("taskManager.performance.gpu.sharedMemory")}
            value={formatGigabytes(gpu.sharedUsed)}
            detail={`/ ${formatGigabytes(gpu.info.sharedTotal)}`}
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
          <PerformanceSpec label={t("taskManager.performance.gpu.dedicatedMemory")}>
            {formatGigabytes(gpu.info.dedicatedTotal)}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.gpu.sharedMemory")}>
            {formatGigabytes(gpu.info.sharedTotal)}
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
            {engines.length}
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
