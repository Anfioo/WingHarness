// The detail panel's rolling window: one 60-sample history per process
// instance, keyed by PID plus creation time so a reused PID starts a new line.
//
// One point is pushed per snapshot, the same cadence as the performance tab's
// window, so the curve joins consecutive readings whatever the interval. Only
// processes present in the newest snapshot keep a history: a process that
// exits (or a machine that reports more than the limit) is dropped, which also
// bounds the map.

import type { ProcessRow } from "@/commands";

export const PROCESS_HISTORY_SAMPLES = 60;
/** More running processes than this are not charted; the table still lists them. */
export const PROCESS_HISTORY_LIMIT = 500;

export type ProcessSample = {
  /** Percent of total machine capacity. */
  cpu: number | null;
  privateWs: number | null;
  diskRead: number | null;
  diskWrite: number | null;
  netSent: number | null;
  netReceived: number | null;
  gpu: number | null;
};

export type ProcessHistory = ReadonlyMap<string, readonly (ProcessSample | null)[]>;

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The identity of one process instance, as the table and the panel spell it. */
export function processHistoryKey(process: Pick<ProcessRow, "pid" | "createTime">): string {
  return `${process.pid}:${process.createTime}`;
}

function sampleOf(process: ProcessRow): ProcessSample {
  return {
    cpu: finite(process.cpu),
    privateWs: finite(process.privateWs),
    diskRead: finite(process.diskRead),
    diskWrite: finite(process.diskWrite),
    netSent: finite(process.netSent),
    netReceived: finite(process.netReceived),
    gpu: finite(process.gpu),
  };
}

function emptySamples(): (ProcessSample | null)[] {
  return new Array<ProcessSample | null>(PROCESS_HISTORY_SAMPLES).fill(null);
}

const EMPTY: readonly (ProcessSample | null)[] = emptySamples();

/**
 * Adds one sample per running process and drops everything else. The caller
 * replaces its state with the result; unchanged processes get a new array, not
 * a mutated one, so React sees the change.
 */
export function pushProcessHistory(
  history: ProcessHistory,
  processes: readonly ProcessRow[]
): ProcessHistory {
  const next = new Map<string, readonly (ProcessSample | null)[]>();
  for (const process of processes) {
    if (next.size >= PROCESS_HISTORY_LIMIT) break;
    const key = processHistoryKey(process);
    if (next.has(key)) continue;
    const samples = (history.get(key) ?? EMPTY).slice(1);
    samples.push(sampleOf(process));
    next.set(key, samples);
  }
  return next;
}

const NO_SAMPLES: readonly (ProcessSample | null)[] = [];

/** One process's window, oldest first; an unknown key is empty. */
export function processSamples(
  history: ProcessHistory,
  key: string
): readonly (ProcessSample | null)[] {
  return history.get(key) ?? NO_SAMPLES;
}

/** The newest non-null reading of one field, or null when the window is empty. */
export function latestSample(
  samples: readonly (ProcessSample | null)[],
  pick: (sample: ProcessSample) => number | null
): number | null {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index];
    if (sample === null) continue;
    const value = pick(sample);
    if (value !== null) return value;
  }
  return null;
}

/** The highest reading of one field in the window, or null when every point is empty. */
export function samplePeak(
  samples: readonly (ProcessSample | null)[],
  pick: (sample: ProcessSample) => number | null
): number | null {
  let peak: number | null = null;
  for (const sample of samples) {
    if (sample === null) continue;
    const value = pick(sample);
    if (value !== null && (peak === null || value > peak)) peak = value;
  }
  return peak;
}
