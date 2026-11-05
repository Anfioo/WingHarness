import { useId, useState, type MouseEvent } from "react";

export type MetricSeries = { key: string; label: string; color: string };
/** `at` is a millisecond timestamp; `values` is keyed by `MetricSeries.key`. */
export type MetricPoint = { at: number; values: Record<string, number> };

const WIDTH = 1000;
const HEIGHT = 1000;
const TOP_PADDING = 50;

/**
 * A small multi-series line chart drawn with plain SVG.
 *
 * The window is fixed to `rangeMs` and its right edge is the present moment,
 * so a gap in samples reads as a flat line instead of stretching the curve.
 * A single series gets a soft area fill; two or more stay as bare lines.
 */
export function MetricChart({
  points,
  series,
  rangeMs = 120_000,
  maxValue,
  formatValue,
  labels,
}: {
  points: MetricPoint[];
  series: MetricSeries[];
  rangeMs?: number;
  /** Fixed vertical ceiling, e.g. `100` for percentages. */
  maxValue?: number;
  formatValue: (value: number) => string;
  labels: { waiting: string };
}) {
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  // The timestamp under the pointer, not an index: the window scrolls every
  // second and an index would point at a different sample after each refresh.
  const [hoverAt, setHoverAt] = useState<number | null>(null);

  // The chart follows the clock, not the samples: the window's right edge is
  // always "now".
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const start = now - rangeMs;
  const visible = points.filter((point) => point.at >= start);

  const peak = visible.reduce(
    (value, point) =>
      series.reduce((inner, entry) => Math.max(inner, point.values[entry.key] ?? 0), value),
    0
  );
  const ceiling = maxValue ?? (peak > 0 ? peak : 1);

  const x = (at: number) => ((at - start) / rangeMs) * WIDTH;
  const y = (value: number) => HEIGHT - (value / ceiling) * (HEIGHT - TOP_PADDING);

  const lines = series.map((entry) => {
    const path = linePath(
      visible.map((point) => ({ x: x(point.at), y: y(point.values[entry.key] ?? 0) }))
    );
    return { entry, path };
  });

  const timeLabels = [0, 0.25, 0.5, 0.75, 1].map((part) => start + rangeMs * part);
  const fillable = series.length === 1 && lines[0].path !== "";

  const hoverable = visible.length >= 2;
  const hovered = hoverAt === null || !hoverable ? null : nearestPoint(visible, hoverAt);
  const hoverX = hovered === null ? 0 : clamp(((hovered.at - start) / rangeMs) * 100, 0, 100);

  const handleMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!hoverable) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    setHoverAt(start + fraction * rangeMs);
  };

  return (
    <div
      className="bg-muted/20 relative h-36 w-full overflow-hidden rounded-md border"
      onMouseMove={handleMove}
      onMouseLeave={() => setHoverAt(null)}
    >
      <svg
        className="absolute inset-0 size-full"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        {fillable && (
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={series[0].color} stopOpacity="0.3" />
              <stop offset="100%" stopColor={series[0].color} stopOpacity="0" />
            </linearGradient>
          </defs>
        )}

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

        {fillable && (
          <path
            d={areaPath(lines[0].path, x(visible[0].at), x(visible[visible.length - 1].at))}
            fill={`url(#${gradientId})`}
          />
        )}

        {lines.map(({ entry, path }) =>
          path ? (
            <path
              key={entry.key}
              d={path}
              fill="none"
              stroke={entry.color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null
        )}
      </svg>

      {hovered !== null && (
        <>
          <div
            className="bg-foreground/20 pointer-events-none absolute inset-y-0 w-px"
            style={{ left: `${hoverX}%` }}
          />
          {series.map((entry) => (
            <span
              key={entry.key}
              className="ring-background pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
              style={{
                left: `${hoverX}%`,
                top: `${(y(hovered.values[entry.key] ?? 0) / HEIGHT) * 100}%`,
                backgroundColor: entry.color,
              }}
            />
          ))}
          <div
            className="bg-popover text-popover-foreground pointer-events-none absolute top-6 z-10 min-w-28 rounded-md border px-2 py-1 shadow-md"
            style={{
              left: `${hoverX}%`,
              transform: `translateX(${hoverX > 60 ? "calc(-100% - 8px)" : "8px"})`,
            }}
          >
            <div className="text-muted-foreground font-mono text-[10px] tabular-nums">
              {timeLabel(hovered.at)}
            </div>
            {series.map((entry) => (
              <div key={entry.key} className="flex items-center justify-between gap-3 text-[11px]">
                <span className="flex items-center gap-1" style={{ color: entry.color }}>
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: entry.color }}
                  />
                  {entry.label}
                </span>
                <span className="text-foreground font-mono tabular-nums">
                  {formatValue(hovered.values[entry.key] ?? 0)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {visible.length < 2 && (
        <div className="text-muted-foreground/70 absolute inset-0 flex items-center justify-center text-xs">
          {labels.waiting}
        </div>
      )}

      <div className="text-muted-foreground/80 pointer-events-none absolute top-1.5 left-2 font-mono text-[11px] tabular-nums">
        {formatValue(ceiling)}
      </div>

      <div className="pointer-events-none absolute top-1.5 right-2 flex items-center gap-2 text-[11px] font-medium">
        {series.map((entry) => (
          <span key={entry.key} style={{ color: entry.color }}>
            {entry.label}
          </span>
        ))}
      </div>

      <div className="text-muted-foreground/60 pointer-events-none absolute right-2 bottom-1 left-2 flex justify-between font-mono text-[11px] tabular-nums">
        {timeLabels.map((at, index) => (
          <span key={index}>{timeLabel(at)}</span>
        ))}
      </div>
    </div>
  );
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" });
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** The sample whose timestamp is closest to `at`. */
function nearestPoint(points: MetricPoint[], at: number): MetricPoint {
  let best = points[0];
  for (const point of points) {
    if (Math.abs(point.at - at) < Math.abs(best.at - at)) best = point;
  }
  return best;
}
