// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// A canvas line chart for the performance tab.
//
// One point per sample, oldest first: the curve scrolls with the history and
// consecutive readings always join. The frame carries the color and the grid
// (chart-frame.tsx); the canvas draws only the traces. Labels sit outside the
// frame, as on the Argus charts: the series' name and top above, the window's
// span and zero below, and the legend under that.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
  /** The floor a filled chart shrinks to, px. */
  fillMin?: number;
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
  max: number,
  hoverIndex: number
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

  if (hoverIndex >= 0 && hoverIndex < count) {
    const x = xAt(hoverIndex);
    context.globalAlpha = 0.45;
    context.strokeStyle = resolveChartColor(canvas, series[0]?.color ?? CHART_COLORS.grid);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, top);
    context.lineTo(x, bottom);
    context.stroke();
    context.globalAlpha = 1;
    for (const entry of series) {
      const value = entry.points[hoverIndex];
      if (value === null || value === undefined || !Number.isFinite(value)) continue;
      context.fillStyle = resolveChartColor(canvas, entry.color);
      context.beginPath();
      context.arc(x, yAt(value), 3, 0, Math.PI * 2);
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
  fillMin = 240,
  formatValue,
  label,
  className,
}: TraceChartProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<{ index: number; x: number } | null>(null);

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
  const count = series.reduce((longest, entry) => Math.max(longest, entry.points.length), 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;
    drawTrace(canvas, size.width, size.height, series, max, hover?.index ?? -1);
  }, [size, series, max, hover]);

  const trackHover = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const usable = rect.width - PAD * 2;
    if (usable <= 0) return;
    const ratio = (event.clientX - rect.left - PAD) / usable;
    const index = Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
    setHover({ index, x: event.clientX - rect.left });
  };

  /** Seconds before the newest sample, for the hover readout. */
  const ago = (index: number) =>
    count <= 1 ? 0 : Math.round(((count - 1 - index) * spanSeconds) / (count - 1));

  const currentValue = (points: readonly (number | null)[]): string => {
    const index = lastValueIndex(points);
    return format(index < 0 ? Number.NaN : (points[index] ?? Number.NaN));
  };

  const swatch = series[0]?.color ?? CHART_COLORS.grid;

  return (
    <figure className={cn("m-0 flex flex-col", fill && "flex-1", className)}>
      <div className="text-muted-foreground flex items-baseline justify-between gap-3 text-[12px] tabular-nums">
        <span className="min-w-0 truncate">{title}</span>
        <span className="shrink-0">{format(Number.isFinite(max) && max > 0 ? max : 1)}</span>
      </div>
      <div
        ref={frameRef}
        onPointerMove={trackHover}
        onPointerLeave={() => setHover(null)}
        className={cn(
          "relative mt-0.5 cursor-crosshair overflow-hidden rounded-[4px] border",
          fill && "flex-1"
        )}
        style={{
          ...chartFrameStyle(swatch),
          height: fill ? undefined : height,
          minHeight: fill ? fillMin : undefined,
        }}
      >
        <canvas ref={canvasRef} role="img" aria-label={label} className="absolute inset-0" />
        {hover !== null && count > 0 && (
          <div
            aria-hidden
            className={cn(
              "bg-popover/95 pointer-events-none absolute top-1 z-10 max-w-[75%] rounded-md border px-2 py-1 text-[11px] shadow-sm",
              hover.x > size.width / 2 ? "right-1" : "left-1"
            )}
          >
            <div className="text-muted-foreground tabular-nums">
              {ago(hover.index) === 0 ? "0s" : `-${ago(hover.index)}s`}
            </div>
            {series.map((entry) => (
              <div key={entry.label} className="flex items-center gap-1.5 whitespace-nowrap">
                <span
                  className="inline-block w-3 shrink-0 border-t-2"
                  style={{
                    borderColor: entry.color,
                    borderTopStyle: entry.dashed ? "dashed" : "solid",
                  }}
                />
                <span className="text-muted-foreground">{entry.label}</span>
                <span className="text-foreground ml-auto pl-2 font-medium tabular-nums">
                  {format(entry.points[hover.index] ?? Number.NaN)}
                </span>
              </div>
            ))}
          </div>
        )}
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
