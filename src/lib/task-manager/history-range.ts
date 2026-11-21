// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Time ranges, axis ticks and gap detection for the history tab.
//
// The backend records one frame every five seconds. A bucket query averages
// frames into at most `buckets` points and leaves empty buckets out, so a
// window where the recorder was not running arrives as a wide jump between
// two points: `joins` decides which of those jumps the line may cross.

import type { HistoryPoint } from "@/commands";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One recorded frame (`FRAME_MS` in argus-core/src/history.rs). */
export const FRAME_MS = 5_000;

/**
 * The widest spacing of frames the recorder produces: the slowest background
 * interval (60 s) plus how late a sample can land.
 */
export const MAX_CADENCE = 65_000;

export type HistoryRangeId = "1h" | "6h" | "24h" | "7d";

export type HistoryRange = {
  id: HistoryRangeId;
  /** Window length, ms. */
  ms: number;
  /** Spacing of the axis labels, ms. */
  tickMs: number;
  /** Points requested per query; far below the backend's 4096 cap. */
  buckets: number;
  /** How often the window follows new frames, ms. */
  refreshMs: number;
};

export const HISTORY_RANGES: readonly HistoryRange[] = [
  { id: "1h", ms: HOUR, tickMs: 10 * MINUTE, buckets: 360, refreshMs: 10_000 },
  { id: "6h", ms: 6 * HOUR, tickMs: HOUR, buckets: 360, refreshMs: 10_000 },
  { id: "24h", ms: DAY, tickMs: 3 * HOUR, buckets: 288, refreshMs: 60_000 },
  { id: "7d", ms: 7 * DAY, tickMs: DAY, buckets: 336, refreshMs: 60_000 },
];

/** The range definition for an id; falls back to the first range. */
export function historyRange(id: HistoryRangeId): HistoryRange {
  return HISTORY_RANGES.find((range) => range.id === id) ?? HISTORY_RANGES[0];
}

/** One query's points plus the times and join flags the charts draw from. */
export type HistoryView = {
  from: number;
  to: number;
  /** Spacing of the buckets the query asked for. */
  step: number;
  points: readonly HistoryPoint[];
  /** The points' times, in order. */
  ts: readonly number[];
  /** Whether `ts[i]` and `ts[i + 1]` are joined by the line. */
  joined: readonly boolean[];
};

/**
 * Whether each pair of neighbouring points is joined by the line, one entry
 * per pair (`joined[i]` for `ts[i]` and `ts[i + 1]`). Points up to 2.5 steps
 * apart always are. Past that, the spacing around the pair counts: the wider
 * of the neighbouring spacings, up to `MAX_CADENCE`, so a stretch recorded
 * every 10 or 60 s reads as a sparser line, while a longer stop of the
 * recorder still leaves a gap.
 */
export function joins(ts: readonly number[], step: number): boolean[] {
  const joined: boolean[] = [];
  for (let index = 0; index + 1 < ts.length; index += 1) {
    const before = index > 0 ? ts[index] - ts[index - 1] : 0;
    const after = index + 2 < ts.length ? ts[index + 2] - ts[index + 1] : 0;
    const cadence = Math.min(MAX_CADENCE, Math.max(before, after));
    joined.push(ts[index + 1] - ts[index] <= Math.max(step, cadence) * 2.5);
  }
  return joined;
}

/** Index of the point closest to `at` (points in time order); -1 when there are none. */
export function nearest(ts: readonly number[], at: number): number {
  if (ts.length === 0) return -1;
  let low = 0;
  let high = ts.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ts[mid] < at) low = mid + 1;
    else high = mid;
  }
  return low > 0 && at - ts[low - 1] < ts[low] - at ? low - 1 : low;
}

/**
 * The point a reading at `at` shows: the nearest one when `at` lies on the
 * line between two joined points or within 1.5 steps of a point, none in a gap.
 */
export function pointAt(
  ts: readonly number[],
  joined: readonly boolean[],
  step: number,
  at: number
): number | undefined {
  const index = nearest(ts, at);
  if (index < 0) return undefined;
  if (Math.abs(ts[index] - at) <= step * 1.5) return index;
  // The pair `at` falls between.
  const pair = at < ts[index] ? index - 1 : index;
  return joined[pair] ? index : undefined;
}

/** Builds a view from a query window and the points the backend returned. */
export function buildHistoryView(
  from: number,
  to: number,
  buckets: number,
  points: HistoryPoint[]
): HistoryView {
  const step = Math.max(FRAME_MS, (to - from) / buckets);
  const ts = points.map((point) => point.ts);
  return { from, to, step, points, ts, joined: joins(ts, step) };
}

/** An empty view for a query that has not answered yet. */
export function emptyHistoryView(from: number, to: number, buckets: number): HistoryView {
  return buildHistoryView(from, to, buckets, []);
}

/**
 * Axis ticks on local clock boundaries: every so many minutes past midnight,
 * or midnights for multi-day steps.
 */
export function chartTicks(from: number, to: number, tickMs: number): number[] {
  const out: number[] = [];
  const start = new Date(from);
  const [year, month, day] = [start.getFullYear(), start.getMonth(), start.getDate()];
  for (let index = 0; ; index += 1) {
    const at = (
      tickMs >= DAY
        ? new Date(year, month, day + index)
        : new Date(year, month, day, 0, (index * tickMs) / MINUTE)
    ).getTime();
    if (at > to) break;
    if (at >= from) out.push(at);
  }
  return out;
}
