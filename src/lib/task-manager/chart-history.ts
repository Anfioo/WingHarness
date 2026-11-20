// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The performance tab's rolling window: the newest 60 samples, oldest first.
//
// Snapshots arrive at the configured interval, which may be slower than a
// second, so the window holds one point per sample rather than one per wall
// clock second: consecutive readings always join, and the span the chart
// covers follows the sampling interval instead of the clock.

export const HISTORY_SAMPLES = 60;

export type ChartHistory = {
  /** Oldest first, exactly `HISTORY_SAMPLES` entries per key. */
  series: Readonly<Record<string, readonly (number | null)[]>>;
};

function emptySamples(): (number | null)[] {
  return new Array<number | null>(HISTORY_SAMPLES).fill(null);
}

export function createHistory(keys: readonly string[]): ChartHistory {
  const series: Record<string, (number | null)[]> = {};
  for (const key of keys) series[key] = emptySamples();
  return { series };
}

/** A missing, `NaN` or infinite reading becomes an empty point. */
function sampleValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Adds one snapshot to the window: the oldest sample leaves and this one joins
 * at the end. Every call adds exactly one point, so the curve stays continuous
 * whatever the interval between frames.
 */
export function pushHistory(
  history: ChartHistory,
  values: Readonly<Record<string, number | null>>
): ChartHistory {
  // Keys may appear as devices do (a docked disk, a battery): the union keeps
  // the old series and starts a new one with empty points.
  const keys = new Set([...Object.keys(history.series), ...Object.keys(values)]);
  const series: Record<string, (number | null)[]> = {};
  for (const key of keys) {
    const next = (history.series[key] ?? emptySamples()).slice(1);
    next.push(sampleValue(values[key]));
    series[key] = next;
  }
  return { series };
}

/** How many seconds the window spans at a given sampling interval. */
export function historySpanSeconds(intervalMs: number): number {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1000;
  return Math.max(1, Math.round((HISTORY_SAMPLES * interval) / 1000));
}

const EMPTY: readonly (number | null)[] = emptySamples();

/** One series, oldest first; an unknown key is all empty points. */
export function historyValues(history: ChartHistory, key: string): readonly (number | null)[] {
  return history.series[key] ?? EMPTY;
}

/** The highest reading in the window, or null when every point is empty. */
export function historyPeak(history: ChartHistory, key: string): number | null {
  let peak: number | null = null;
  for (const value of historyValues(history, key)) {
    if (value !== null && (peak === null || value > peak)) peak = value;
  }
  return peak;
}

/** The newest reading, or null when every point is empty. */
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
 * rates. Empty points contribute nothing; null only when every series is
 * empty for the whole window.
 */
export function historyCombinedPeak(history: ChartHistory, keys: readonly string[]): number | null {
  const lists = keys.map((key) => history.series[key]);
  if (lists.length === 0 || lists.some((list) => list === undefined)) return null;

  let peak: number | null = null;
  for (let index = 0; index < HISTORY_SAMPLES; index += 1) {
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
