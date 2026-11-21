import { describe, expect, it } from "vitest";
import type { HistoryPoint } from "@/commands";
import {
  buildHistoryView,
  chartTicks,
  emptyHistoryView,
  FRAME_MS,
  historyRange,
  HISTORY_RANGES,
  joins,
  MAX_CADENCE,
  nearest,
  pointAt,
} from "./history-range";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function point(ts: number): HistoryPoint {
  return {
    ts,
    cpu: 1,
    cpuPeak: 1,
    gpu: 0,
    memUsed: 0,
    memTotal: 0,
    disk: 0,
    net: 0,
    battery: null,
    batteryRate: null,
  };
}

describe("historyRange", () => {
  it("returns the matching range and falls back to the first", () => {
    expect(historyRange("6h").ms).toBe(6 * HOUR);
    expect(historyRange("nope" as never)).toBe(HISTORY_RANGES[0]);
  });

  it("asks for no more than the backend's bucket cap", () => {
    for (const range of HISTORY_RANGES) {
      expect(range.buckets).toBeGreaterThan(0);
      expect(range.buckets).toBeLessThanOrEqual(4096);
    }
  });
});

describe("joins", () => {
  it("joins neighbours up to 2.5 steps apart", () => {
    const step = 10_000;
    expect(joins([0, 10_000, 20_000], step)).toEqual([true, true]);
    expect(joins([0, 25_000], step)).toEqual([true]);
    expect(joins([0, 25_001], step)).toEqual([false]);
  });

  it("allows a sparser cadence around a pair but never past MAX_CADENCE", () => {
    const step = FRAME_MS;
    // Recorded every 60 s: the neighbours widen the allowance for the pair.
    expect(joins([0, 60_000, 120_000], step)).toEqual([true, true]);
    // A stop longer than MAX_CADENCE leaves a gap.
    expect(joins([0, MAX_CADENCE + 1], step)).toEqual([false]);
  });
});

describe("nearest", () => {
  it("finds the closest point and handles an empty list", () => {
    expect(nearest([], 5)).toBe(-1);
    expect(nearest([10, 20, 30], 0)).toBe(0);
    expect(nearest([10, 20, 30], 14)).toBe(0);
    expect(nearest([10, 20, 30], 16)).toBe(1);
    expect(nearest([10, 20, 30], 99)).toBe(2);
  });
});

describe("pointAt", () => {
  const ts = [0, 10_000, 20_000, 120_000];
  const joined = [true, true, false];

  it("reads a point within 1.5 steps of the cursor", () => {
    expect(pointAt(ts, joined, 10_000, 13_000)).toBe(1);
    expect(pointAt(ts, joined, 10_000, 14_000)).toBe(1);
  });

  it("reads a point between two joined neighbours and nothing in a gap", () => {
    // 60 s apart is further than 1.5 steps, but a sparse cadence joins them.
    expect(pointAt([0, 60_000], [true], 5_000, 30_000)).toBe(1);
    expect(pointAt([0, 60_000], [false], 5_000, 30_000)).toBeUndefined();
    expect(pointAt([], [], 10_000, 0)).toBeUndefined();
  });
});

describe("buildHistoryView", () => {
  it("never asks for a step below one frame", () => {
    const view = buildHistoryView(0, 1_000, 100, [point(0)]);
    expect(view.step).toBe(FRAME_MS);
    expect(view.ts).toEqual([0]);
    expect(view.joined).toEqual([]);
  });

  it("makes an empty view from the query window", () => {
    const view = emptyHistoryView(0, HOUR, 360);
    expect(view.points).toEqual([]);
    expect(view.step).toBe(10_000);
  });
});

describe("chartTicks", () => {
  it("puts sub-day ticks on local clock boundaries", () => {
    const from = new Date(2026, 9, 11, 0, 5).getTime();
    const to = new Date(2026, 9, 11, 1, 15).getTime();
    const ticks = chartTicks(from, to, 30 * MINUTE);
    expect(ticks).toEqual([
      new Date(2026, 9, 11, 0, 30).getTime(),
      new Date(2026, 9, 11, 1, 0).getTime(),
    ]);
  });

  it("puts multi-day ticks on midnights", () => {
    const from = new Date(2026, 9, 11, 12).getTime();
    const to = new Date(2026, 9, 13, 12).getTime();
    const ticks = chartTicks(from, to, DAY);
    expect(ticks).toEqual([new Date(2026, 9, 12).getTime(), new Date(2026, 9, 13).getTime()]);
  });
});
