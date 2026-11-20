// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import {
  createHistory,
  historyCombinedPeak,
  historyLatest,
  historyPeak,
  historySpanSeconds,
  HISTORY_SAMPLES,
  pushHistory,
} from "./chart-history";

const KEYS = ["cpu", "mem"];

describe("chart history", () => {
  it("starts with one empty point per sample", () => {
    const history = createHistory(KEYS);
    expect(history.series.cpu).toHaveLength(HISTORY_SAMPLES);
    expect(history.series.cpu?.every((value) => value === null)).toBe(true);
  });

  it("adds exactly one point per push", () => {
    let history = pushHistory(createHistory(KEYS), { cpu: 10, mem: 100 });
    history = pushHistory(history, { cpu: 20 });
    const cpu = history.series.cpu ?? [];
    expect(cpu.at(-1)).toBe(20);
    expect(cpu.at(-2)).toBe(10);
    expect(cpu.slice(0, -2).every((value) => value === null)).toBe(true);
  });

  it("keeps the curve continuous when the interval drifts", () => {
    let history = createHistory(KEYS);
    for (const value of [10, 20, 30, 40, 50]) {
      history = pushHistory(history, { cpu: value });
    }
    expect((history.series.cpu ?? []).slice(-5)).toEqual([10, 20, 30, 40, 50]);
  });

  it("drops the oldest sample once the window is full", () => {
    let history = createHistory(["cpu"]);
    for (let index = 0; index < HISTORY_SAMPLES + 2; index += 1) {
      history = pushHistory(history, { cpu: index });
    }
    const cpu = history.series.cpu ?? [];
    expect(cpu).toHaveLength(HISTORY_SAMPLES);
    expect(cpu.at(-1)).toBe(HISTORY_SAMPLES + 1);
    expect(cpu.at(0)).toBe(2);
    expect(cpu).not.toContain(0);
  });

  it("records an unavailable reading as an empty point", () => {
    const history = pushHistory(createHistory(KEYS), { cpu: Number.NaN, mem: 100 });
    expect(history.series.cpu?.at(-1)).toBeNull();
    expect(history.series.mem?.at(-1)).toBe(100);
  });

  it("starts a series for a device that appears later", () => {
    let history = pushHistory(createHistory(KEYS), { cpu: 10, mem: 100 });
    history = pushHistory(history, { cpu: 20, mem: 200, "disk.0.active": 42 });
    const disk = history.series["disk.0.active"] ?? [];
    expect(disk.at(-1)).toBe(42);
    expect(disk.slice(0, -1).every((value) => value === null)).toBe(true);
    // The series that existed before keep their points.
    expect(history.series.cpu?.at(-1)).toBe(20);
    expect(history.series.cpu?.at(-2)).toBe(10);
  });

  it("does not change the previous window", () => {
    const before = pushHistory(createHistory(KEYS), { cpu: 10 });
    const after = pushHistory(before, { cpu: 20 });
    expect(before.series.cpu?.at(-1)).toBe(10);
    expect(after.series.cpu?.at(-1)).toBe(20);
  });

  it("reports the peak and the newest reading, ignoring empty points", () => {
    let history = pushHistory(createHistory(KEYS), { cpu: 10 });
    history = pushHistory(history, { cpu: 55 });
    history = pushHistory(history, { cpu: 20 });
    expect(historyPeak(history, "cpu")).toBe(55);
    expect(historyLatest(history, "cpu")).toBe(20);
  });

  it("has no peak or latest value for an empty series", () => {
    const history = createHistory(KEYS);
    expect(historyPeak(history, "cpu")).toBeNull();
    expect(historyLatest(history, "cpu")).toBeNull();
    expect(historyPeak(history, "missing")).toBeNull();
  });

  it("sums series per sample for a combined peak", () => {
    let history = createHistory(["read", "write"]);
    history = pushHistory(history, { read: 10, write: 5 });
    history = pushHistory(history, { read: null, write: 30 });
    expect(historyCombinedPeak(history, ["read", "write"])).toBe(30);
  });

  it("has no combined peak when a series is unknown", () => {
    const history = createHistory(["read"]);
    expect(historyCombinedPeak(history, ["read", "write"])).toBeNull();
  });

  it("spans 60 samples times the sampling interval", () => {
    expect(historySpanSeconds(1000)).toBe(60);
    expect(historySpanSeconds(5000)).toBe(300);
    expect(historySpanSeconds(0)).toBe(60);
  });
});
