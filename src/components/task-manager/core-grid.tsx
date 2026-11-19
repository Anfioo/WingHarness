// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The CPU view's logical-processor grid: one card per shown thread, with its
// hybrid-core kind, current clock and load, and the thread's own trace. The
// grid fills the height the view leaves it; cells keep a 96 px floor.

import type { CpuThread } from "@/commands";
import { ChartFrame } from "@/components/task-manager/chart-frame";
import { formatPercent } from "@/components/task-manager/format";
import { Sparkline } from "@/components/task-manager/sparkline";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { historyValues, type ChartHistory } from "@/lib/task-manager/chart-history";
import { CHART_COLORS } from "@/lib/task-manager/chart-colors";

export function CoreGrid({
  indices,
  cores,
  threads,
  coreMhz,
  history,
  hybrid,
}: {
  /** Logical-processor indices to show, in `SystemStats.cores` order. */
  indices: readonly number[];
  cores: readonly (number | null)[];
  threads: readonly CpuThread[];
  /** Per-logical-processor frequency, MHz; empty when unknown. */
  coreMhz: readonly number[];
  history: ChartHistory;
  /** Whether the CPU has efficiency cores, which makes the P/E tag meaningful. */
  hybrid: boolean;
}) {
  const { t } = useAppTranslation();
  if (indices.length === 0) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div
        role="group"
        aria-label={t("taskManager.performance.cpu.cores")}
        className="grid min-h-0 flex-1 auto-rows-[minmax(96px,1fr)] grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5"
      >
        {indices.map((index) => {
          const thread = threads[index];
          const efficient = thread?.efficient ?? false;
          const color = efficient ? CHART_COLORS.cpuE : CHART_COLORS.cpu;
          const mhz = coreMhz[index];
          const key = thread ? `core.${thread.group}.${thread.processor}` : null;
          return (
            <div
              key={index}
              className="flex min-h-0 min-w-0 flex-col"
              title={
                hybrid && thread
                  ? t(
                      efficient
                        ? "taskManager.performance.cpu.filter.e"
                        : "taskManager.performance.cpu.filter.p"
                    )
                  : undefined
              }
            >
              <div className="flex h-[22px] flex-none items-center justify-between gap-2 px-px pb-[3px] text-xs tabular-nums">
                <span className="flex min-w-0 items-center gap-1.5">
                  {hybrid && thread && (
                    <span
                      className="flex-none rounded px-1 text-center text-[10px] leading-[15px] font-bold"
                      style={{
                        color: `color-mix(in srgb, ${color} 70%, var(--foreground))`,
                        backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
                      }}
                    >
                      {efficient ? "E" : "P"}
                    </span>
                  )}
                  <span className="text-foreground text-xs font-medium">{index}</span>
                  {typeof mhz === "number" && Number.isFinite(mhz) && mhz > 0 && (
                    <span className="text-muted-foreground truncate text-[11px]">
                      {(mhz / 1000).toFixed(2)} GHz
                    </span>
                  )}
                </span>
                <span className="text-foreground flex-none text-[13px] font-semibold">
                  {formatPercent(cores[index] ?? Number.NaN, 0)}
                </span>
              </div>
              <ChartFrame
                color={color}
                className="relative min-h-0 flex-1 overflow-hidden rounded-[4px]"
              >
                <Sparkline
                  series={[
                    {
                      points: key ? historyValues(history, key) : [],
                      color,
                    },
                  ]}
                  max={100}
                />
              </ChartFrame>
            </div>
          );
        })}
      </div>
      {hybrid && (
        <div className="text-muted-foreground flex gap-4 text-[11px]">
          {[
            { label: t("taskManager.performance.cpu.filter.p"), color: CHART_COLORS.cpu },
            { label: t("taskManager.performance.cpu.filter.e"), color: CHART_COLORS.cpuE },
          ].map((entry) => (
            <span key={entry.label} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block w-3.5 border-t-2"
                style={{ borderColor: entry.color }}
              />
              {entry.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
