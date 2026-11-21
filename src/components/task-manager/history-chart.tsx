// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// One static chart of recorded frames, drawn once per answer. Unlike the
// performance tab's rolling trace, the horizontal axis is wall clock time and
// a stretched gap (the recorder was not running) breaks the line instead of
// joining two distant points.

import { useEffect, useRef, useState } from "react";
import type { HistoryPoint } from "@/commands";
import { resolveChartColor } from "@/lib/task-manager/chart-colors";
import type { HistoryView } from "@/lib/task-manager/history-range";

/** Height of one chart, CSS px. */
export const HISTORY_CHART_HEIGHT = 88;
/** Height of the shared time axis under the charts, CSS px. */
export const HISTORY_AXIS_HEIGHT = 20;

/** Line width, CSS px. */
const LINE = 1.5;
/** Headroom: half the line, so a line at full scale lies whole against the top edge. */
const TOP_PAD = LINE / 2;

type HistoryChartProps = {
  view: HistoryView;
  /** Axis ticks, shared by every chart and the axis below them. */
  ticks: readonly number[];
  /** A CSS color, e.g. `var(--perf-cpu)`. */
  color: string;
  value: (point: HistoryPoint) => number | null;
  /** A faint second line, e.g. the CPU's one-second peak. */
  peak?: (point: HistoryPoint) => number | null;
  /** Top of the vertical axis; values above it are clamped. */
  max: number;
  /** The point the readout shows, marked with a dot. */
  cursor: HistoryPoint | null;
  /** Accessible name, since the canvas carries no text of its own. */
  label: string;
};

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

type Run = { start: number; end: number };

/** Contiguous stretches of readings: a missing value or an unjoined pair ends one. */
function chartRuns(view: HistoryView, value: (point: HistoryPoint) => number | null): Run[] {
  const runs: Run[] = [];
  for (let index = 0; index < view.points.length; index += 1) {
    const reading = value(view.points[index]);
    if (reading === null || !Number.isFinite(reading)) continue;
    const last = runs.at(-1);
    if (last && last.end === index - 1 && view.joined[index - 1]) last.end = index;
    else runs.push({ start: index, end: index });
  }
  return runs;
}

function drawChart(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  view: HistoryView,
  ticks: readonly number[],
  color: string,
  value: (point: HistoryPoint) => number | null,
  peak: ((point: HistoryPoint) => number | null) | undefined,
  max: number,
  cursor: HistoryPoint | null
): void {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = Math.max(1, Math.floor(width));
  const cssHeight = Math.max(1, Math.floor(height));
  canvas.width = Math.round(cssWidth * ratio);
  canvas.height = Math.round(cssHeight * ratio);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  const span = Math.max(1, view.to - view.from);
  const ceiling = Number.isFinite(max) && max > 0 ? max : 1;
  const resolved = resolveChartColor(canvas, color);
  const xAt = (ts: number) => ((ts - view.from) / span) * cssWidth;
  const yAt = (reading: number) =>
    TOP_PAD + (1 - clampUnit(reading / ceiling)) * (cssHeight - TOP_PAD);

  // Grid: quarters across, the time ticks down.
  context.save();
  context.globalAlpha = 0.13;
  context.strokeStyle = resolved;
  context.lineWidth = 1;
  context.beginPath();
  for (const fraction of [0.25, 0.5, 0.75]) {
    const y = Math.round(cssHeight * fraction) + 0.5;
    context.moveTo(0, y);
    context.lineTo(cssWidth, y);
  }
  for (const tick of ticks) {
    const x = Math.round(xAt(tick)) + 0.5;
    context.moveTo(x, 0);
    context.lineTo(x, cssHeight);
  }
  context.stroke();
  context.restore();

  const runs = chartRuns(view, value);
  context.lineJoin = "round";
  context.lineCap = "round";

  for (const run of runs) {
    if (run.start === run.end) {
      // A lone frame between gaps: a dot, where a line would have no length.
      const point = view.points[run.start];
      const reading = value(point);
      if (reading === null) continue;
      context.fillStyle = resolved;
      context.beginPath();
      context.arc(xAt(point.ts), yAt(reading), 1.5, 0, Math.PI * 2);
      context.fill();
      continue;
    }

    if (peak) {
      context.save();
      context.globalAlpha = 0.45;
      context.strokeStyle = resolved;
      context.lineWidth = 1;
      context.setLineDash([4, 3]);
      context.beginPath();
      let started = false;
      for (let index = run.start; index <= run.end; index += 1) {
        const point = view.points[index];
        const reading = peak(point);
        if (reading === null) continue;
        if (!started) {
          context.moveTo(xAt(point.ts), yAt(reading));
          started = true;
        } else {
          context.lineTo(xAt(point.ts), yAt(reading));
        }
      }
      context.stroke();
      context.restore();
    }

    // The filled area under the line.
    context.save();
    context.globalAlpha = 0.12;
    context.fillStyle = resolved;
    context.beginPath();
    for (let index = run.start; index <= run.end; index += 1) {
      const point = view.points[index];
      const reading = value(point);
      if (reading === null) continue;
      const x = xAt(point.ts);
      const y = yAt(reading);
      if (index === run.start) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    const first = view.points[run.start];
    const last = view.points[run.end];
    context.lineTo(xAt(last.ts), cssHeight);
    context.lineTo(xAt(first.ts), cssHeight);
    context.closePath();
    context.fill();
    context.restore();

    context.strokeStyle = resolved;
    context.lineWidth = LINE;
    context.beginPath();
    for (let index = run.start; index <= run.end; index += 1) {
      const point = view.points[index];
      const reading = value(point);
      if (reading === null) continue;
      const x = xAt(point.ts);
      const y = yAt(reading);
      if (index === run.start) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }

  if (cursor) {
    const reading = value(cursor);
    if (reading !== null && Number.isFinite(reading)) {
      context.fillStyle = resolved;
      context.beginPath();
      context.arc(xAt(cursor.ts), yAt(reading), 2.5, 0, Math.PI * 2);
      context.fill();
    }
  }
}

export function HistoryChart({
  view,
  ticks,
  color,
  value,
  peak,
  max,
  cursor,
  label,
}: HistoryChartProps) {
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;
    drawChart(canvas, size.width, size.height, view, ticks, color, value, peak, max, cursor);
  }, [size, view, ticks, color, value, peak, max, cursor]);

  return (
    <div
      ref={frameRef}
      className="relative border"
      style={{
        borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
        height: HISTORY_CHART_HEIGHT,
      }}
    >
      <canvas ref={canvasRef} role="img" aria-label={label} className="absolute inset-0" />
    </div>
  );
}

/** The time axis under the charts, on the same boundaries as their grid. */
export function HistoryAxis({
  view,
  ticks,
  formatTick,
}: {
  view: HistoryView;
  ticks: readonly number[];
  formatTick: (ts: number) => string;
}) {
  const span = Math.max(1, view.to - view.from);
  return (
    <div
      className="text-muted-foreground relative text-[10px] tabular-nums"
      style={{ height: HISTORY_AXIS_HEIGHT }}
      aria-hidden="true"
    >
      {ticks.map((tick) => {
        const fraction = (tick - view.from) / span;
        if (fraction <= 0.03 || fraction >= 0.97) return null;
        return (
          <span
            key={tick}
            className="absolute top-1 -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${fraction * 100}%` }}
          >
            {formatTick(tick)}
          </span>
        );
      })}
    </div>
  );
}
