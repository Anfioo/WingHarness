// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The CPU view's logical-processor grid: one card per shown thread, with its
// hybrid-core kind, current clock and load, and the thread's own trace.

import type { CpuThread } from "@/commands";
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
    <div
      role="group"
      aria-label={t("taskManager.performance.cpu.cores")}
      className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2"
    >
      {indices.map((index) => {
        const thread = threads[index];
        const efficient = thread?.efficient ?? false;
        const color = efficient ? "hsl(var(--success))" : CHART_COLORS.cpu;
        const mhz = coreMhz[index];
        const key = thread ? `core.${thread.group}.${thread.processor}` : null;
        return (
          <div
            key={index}
            className="border-border/60 bg-card flex flex-col gap-1.5 rounded-lg border p-2"
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
            <div className="flex items-center justify-between gap-2 text-[10px] tabular-nums">
              <span className="text-muted-foreground flex min-w-0 items-center gap-1">
                {hybrid && thread && (
                  <span
                    className="rounded px-1 py-px text-[9px] font-semibold"
                    style={{
                      color,
                      backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)",
                    }}
                  >
                    {efficient ? "E" : "P"}
                  </span>
                )}
                <span>CPU {index}</span>
                {typeof mhz === "number" && Number.isFinite(mhz) && mhz > 0 && (
                  <span className="truncate">{(mhz / 1000).toFixed(2)} GHz</span>
                )}
              </span>
              <span className="text-foreground shrink-0">
                {formatPercent(cores[index] ?? Number.NaN, 0)}
              </span>
            </div>
            <div style={{ color }}>
              <Sparkline
                series={[
                  {
                    points: key ? historyValues(history, key) : [],
                    color,
                  },
                ]}
                max={100}
                className="h-8"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
