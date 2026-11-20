import { describe, expect, it } from "vitest";
import type { ProcessRow } from "@/commands";
import {
  latestSample,
  PROCESS_HISTORY_LIMIT,
  PROCESS_HISTORY_SAMPLES,
  processHistoryKey,
  processSamples,
  pushProcessHistory,
  samplePeak,
} from "./process-history";

function process(pid: number, cpu: number, createTime = 1000): ProcessRow {
  return {
    pid,
    createTime,
    cpu,
    privateWs: cpu * 1024,
    diskRead: 10,
    diskWrite: 20,
    netSent: 30,
    netReceived: 40,
    gpu: 50,
  } as ProcessRow;
}

describe("process history", () => {
  it("starts with one empty point per slot and appends one sample", () => {
    const history = pushProcessHistory(new Map(), [process(1, 10)]);
    const samples = processSamples(history, processHistoryKey(process(1, 10)));
    expect(samples).toHaveLength(PROCESS_HISTORY_SAMPLES);
    expect(samples[0]).toBeNull();
    expect(samples.at(-1)?.cpu).toBe(10);
    expect(samples.at(-1)?.privateWs).toBe(10 * 1024);
  });

  it("keeps one continuous window per process instance", () => {
    let history = pushProcessHistory(new Map(), [process(1, 10)]);
    history = pushProcessHistory(history, [process(1, 20)]);
    const samples = processSamples(history, processHistoryKey(process(1, 20)));
    expect(samples.at(-2)?.cpu).toBe(10);
    expect(samples.at(-1)?.cpu).toBe(20);
  });

  it("drops a process that is no longer in the snapshot", () => {
    const history = pushProcessHistory(new Map(), [process(1, 10), process(2, 20)]);
    const next = pushProcessHistory(history, [process(2, 25)]);
    expect(next.has(processHistoryKey(process(1, 0)))).toBe(false);
    expect(processSamples(next, processHistoryKey(process(2, 0))).at(-1)?.cpu).toBe(25);
  });

  it("treats a reused PID as a new instance", () => {
    const history = pushProcessHistory(new Map(), [process(1, 10, 1000)]);
    const next = pushProcessHistory(history, [process(1, 90, 2000)]);
    expect(next.has("1:1000")).toBe(false);
    const samples = processSamples(next, "1:2000");
    expect(samples.at(-1)?.cpu).toBe(90);
    expect(samples.at(-2)).toBeNull();
  });

  it("bounds the map at the process limit", () => {
    const many = Array.from({ length: PROCESS_HISTORY_LIMIT + 20 }, (_, index) =>
      process(index + 1, index)
    );
    const history = pushProcessHistory(new Map(), many);
    expect(history.size).toBe(PROCESS_HISTORY_LIMIT);
    expect(history.has(processHistoryKey(process(1, 0)))).toBe(true);
    expect(history.has(processHistoryKey(process(PROCESS_HISTORY_LIMIT + 20, 0)))).toBe(false);
  });

  it("reports the latest and peak readings, ignoring empty points", () => {
    let history = pushProcessHistory(new Map(), [process(1, 10)]);
    history = pushProcessHistory(history, [process(1, 40)]);
    const samples = processSamples(history, processHistoryKey(process(1, 0)));
    expect(latestSample(samples, (sample) => sample.cpu)).toBe(40);
    expect(samplePeak(samples, (sample) => sample.cpu)).toBe(40);
    expect(latestSample([], (sample) => sample.cpu)).toBeNull();
  });
});
