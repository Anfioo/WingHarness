// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The performance tab's rolling window: 60 one-second buckets.
//
// Snapshots arrive at the configured interval, which may be slower than a
// second (or faster after a manual refresh), so a bucket that holds no sample
// stays null. The chart then shows the gap instead of stretching the samples
// around it.

export const HISTORY_SECONDS = 60;
export const BUCKET_MS = 1000;

export type ChartHistory = {
  /** Unix ms of the newest bucket, floored to the second; 0 before the first sample. */
  end: number;
  /** Oldest first, exactly `HISTORY_SECONDS` entries per key. */
  series: Readonly<Record<string, readonly (number | null)[]>>;
};

const EMPTY: readonly (number | null)[] = new Array<number | null>(HISTORY_SECONDS).fill(null);

export function createHistory(keys: readonly string[]): ChartHistory {
  const series: Record<string, (number | null)[]> = {};
  for (const key of keys) series[key] = new Array<number | null>(HISTORY_SECONDS).fill(null);
  return { end: 0, series };
}

/** A missing, `NaN` or infinite reading becomes an empty bucket. */
function sampleValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Adds one snapshot to the window.
 *
 * A sample older than the newest bucket is ignored, and two samples in the
 * same second overwrite that bucket: the frames are a stream of readings, not
 * a queue that may be replayed out of order.
 */
export function pushHistory(
  history: ChartHistory,
  timestamp: number,
  values: Readonly<Record<string, number | null>>
): ChartHistory {
  if (!Number.isFinite(timestamp)) return history;
  const bucket = Math.floor(timestamp / BUCKET_MS) * BUCKET_MS;
  if (history.end > 0 && bucket < history.end) return history;

  const step = history.end === 0 ? HISTORY_SECONDS : Math.round((bucket - history.end) / BUCKET_MS);
  const series: Record<string, (number | null)[]> = {};

  // Keys may appear as devices do (a docked disk, a battery): the union keeps
  // the old series and starts a new one empty.
  const keys = new Set([...Object.keys(history.series), ...Object.keys(values)]);
  for (const key of keys) {
    const previous = history.series[key];
    const next = new Array<number | null>(HISTORY_SECONDS).fill(null);
    if (previous) {
      if (step === 0) {
        next.splice(0, HISTORY_SECONDS, ...previous);
      } else if (step < HISTORY_SECONDS) {
        for (let index = 0; index < HISTORY_SECONDS - step; index += 1) {
          next[index] = previous[index + step] ?? null;
        }
      }
    }
    next[HISTORY_SECONDS - 1] = sampleValue(values[key]);
    series[key] = next;
  }

  return { end: history.end === 0 ? bucket : Math.max(history.end, bucket), series };
}

/** One series, oldest first; an unknown key is all empty buckets. */
export function historyValues(history: ChartHistory, key: string): readonly (number | null)[] {
  return history.series[key] ?? EMPTY;
}

/** The highest reading in the window, or null when every bucket is empty. */
export function historyPeak(history: ChartHistory, key: string): number | null {
  let peak: number | null = null;
  for (const value of historyValues(history, key)) {
    if (value !== null && (peak === null || value > peak)) peak = value;
  }
  return peak;
}

/** The newest reading, or null when every bucket is empty. */
export function historyLatest(history: ChartHistory, key: string): number | null {
  const values = historyValues(history, key);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null) return value;
  }
  return null;
}

/**
 * The peak of the sum of several series, e.g. all disks' read and write
 * rates. Empty buckets contribute nothing; null only when every series is
 * empty for the whole window.
 */
export function historyCombinedPeak(history: ChartHistory, keys: readonly string[]): number | null {
  const lists = keys.map((key) => history.series[key]);
  if (lists.length === 0 || lists.some((list) => list === undefined)) return null;

  let peak: number | null = null;
  for (let index = 0; index < HISTORY_SECONDS; index += 1) {
    let sum = 0;
    let filled = false;
    for (const list of lists) {
      const value = list?.[index];
      if (value !== null && value !== undefined) {
        sum += value;
        filled = true;
      }
    }
    if (filled && (peak === null || sum > peak)) peak = sum;
  }
  return peak;
}
