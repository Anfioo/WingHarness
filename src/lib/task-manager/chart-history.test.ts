// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import {
  createHistory,
  historyCombinedPeak,
  historyLatest,
  historyPeak,
  HISTORY_SECONDS,
  pushHistory,
} from "./chart-history";

const KEYS = ["cpu", "mem"];

describe("chart history", () => {
  it("starts with one empty bucket per second", () => {
    const history = createHistory(KEYS);
    expect(history.end).toBe(0);
    expect(history.series.cpu).toHaveLength(HISTORY_SECONDS);
    expect(history.series.cpu?.every((value) => value === null)).toBe(true);
  });

  it("files a sample under the second it was taken", () => {
    const history = pushHistory(createHistory(KEYS), 10_000, { cpu: 10, mem: 100 });
    expect(history.end).toBe(10_000);
    expect(history.series.cpu?.at(-1)).toBe(10);
  });

  it("leaves a bucket empty when the interval skipped a second", () => {
    let history = pushHistory(createHistory(KEYS), 10_000, { cpu: 10 });
    history = pushHistory(history, 13_400, { cpu: 40 });
    const cpu = history.series.cpu ?? [];
    expect(cpu.at(-1)).toBe(40);
    expect(cpu.at(-2)).toBeNull();
    expect(cpu.at(-3)).toBeNull();
    expect(cpu.at(-4)).toBe(10);
  });

  it("overwrites the newest bucket for two samples in the same second", () => {
    let history = pushHistory(createHistory(KEYS), 10_000, { cpu: 10 });
    history = pushHistory(history, 10_400, { cpu: 20 });
    expect(history.series.cpu?.at(-1)).toBe(20);
    expect(history.series.cpu?.at(-2)).toBeNull();
  });

  it("ignores a sample older than the newest bucket", () => {
    const history = pushHistory(createHistory(KEYS), 10_000, { cpu: 10 });
    expect(pushHistory(history, 9_000, { cpu: 5 })).toBe(history);
  });

  it("ignores a frame without a usable timestamp", () => {
    const history = createHistory(KEYS);
    expect(pushHistory(history, Number.NaN, { cpu: 1 })).toBe(history);
  });

  it("drops samples that leave the 60-second window", () => {
    let history = pushHistory(createHistory(KEYS), 1_700_000_000_000, { cpu: 10 });
    history = pushHistory(history, 1_700_000_060_000, { cpu: 20 });
    expect(history.series.cpu?.every((value) => value === null || value === 20)).toBe(true);
  });

  it("clears the window when more than a minute passed between frames", () => {
    let history = pushHistory(createHistory(KEYS), 10_000, { cpu: 10 });
    history = pushHistory(history, 400_000, { cpu: 20 });
    const cpu = history.series.cpu ?? [];
    expect(cpu.slice(0, -1).every((value) => value === null)).toBe(true);
    expect(cpu.at(-1)).toBe(20);
  });

  it("records an unavailable reading as an empty bucket", () => {
    const history = pushHistory(createHistory(KEYS), 10_000, { cpu: Number.NaN, mem: 100 });
    expect(history.series.cpu?.at(-1)).toBeNull();
    expect(history.series.mem?.at(-1)).toBe(100);
  });

  it("starts a series for a device that appears later", () => {
    let history = pushHistory(createHistory(KEYS), 10_000, { cpu: 10, mem: 100 });
    history = pushHistory(history, 11_000, {
      cpu: 20,
      mem: 200,
      "disk.0.active": 42,
    });
    const disk = history.series["disk.0.active"] ?? [];
    expect(disk.at(-1)).toBe(42);
    expect(disk.slice(0, -1).every((value) => value === null)).toBe(true);
    // The series that existed before keep their buckets untouched.
    expect(history.series.cpu?.at(-1)).toBe(20);
  });

  it("reports the peak and the newest reading, ignoring empty buckets", () => {
    let history = pushHistory(createHistory(KEYS), 10_000, { cpu: 10 });
    history = pushHistory(history, 12_000, { cpu: 55 });
    history = pushHistory(history, 13_000, { cpu: 20 });
    expect(historyPeak(history, "cpu")).toBe(55);
    expect(historyLatest(history, "cpu")).toBe(20);
  });

  it("has no peak or latest value for an empty series", () => {
    const history = createHistory(KEYS);
    expect(historyPeak(history, "cpu")).toBeNull();
    expect(historyLatest(history, "cpu")).toBeNull();
    expect(historyPeak(history, "missing")).toBeNull();
  });

  it("sums series per bucket for a combined peak", () => {
    let history = createHistory(["read", "write"]);
    history = pushHistory(history, 10_000, { read: 10, write: 5 });
    history = pushHistory(history, 11_000, { read: null, write: 30 });
    expect(historyCombinedPeak(history, ["read", "write"])).toBe(30);
  });

  it("has no combined peak when a series is unknown", () => {
    const history = createHistory(["read"]);
    expect(historyCombinedPeak(history, ["read", "write"])).toBeNull();
  });
});
