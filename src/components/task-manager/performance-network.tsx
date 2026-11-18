// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Network throughput: the summed received and sent curves, then one row per
// adapter. An adapter may report no traffic at all; the row still shows it so
// an idle link is distinguishable from a missing one.

import { formatRate } from "@/components/task-manager/format";
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

export function PerformanceNetwork({ snapshot, history }: PerformanceData) {
  const { t } = useAppTranslation();
  const nics = snapshot.hardware.nics;
  const totalReceived = nics.reduce((sum, nic) => sum + nic.rx, 0);
  const totalSent = nics.reduce((sum, nic) => sum + nic.tx, 0);
  const peak = Math.max(
    historyPeak(history, "netRx") ?? 0,
    historyPeak(history, "netTx") ?? 0,
    1024
  );

  return (
    <PerformancePanel id="performance-network" title={t("taskManager.performance.network.title")}>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <PerformanceStat
          label={t("taskManager.performance.network.received")}
          value={formatRate(totalReceived)}
        />
        <PerformanceStat
          label={t("taskManager.performance.network.sent")}
          value={formatRate(totalSent)}
        />
      </div>

      {nics.length === 0 ? (
        <PerformanceEmpty>{t("taskManager.performance.network.empty")}</PerformanceEmpty>
      ) : (
        <>
          <TraceChart
            series={[
              {
                label: t("taskManager.performance.network.received"),
                color: CHART_COLORS.netReceived,
                points: historyValues(history, "netRx"),
              },
              {
                label: t("taskManager.performance.network.sent"),
                color: CHART_COLORS.netSent,
                points: historyValues(history, "netTx"),
              },
            ]}
            max={rateCeiling(peak)}
            unit="rate"
            height={120}
            label={t("taskManager.performance.chart.label")}
          />

          <ul className="flex flex-col gap-2">
            {nics.map((nic) => (
              <li
                key={nic.info.id}
                className="border-border/60 flex flex-wrap items-center justify-between gap-2 border-t pt-2 first:border-t-0 first:pt-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">
                    {nic.info.description || nic.info.name}
                  </p>
                  <p className="text-muted-foreground truncate text-[10px]">
                    {nic.info.name}
                    {nic.info.ipv4.length > 0 ? ` · ${nic.info.ipv4.join(" ")}` : ""}
                  </p>
                </div>
                <div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
                  <span>
                    {t("taskManager.performance.network.received")} {formatRate(nic.rx)}
                  </span>
                  <span>
                    {t("taskManager.performance.network.sent")} {formatRate(nic.tx)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </PerformancePanel>
  );
}
