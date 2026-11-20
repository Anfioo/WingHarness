// The right-hand details panel of the processes tab: the selected process's
// header and history charts above the ported detail sections, or a compact
// hardware overview while nothing is selected. Its left edge resizes it.

import { X } from "lucide-react";
import type { ProcessRow } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager } from "@/hooks/use-task-manager";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";
import { rateCeiling } from "@/lib/task-manager/chart-scale";
import { processLabel } from "@/lib/task-manager/process-identity";
import { latestSample, samplePeak, type ProcessSample } from "@/lib/task-manager/process-history";
import { Button } from "@/components/ui/button";
import { formatBytes, formatPercent, formatRate } from "./format";
import type { ProcessActions } from "./process-context-menu";
import { ProcessDetailsActions, ProcessDetailsBody } from "./process-detail";
import { ProcessIcon } from "./process-icon";
import { ProcessOverview } from "./process-overview";
import { ProcessSplitter } from "./process-splitter";
import { Sparkline, type SparkSeries } from "./sparkline";

const RATE_FLOOR = 1024;

function sum(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return left + right;
}

function MiniChart({
  label,
  value,
  series,
  max,
}: {
  label: string;
  value: string;
  series: readonly SparkSeries[];
  max: number;
}) {
  return (
    <div className="border-border relative h-[74px] min-w-0 overflow-hidden rounded-md border px-2.5 pt-1.5">
      <div className="text-muted-foreground relative z-10 text-xs">{label}</div>
      <div className="relative z-10 text-[18px] leading-tight font-light tabular-nums">{value}</div>
      <div className="pointer-events-none absolute inset-x-0.5 top-[34px] bottom-0.5">
        <Sparkline series={series} max={max} />
      </div>
    </div>
  );
}

/** CPU, memory and the rates this process is measured for, over the same window. */
function MiniCharts({
  process,
  samples,
  processNetwork,
}: {
  process: ProcessRow;
  samples: readonly (ProcessSample | null)[];
  processNetwork: boolean;
}) {
  const { t } = useAppTranslation();
  const snapshot = useTaskManager().snapshot;

  const cpu = latestSample(samples, (sample) => sample.cpu) ?? 0;
  const memory = latestSample(samples, (sample) => sample.privateWs);
  const memoryPeak = samplePeak(samples, (sample) => sample.privateWs) ?? 1;

  const diskRead = latestSample(samples, (sample) => sample.diskRead);
  const diskWrite = latestSample(samples, (sample) => sample.diskWrite);
  const diskTotal = sum(diskRead, diskWrite);
  const diskPeak = Math.max(
    samplePeak(samples, (sample) => sample.diskRead) ?? 0,
    samplePeak(samples, (sample) => sample.diskWrite) ?? 0
  );

  const netSent = latestSample(samples, (sample) => sample.netSent);
  const netReceived = latestSample(samples, (sample) => sample.netReceived);
  const netTotal = sum(netSent, netReceived);
  const netPeak = Math.max(
    samplePeak(samples, (sample) => sample.netSent) ?? 0,
    samplePeak(samples, (sample) => sample.netReceived) ?? 0
  );

  const gpu = latestSample(samples, (sample) => sample.gpu);
  const hasGpu = (snapshot?.hardware.gpus.length ?? 0) > 0;

  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      <MiniChart
        label="CPU"
        value={formatPercent(cpu, 0)}
        series={[{ points: samples.map((sample) => sample?.cpu ?? null), color: CHART_COLORS.cpu }]}
        max={100}
      />
      <MiniChart
        label={t("taskManager.performance.memory.title")}
        value={memory === null ? "—" : formatBytes(memory)}
        series={[
          {
            points: samples.map((sample) => sample?.privateWs ?? null),
            color: CHART_COLORS.memory,
          },
        ]}
        max={rateCeiling(Math.max(memoryPeak, RATE_FLOOR))}
      />
      <MiniChart
        label={t("taskManager.vitals.disk")}
        value={diskTotal === null ? "—" : formatRate(diskTotal)}
        series={[
          {
            points: samples.map((sample) => sample?.diskRead ?? null),
            color: CHART_COLORS.diskRead,
          },
          {
            points: samples.map((sample) => sample?.diskWrite ?? null),
            color: CHART_COLORS.diskWrite,
            dashed: true,
          },
        ]}
        max={rateCeiling(Math.max(diskPeak, RATE_FLOOR))}
      />
      {processNetwork ? (
        <MiniChart
          label={t("taskManager.vitals.network")}
          value={netTotal === null ? "—" : formatRate(netTotal)}
          series={[
            {
              points: samples.map((sample) => sample?.netReceived ?? null),
              color: CHART_COLORS.netReceived,
            },
            {
              points: samples.map((sample) => sample?.netSent ?? null),
              color: CHART_COLORS.netSent,
              dashed: true,
            },
          ]}
          max={rateCeiling(Math.max(netPeak, RATE_FLOOR))}
        />
      ) : null}
      {hasGpu ? (
        <MiniChart
          label="GPU"
          value={formatPercent(gpu ?? process.gpu, 0)}
          series={[
            { points: samples.map((sample) => sample?.gpu ?? null), color: CHART_COLORS.gpu },
          ]}
          max={100}
        />
      ) : null}
    </div>
  );
}

export type ProcessDetailPanelProps = {
  process: ProcessRow | null;
  processNetwork: boolean;
  actions: ProcessActions;
  samples: readonly (ProcessSample | null)[];
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
};

export function ProcessDetailPanel({
  process,
  processNetwork,
  actions,
  samples,
  width,
  onWidthChange,
  onClose,
}: ProcessDetailPanelProps) {
  const { t } = useAppTranslation();

  return (
    <div className="relative flex min-h-0 shrink-0" style={{ width }}>
      <aside
        role="region"
        aria-label={t("taskManager.details.title")}
        className="border-border bg-card flex min-h-0 w-full flex-col overflow-hidden rounded-xl border"
      >
        {process ? (
          <>
            <header className="flex items-start gap-3 border-b px-4 py-3">
              <ProcessIcon process={process} size={32} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{processLabel(process)}</div>
                <div className="text-muted-foreground truncate text-xs">
                  {process.name} · PID {process.pid}
                  {process.company ? ` · ${process.company}` : ""}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                title={t("taskManager.details.deselect")}
                aria-label={t("taskManager.details.deselect")}
                onClick={onClose}
              >
                <X className="size-4" />
              </Button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <MiniCharts process={process} samples={samples} processNetwork={processNetwork} />
              <ProcessDetailsBody process={process} processNetwork={processNetwork} />
            </div>

            <ProcessDetailsActions process={process} actions={actions} />
          </>
        ) : (
          <ProcessOverview />
        )}
      </aside>
      <ProcessSplitter
        width={width}
        onChange={onWidthChange}
        label={t("taskManager.details.resize")}
      />
    </div>
  );
}
