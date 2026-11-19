// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// A tiny line chart for the performance device list and the per-core grid.
// It shares the history window with the detail charts but draws no axes: the
// text around it carries the current reading.

import { cn } from "@/lib/utils";

export type SparkSeries = {
  points: readonly (number | null)[];
  color: string;
  dashed?: boolean;
};

/** Contiguous stretches of readings; a null ends the current one. */
function lineRuns(points: readonly (number | null)[]): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const value = points[index];
    if (value === null || !Number.isFinite(value)) continue;
    const last = runs.at(-1);
    if (last && last.end === index - 1) last.end = index;
    else runs.push({ start: index, end: index });
  }
  return runs;
}

export function Sparkline({
  series,
  max,
  className,
}: {
  series: readonly SparkSeries[];
  /** Top of the vertical scale; values above it are clamped. */
  max: number;
  className?: string;
}) {
  const count = series.reduce((longest, entry) => Math.max(longest, entry.points.length), 0);
  const ceiling = Number.isFinite(max) && max > 0 ? max : 1;
  const xAt = (index: number) => (count <= 1 ? 50 : (index / (count - 1)) * 100);
  const yAt = (value: number) => 100 - Math.min(1, Math.max(0, value / ceiling)) * 100;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn("pointer-events-none h-7 w-full overflow-visible", className)}
    >
      {series.map((entry, seriesIndex) => (
        <g key={seriesIndex}>
          {lineRuns(entry.points).map((run) => {
            if (run.start === run.end) {
              const value = entry.points[run.start] ?? 0;
              return (
                <circle
                  key={run.start}
                  cx={xAt(run.start)}
                  cy={yAt(value)}
                  r={1.5}
                  style={{ fill: entry.color }}
                  vectorEffect="non-scaling-stroke"
                />
              );
            }
            const points = [];
            for (let index = run.start; index <= run.end; index += 1) {
              points.push(`${xAt(index)},${yAt(entry.points[index] ?? 0)}`);
            }
            return (
              <polyline
                key={run.start}
                points={points.join(" ")}
                fill="none"
                style={{ stroke: entry.color }}
                strokeWidth={1.5}
                strokeDasharray={entry.dashed ? "4 3" : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>
      ))}
    </svg>
  );
}
