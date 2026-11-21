import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { HistoryPoint } from "@/commands";
import { createHistoryMetrics, visibleHistoryMetrics } from "./history-metrics";

const t = ((key: string) => key) as unknown as TFunction;

function point(overrides: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    ts: 0,
    cpu: 10,
    cpuPeak: 25,
    gpu: 30,
    memUsed: 4 * 1024 ** 3,
    memTotal: 16 * 1024 ** 3,
    disk: 2 * 1024 ** 2,
    net: 250_000,
    battery: null,
    batteryRate: null,
    ...overrides,
  };
}

describe("createHistoryMetrics", () => {
  const metrics = createHistoryMetrics(t);

  it("exposes the five system charts plus the battery", () => {
    expect(metrics.map((metric) => metric.id)).toEqual([
      "cpu",
      "memory",
      "disk",
      "network",
      "gpu",
      "battery",
    ]);
  });

  it("reads a point and scales each axis", () => {
    const byId = new Map(metrics.map((metric) => [metric.id, metric]));
    const sample = point();
    expect(byId.get("cpu")!.max([sample])).toBe(100);
    expect(byId.get("cpu")!.value(sample)).toBe(10);
    expect(byId.get("cpu")!.peak!(sample)).toBe(25);
    expect(byId.get("memory")!.max([sample])).toBe(16 * 1024 ** 3);
    expect(byId.get("gpu")!.format(sample)).toContain("30");
    expect(byId.get("battery")!.format(sample)).toBe("—");
    expect(byId.get("battery")!.available!(sample)).toBe(false);
  });

  it("never scales the network chart below 1 Mbps", () => {
    const network = metrics.find((metric) => metric.id === "network")!;
    expect(network.max([point({ net: 0 })])).toBeGreaterThanOrEqual(125_000);
  });
});

describe("visibleHistoryMetrics", () => {
  const metrics = createHistoryMetrics(t);

  it("drops the battery chart when no point has a reading", () => {
    expect(visibleHistoryMetrics(metrics, [point(), point()]).map((metric) => metric.id)).toEqual([
      "cpu",
      "memory",
      "disk",
      "network",
      "gpu",
    ]);
  });

  it("keeps the battery chart as soon as one point has a reading", () => {
    expect(
      visibleHistoryMetrics(metrics, [point(), point({ battery: 55 })]).map((metric) => metric.id)
    ).toContain("battery");
  });
});
