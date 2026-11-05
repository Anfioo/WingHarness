import { useId, useMemo, useState } from "react";
import { formatBytes } from "./shared";

export type TrafficPoint = {
  at: number;
  up: number;
  down: number;
};

const WIDTH = 1000;
const HEIGHT = 1000;
const TOP_PADDING = 50;
const UP_COLOR = "#10b981";
const DOWN_COLOR = "#0ea5e9";

/**
 * A compact upload/download rate chart.
 *
 * The window is fixed to `rangeMs`, so a quiet stretch keeps its flat line
 * instead of stretching the few samples that exist. Hovering reads the nearest
 * sample; the axis labels are plain HTML over the plot, which keeps them crisp
 * while the SVG itself stretches to any width.
 */
export function TrafficChart({
  points,
  rangeMs,
  precise,
  labels,
}: {
  points: TrafficPoint[];
  rangeMs: number;
  /** Show seconds on the axis; only the one-minute window needs them. */
  precise: boolean;
  labels: { waiting: string; upload: string; download: string };
}) {
  const [hover, setHover] = useState<{ index: number; ratio: number } | null>(null);
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  // The window's right edge is the present moment, which is not a value React
  // can derive from props: the chart follows the clock, not the samples.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const start = now - rangeMs;
  const visible = useMemo(() => points.filter((point) => point.at >= start), [points, start]);

  const max = visible.reduce((value, point) => Math.max(value, point.up, point.down), 0);
  const ceiling = max > 0 ? max : 1;
  const x = (at: number) => ((at - start) / rangeMs) * WIDTH;
  const y = (value: number) => HEIGHT - (value / ceiling) * (HEIGHT - TOP_PADDING);

  const upLine = linePath(visible.map((point) => ({ x: x(point.at), y: y(point.up) })));
  const downLine = linePath(visible.map((point) => ({ x: x(point.at), y: y(point.down) })));
  const left = visible.length > 0 ? x(visible[0].at) : 0;
  const right = visible.length > 0 ? x(visible[visible.length - 1].at) : WIDTH;
  const upArea = areaPath(upLine, left, right);
  const downArea = areaPath(downLine, left, right);

  const hovered = hover ? visible[hover.index] : null;

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (visible.length < 2) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const target = start + ratio * rangeMs;
    let index = 0;
    let distance = Infinity;
    visible.forEach((point, position) => {
      const next = Math.abs(point.at - target);
      if (next < distance) {
        distance = next;
        index = position;
      }
    });
    setHover({ index, ratio });
  };

  const timeLabels = [0, 0.25, 0.5, 0.75, 1].map((part) => start + rangeMs * part);

  return (
    <div
      className="bg-muted/20 relative h-40 w-full cursor-crosshair overflow-hidden rounded-md border sm:h-44"
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        className="absolute inset-0 size-full"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        <defs>
          <linearGradient id={`${gradientId}-up`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={UP_COLOR} stopOpacity="0.3" />
            <stop offset="100%" stopColor={UP_COLOR} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${gradientId}-down`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={DOWN_COLOR} stopOpacity="0.3" />
            <stop offset="100%" stopColor={DOWN_COLOR} stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75].map((part) => (
          <line
            key={part}
            x1="0"
            x2={WIDTH}
            y1={HEIGHT * part}
            y2={HEIGHT * part}
            stroke="currentColor"
            className="text-border"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {downLine && <path d={downArea} fill={`url(#${gradientId}-down)`} />}
        {upLine && <path d={upArea} fill={`url(#${gradientId}-up)`} />}

        {downLine && (
          <path
            d={downLine}
            fill="none"
            stroke={DOWN_COLOR}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {upLine && (
          <path
            d={upLine}
            fill="none"
            stroke={UP_COLOR}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {hovered && (
          <line
            x1={hover!.ratio * WIDTH}
            x2={hover!.ratio * WIDTH}
            y1="0"
            y2={HEIGHT}
            stroke="currentColor"
            className="text-muted-foreground/60"
            strokeWidth="1"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {visible.length < 2 ? (
        <div className="text-muted-foreground/70 absolute inset-0 flex items-center justify-center text-xs">
          {labels.waiting}
        </div>
      ) : null}

      <div className="text-muted-foreground/80 pointer-events-none absolute top-1.5 left-2 font-mono text-[11px] tabular-nums">
        {formatBytes(ceiling)}/s
      </div>

      <div className="pointer-events-none absolute top-1.5 right-2 flex items-center gap-2 text-[11px] font-medium">
        <span style={{ color: UP_COLOR }}>↑ {labels.upload}</span>
        <span style={{ color: DOWN_COLOR }}>↓ {labels.download}</span>
      </div>

      <div className="text-muted-foreground/60 pointer-events-none absolute right-2 bottom-1 left-2 flex justify-between font-mono text-[11px] tabular-nums">
        {timeLabels.map((at, index) => (
          <span key={index}>{timeLabel(at, precise)}</span>
        ))}
      </div>

      {hovered && hover && (
        <div
          className="bg-popover text-popover-foreground pointer-events-none absolute top-7 z-10 rounded-md border px-2 py-1.5 text-[11px] leading-relaxed shadow-md"
          style={{
            left: `${hover.ratio * 100}%`,
            transform: hover.ratio > 0.6 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <div className="text-muted-foreground font-mono">{timeLabel(hovered.at, true)}</div>
          <div className="font-mono tabular-nums" style={{ color: UP_COLOR }}>
            ↑ {formatBytes(hovered.up)}/s
          </div>
          <div className="font-mono tabular-nums" style={{ color: DOWN_COLOR }}>
            ↓ {formatBytes(hovered.down)}/s
          </div>
        </div>
      )}
    </div>
  );
}

function timeLabel(at: number, precise: boolean): string {
  const date = new Date(at);
  return precise
    ? date.toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** A smooth line through every sample, in the chart's normalized space. */
function linePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const middle = (previous.x + current.x) / 2;
    path += ` C ${middle} ${previous.y}, ${middle} ${current.y}, ${current.x} ${current.y}`;
  }
  return path;
}

function areaPath(line: string, left: number, right: number): string {
  if (!line) return "";
  return `${line} L ${right} ${HEIGHT} L ${left} ${HEIGHT} Z`;
}
