// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// A canvas line chart for the performance tab.
//
// The window is the last 60 one-second buckets, so the curve scrolls with the
// history rather than being resampled from a fixed pixel width. Empty buckets
// break the line: a sample interval slower than a second should read as a gap,
// not as a slow ramp between distant points.

import { useEffect, useRef, useState } from "react";
import { formatBytes, formatPercent, formatRate } from "@/components/task-manager/format";
import { CHART_COLORS, resolveChartColor } from "@/lib/task-manager/chart-colors";
import { HISTORY_SECONDS } from "@/lib/task-manager/chart-history";
import { cn } from "@/lib/utils";

export type TraceSeries = {
  /** Legend label; the chart itself draws no text for it. */
  label: string;
  /** A CSS color, e.g. `var(--primary)` or `hsl(var(--info))`. */
  color: string;
  /** Oldest first; `null` breaks the line and leaves the bucket empty. */
  points: readonly (number | null)[];
  /** Fill the area under the line; meant for a single-series chart. */
  fill?: boolean;
};

/** What the vertical axis measures; decides the tick labels. */
export type TraceUnit = "percent" | "rate" | "bytes";

type TraceChartProps = {
  series: TraceSeries[];
  /** Top of the vertical axis; the plot clamps values above it. */
  max: number;
  unit: TraceUnit;
  height?: number;
  /** Overrides the unit's formatter, e.g. `rateCeilingLabel`. */
  formatValue?: (value: number) => string;
  /** Accessible name, since the canvas carries no text of its own. */
  label: string;
  className?: string;
};

const AXIS_FONT = "10px ui-sans-serif, system-ui, sans-serif";
const TIME_FONT = "9px ui-sans-serif, system-ui, sans-serif";
const PAD_TOP = 4;
const PAD_BOTTOM = 15;
const PAD_RIGHT = 6;
const GUTTER = 56;
const GRID_ROWS = 4;

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
  max: number,
  format: (value: number) => string
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

  const left = GUTTER;
  const right = width - PAD_RIGHT;
  const top = PAD_TOP;
  const bottom = height - PAD_BOTTOM;
  if (right <= left || bottom <= top) return;

  const ceiling = Number.isFinite(max) && max > 0 ? max : 1;
  const gridColor = resolveChartColor(canvas, CHART_COLORS.grid);
  const axisColor = resolveChartColor(canvas, CHART_COLORS.axis);

  context.font = AXIS_FONT;
  context.textBaseline = "middle";
  context.textAlign = "right";

  for (let row = 0; row <= GRID_ROWS; row += 1) {
    const y = top + ((bottom - top) * row) / GRID_ROWS;
    context.globalAlpha = row === GRID_ROWS ? 0.9 : 0.45;
    context.strokeStyle = gridColor;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
    context.globalAlpha = 1;
    if (row % 2 === 0) {
      context.fillStyle = axisColor;
      context.fillText(format(ceiling * (1 - row / GRID_ROWS)), left - 6, y);
    }
  }

  const count = series.reduce((longest, entry) => Math.max(longest, entry.points.length), 0);
  if (count >= 2) {
    const xAt = (index: number) => left + ((right - left) * index) / (count - 1);
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

        context.strokeStyle = color;
        context.lineWidth = 1.5;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.beginPath();
        for (let index = run.start; index <= run.end; index += 1) {
          const x = xAt(index);
          const y = yAt(points[index] ?? 0);
          if (index === run.start) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }

      const newest = lastValueIndex(points);
      if (newest >= 0) {
        context.fillStyle = color;
        context.beginPath();
        context.arc(xAt(newest), yAt(points[newest] ?? 0), 2.25, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  context.fillStyle = axisColor;
  context.font = TIME_FONT;
  context.textBaseline = "top";
  context.textAlign = "left";
  context.fillText(`-${HISTORY_SECONDS}s`, left, bottom + 5);
  context.textAlign = "center";
  context.fillText(`-${HISTORY_SECONDS / 2}s`, (left + right) / 2, bottom + 5);
  context.textAlign = "right";
  context.fillText("0s", right, bottom + 5);
}

/** A rolling line chart with its legend and current readings. */
export function TraceChart({
  series,
  max,
  unit,
  height = 120,
  formatValue,
  label,
  className,
}: TraceChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = (next: number) =>
      setWidth((current) => (Math.abs(current - next) < 0.5 ? current : next));
    update(wrap.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  const format = formatValue ?? defaultFormatter(unit);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    drawTrace(canvas, width, height, series, max, format);
  }, [width, height, series, max, format]);

  const currentValue = (points: readonly (number | null)[]): string => {
    const index = lastValueIndex(points);
    return format(index < 0 ? Number.NaN : (points[index] ?? Number.NaN));
  };

  return (
    <figure className={cn("m-0 flex flex-col gap-1.5", className)}>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {series.map((entry) => (
          <span
            key={entry.label}
            className="text-muted-foreground flex items-center gap-1.5 text-[11px]"
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            {entry.label}
            <span className="text-foreground font-medium tabular-nums">
              {currentValue(entry.points)}
            </span>
          </span>
        ))}
      </figcaption>
      <div ref={wrapRef} className="relative w-full" style={{ height }}>
        <canvas ref={canvasRef} role="img" aria-label={label} className="absolute inset-0" />
      </div>
    </figure>
  );
}
