// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// One network adapter: received and sent throughput, the connection's kind and
// speed, and its addresses. The device list chooses which adapter this shows.

import { useState } from "react";
import { formatRate } from "@/components/task-manager/format";
import {
  PerformanceDetailHeader,
  PerformanceEmpty,
  PerformanceSpec,
  PerformanceSpecs,
  PerformanceStat,
  type PerformanceData,
} from "@/components/task-manager/performance-panel";
import { TraceChart } from "@/components/task-manager/trace-chart";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { historyPeak, historyValues } from "@/lib/task-manager/chart-history";
import { rateCeiling } from "@/lib/task-manager/chart-scale";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";

const ADDRESSES_SHOWN = 3;

function Addresses({ list }: { list: readonly string[] }) {
  const { t } = useAppTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? list : list.slice(0, ADDRESSES_SHOWN);
  if (list.length === 0) return <span>—</span>;

  return (
    <span className="flex flex-col items-end gap-0.5">
      {shown.map((address) => (
        <span key={address} className="font-mono select-text">
          {address}
        </span>
      ))}
      {list.length > ADDRESSES_SHOWN && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
          className="text-muted-foreground hover:text-foreground text-[10px] underline-offset-2 hover:underline"
        >
          {all
            ? t("taskManager.performance.network.showFewer")
            : t("taskManager.performance.network.showAll", { count: list.length })}
        </button>
      )}
    </span>
  );
}

export function PerformanceNetwork({ snapshot, history, id }: PerformanceData & { id: string }) {
  const { t } = useAppTranslation();
  const nic = snapshot.hardware.nics.find((entry) => entry.info.id === id);

  if (!nic) {
    return <PerformanceEmpty>{t("taskManager.performance.network.disconnected")}</PerformanceEmpty>;
  }

  const prefix = `nic.${nic.info.id}`;
  const peak = Math.max(
    historyPeak(history, `${prefix}.rx`) ?? 0,
    historyPeak(history, `${prefix}.tx`) ?? 0,
    64 * 1024
  );

  return (
    <div className="flex flex-col gap-4">
      <PerformanceDetailHeader title={nic.info.name} model={nic.info.description || undefined} />

      <TraceChart
        series={[
          {
            label: t("taskManager.performance.network.received"),
            color: CHART_COLORS.netReceived,
            points: historyValues(history, `${prefix}.rx`),
            fill: true,
          },
          {
            label: t("taskManager.performance.network.sent"),
            color: CHART_COLORS.netSent,
            points: historyValues(history, `${prefix}.tx`),
            dashed: true,
          },
        ]}
        max={rateCeiling(peak)}
        unit="rate"
        height={180}
        label={t("taskManager.performance.network.throughput")}
      />

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        <PerformanceStat
          label={t("taskManager.performance.network.received")}
          value={formatRate(nic.rx)}
        />
        <PerformanceStat
          label={t("taskManager.performance.network.sent")}
          value={formatRate(nic.tx)}
        />
      </div>

      <PerformanceSpecs>
        <PerformanceSpec label={t("taskManager.performance.network.connectionType")}>
          {t(`taskManager.performance.network.kind.${nic.info.kind}`)}
        </PerformanceSpec>
        <PerformanceSpec label={t("taskManager.performance.network.linkSpeed")}>
          {nic.info.linkSpeed > 0 ? formatRate(nic.info.linkSpeed / 8, 0) : "—"}
        </PerformanceSpec>
        <PerformanceSpec label={t("taskManager.performance.network.ipv4")}>
          <Addresses list={nic.info.ipv4} />
        </PerformanceSpec>
        <PerformanceSpec label={t("taskManager.performance.network.ipv6")}>
          <Addresses list={nic.info.ipv6} />
        </PerformanceSpec>
        <PerformanceSpec label={t("taskManager.performance.network.mac")}>
          {nic.info.mac ?? "—"}
        </PerformanceSpec>
      </PerformanceSpecs>
    </div>
  );
}
