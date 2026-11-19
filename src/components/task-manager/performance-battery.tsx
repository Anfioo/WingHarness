// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// One battery: charge over the window, the current flow, wear and the pack's
// identity. The device list chooses which battery this shows.

import type { BatteryState } from "@/commands";
import { formatPercent, formatRemainingTime, formatWatts } from "@/components/task-manager/format";
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
import { roundCeiling } from "@/lib/task-manager/chart-scale";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";

type Chemistry = "liIon" | "liPoly" | "leadAcid" | "niCd" | "niMh" | "alkaline";

const CHEMISTRY: Record<string, Chemistry> = {
  LION: "liIon",
  "LI-I": "liIon",
  LIP: "liPoly",
  LIPO: "liPoly",
  PBAC: "leadAcid",
  NICD: "niCd",
  NIMH: "niMh",
  RAM: "alkaline",
};

function wattHours(mwh: number | null): string {
  return mwh ? `${(mwh / 1000).toFixed(1)} Wh` : "—";
}

export function PerformanceBattery({
  snapshot,
  history,
  intervalMs,
  id,
}: PerformanceData & { id: string }) {
  const { t } = useAppTranslation();
  const battery = snapshot.hardware.batteries.find((entry) => entry.info.id === id);

  if (!battery) {
    return <PerformanceEmpty>{t("taskManager.performance.battery.removed")}</PerformanceEmpty>;
  }

  const prefix = `bat.${battery.info.id}`;
  const stateKey = `taskManager.performance.battery.state.${battery.state as BatteryState}`;
  const health =
    battery.info.fullCapacity && battery.info.designedCapacity
      ? (battery.info.fullCapacity / battery.info.designedCapacity) * 100
      : null;
  const flowLabel = t(
    battery.state === "charging"
      ? "taskManager.performance.battery.chargeRate"
      : "taskManager.performance.battery.dischargeRate"
  );
  const rateWatts = battery.rate !== null ? Math.abs(battery.rate) / 1000 : null;
  const ratePeak = Math.max(
    5000,
    roundCeiling(
      Math.max(
        0,
        ...historyValues(history, `${prefix}.rate`).map((value) =>
          value === null ? 0 : Math.abs(value)
        )
      ) / 1000
    ) * 1000
  );
  const chemistry = CHEMISTRY[battery.info.chemistry.toUpperCase()];
  const spanSeconds = historySpanSeconds(intervalMs);

  return (
    <div className="flex min-h-full flex-col gap-4">
      <PerformanceDetailHeader
        title={
          snapshot.hardware.batteries.length > 1
            ? t("taskManager.performance.battery.titleNumbered", { id: battery.info.id })
            : t("taskManager.performance.battery.title")
        }
        model={
          [battery.info.manufacturer, battery.info.name].filter(Boolean).join(" ") || undefined
        }
      />

      <TraceChart
        title={t("taskManager.performance.battery.level")}
        series={[
          {
            label: t("taskManager.performance.battery.level"),
            color: CHART_COLORS.battery,
            points: historyValues(history, `${prefix}.pct`),
            fill: true,
          },
        ]}
        max={100}
        unit="percent"
        spanSeconds={spanSeconds}
        fill
        fillMin={120}
        label={t("taskManager.performance.chart.label", { seconds: spanSeconds })}
      />

      {battery.rate !== null && (
        <TraceChart
          title={flowLabel}
          series={[
            {
              label: flowLabel,
              color: CHART_COLORS.battery,
              points: historyValues(history, `${prefix}.rate`).map((value) =>
                value === null ? null : Math.abs(value)
              ),
              fill: true,
            },
          ]}
          max={ratePeak}
          unit="bytes"
          spanSeconds={spanSeconds}
          fill
          fillMin={120}
          formatValue={(value) => formatWatts(value / 1000)}
          label={flowLabel}
        />
      )}

      <PerformanceSummary>
        <PerformanceStats>
          <PerformanceStat
            label={t("taskManager.performance.battery.level")}
            value={formatPercent(battery.percent, 0)}
          />
          <PerformanceStat
            label={t("taskManager.performance.battery.status")}
            value={t(stateKey)}
          />
          {rateWatts !== null && (
            <PerformanceStat label={flowLabel} value={formatWatts(rateWatts)} />
          )}
          {battery.voltage !== null && (
            <PerformanceStat
              label={t("taskManager.performance.battery.voltage")}
              value={`${(battery.voltage / 1000).toFixed(2)} V`}
            />
          )}
          {battery.remaining !== null && (
            <PerformanceStat
              label={t("taskManager.performance.battery.remaining")}
              value={formatRemainingTime(battery.remaining)}
            />
          )}
          {health !== null && (
            <PerformanceStat
              label={t("taskManager.performance.battery.health")}
              value={formatPercent(health, 0)}
            />
          )}
          {battery.info.cycleCount !== null && (
            <PerformanceStat
              label={t("taskManager.performance.battery.cycles")}
              value={battery.info.cycleCount.toLocaleString()}
            />
          )}
          {battery.temperature !== null && (
            <PerformanceStat
              label={t("taskManager.performance.battery.temperature")}
              value={`${Math.round(battery.temperature)} °C`}
            />
          )}
        </PerformanceStats>
        <PerformanceSpecs>
          <PerformanceSpec label={t("taskManager.performance.battery.capacity")}>
            {wattHours(battery.capacity)}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.battery.fullCapacity")}>
            {wattHours(battery.info.fullCapacity)}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.battery.designCapacity")}>
            {wattHours(battery.info.designedCapacity)}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.battery.chemistry")}>
            {chemistry
              ? t(`taskManager.performance.battery.chemistries.${chemistry}`)
              : battery.info.chemistry || "—"}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.battery.manufacturer")}>
            {battery.info.manufacturer || "—"}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.battery.model")}>
            {battery.info.name || "—"}
          </PerformanceSpec>
          <PerformanceSpec label={t("taskManager.performance.battery.serial")}>
            {battery.info.serial || "—"}
          </PerformanceSpec>
          {battery.info.manufactured && (
            <PerformanceSpec label={t("taskManager.performance.battery.manufactured")}>
              {battery.info.manufactured}
            </PerformanceSpec>
          )}
        </PerformanceSpecs>
      </PerformanceSummary>

      {health !== null && health < 80 && (
        <p className="text-muted-foreground text-xs">
          {t("taskManager.performance.battery.wornNote", { percent: Math.round(health) })}
        </p>
      )}
    </div>
  );
}
