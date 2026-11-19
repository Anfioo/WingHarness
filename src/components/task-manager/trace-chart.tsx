// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// A canvas line chart for the performance tab.
//
// One point per sample, oldest first: the curve scrolls with the history and
// consecutive readings always join. The frame carries the color and the grid
// (chart-frame.tsx); the canvas draws only the traces. Labels sit outside the
// frame, as on the Argus charts: the series' name and top above, the window's
// span and zero below, and the legend under that.

import { useEffect, useRef, useState } from "react";
import { chartFrameStyle } from "@/components/task-manager/chart-frame";
import { formatBytes, formatPercent, formatRate } from "@/components/task-manager/format";
import { CHART_COLORS, resolveChartColor } from "@/lib/task-manager/chart-colors";
import { cn } from "@/lib/utils";

export type TraceSeries = {
  /** Legend label; the chart itself draws no text for it. */
  label: string;
  /** A CSS color, e.g. `var(--perf-cpu)`. */
  color: string;
  /** Oldest first; `null` breaks the line and leaves the point empty. */
  points: readonly (number | null)[];
  /** Fill the area under the line; meant for a single-series chart. */
  fill?: boolean;
  /** Draw the line dashed, e.g. a secondary reading such as kernel time. */
  dashed?: boolean;
};

/** What the vertical axis measures; decides the tick labels. */
export type TraceUnit = "percent" | "rate" | "bytes";

type TraceChartProps = {
  /** Name shown above the frame, on the left. */
  title: string;
  series: TraceSeries[];
  /** Top of the vertical axis; the plot clamps values above it. */
  max: number;
  unit: TraceUnit;
  /** Seconds the window covers, shown under the frame. */
  spanSeconds: number;
  /** Fixed frame height; ignored when `fill` is set. */
  height?: number;
  /** Grow into the height the detail view leaves, with a 240 px floor. */
  fill?: boolean;
  /** Overrides the unit's formatter, e.g. `rateCeilingLabel`. */
  formatValue?: (value: number) => string;
  /** Accessible name, since the canvas carries no text of its own. */
  label: string;
  className?: string;
};

const PAD = 2;

function defaultFormatter(unit: TraceUnit): (value: number) => string {
  if (unit === "percent") return (value) => formatPercent(value, 0);
  if (unit === "rate") return (value) => formatRate(value, 0);
  return (value) => formatBytes(value, 0);
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function lastValueIndex(points: readonly (number | null)[]): number {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index];
    if (value !== null && Number.isFinite(value)) return index;
  }
  return -1;
}

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

function drawTrace(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  series: readonly TraceSeries[],
  max: number
): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(cssWidth));
  const height = Math.max(1, Math.floor(cssHeight));
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const left = PAD;
  const right = width - PAD;
  const top = PAD;
  const bottom = height - PAD;
  if (right <= left || bottom <= top) return;

  const ceiling = Number.isFinite(max) && max > 0 ? max : 1;
  const count = series.reduce((longest, entry) => Math.max(longest, entry.points.length), 0);
  if (count === 0) return;

  const xAt = (index: number) =>
    count <= 1 ? left : left + ((right - left) * index) / (count - 1);
  const yAt = (value: number) => bottom - clampUnit(value / ceiling) * (bottom - top);

  for (const entry of series) {
    const color = resolveChartColor(canvas, entry.color);
    const points = entry.points;

    for (const run of lineRuns(points)) {
      if (entry.fill) {
        context.globalAlpha = 0.14;
        context.fillStyle = color;
        context.beginPath();
        context.moveTo(xAt(run.start), bottom);
        for (let index = run.start; index <= run.end; index += 1) {
          context.lineTo(xAt(index), yAt(points[index] ?? 0));
        }
        context.lineTo(xAt(run.end), bottom);
        context.closePath();
        context.fill();
        context.globalAlpha = 1;
      }

      if (run.start === run.end) continue;

      context.strokeStyle = color;
      context.lineWidth = 1.5;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.setLineDash(entry.dashed ? [4, 3] : []);
      context.beginPath();
      for (let index = run.start; index <= run.end; index += 1) {
        const x = xAt(index);
        const y = yAt(points[index] ?? 0);
        if (index === run.start) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
      context.setLineDash([]);
    }

    const newest = lastValueIndex(points);
    if (newest >= 0) {
      context.fillStyle = color;
      context.beginPath();
      context.arc(xAt(newest), yAt(points[newest] ?? 0), 2.5, 0, Math.PI * 2);
      context.fill();
    }
  }
}

/** A rolling line chart with its frame, labels and legend. */
export function TraceChart({
  title,
  series,
  max,
  unit,
  spanSeconds,
  height = 160,
  fill = false,
  formatValue,
  label,
  className,
}: TraceChartProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = (width: number, height: number) =>
      setSize((current) =>
        Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height }
      );
    const rect = frame.getBoundingClientRect();
    update(rect.width, rect.height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const format = formatValue ?? defaultFormatter(unit);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;
    drawTrace(canvas, size.width, size.height, series, max);
  }, [size, series, max]);

  const currentValue = (points: readonly (number | null)[]): string => {
    const index = lastValueIndex(points);
    return format(index < 0 ? Number.NaN : (points[index] ?? Number.NaN));
  };

  const swatch = series[0]?.color ?? CHART_COLORS.grid;

  return (
    <figure className={cn("m-0 flex min-h-0 flex-col", fill && "flex-1", className)}>
      <div className="text-muted-foreground flex items-baseline justify-between gap-3 text-[12px] tabular-nums">
        <span className="min-w-0 truncate">{title}</span>
        <span className="shrink-0">{format(Number.isFinite(max) && max > 0 ? max : 1)}</span>
      </div>
      <div
        ref={frameRef}
        className={cn(
          "relative mt-0.5 overflow-hidden rounded-[4px] border",
          fill && "min-h-[240px] flex-1"
        )}
        style={{ ...chartFrameStyle(swatch), height: fill ? undefined : height }}
      >
        <canvas ref={canvasRef} role="img" aria-label={label} className="absolute inset-0" />
      </div>
      <div className="text-muted-foreground mt-1 grid grid-cols-3 text-[11px] tabular-nums">
        <span>{`-${spanSeconds}s`}</span>
        <span className="text-center opacity-80">{`-${Math.round(spanSeconds / 2)}s`}</span>
        <span className="text-right">0s</span>
      </div>
      <div className="text-muted-foreground mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {series.map((entry) => (
          <span key={entry.label} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block w-3.5 border-t-2"
              style={{
                borderColor: entry.color,
                borderTopStyle: entry.dashed ? "dashed" : "solid",
              }}
            />
            {entry.label}
            <span className="text-foreground font-medium tabular-nums">
              {currentValue(entry.points)}
            </span>
          </span>
        ))}
      </div>
    </figure>
  );
}
