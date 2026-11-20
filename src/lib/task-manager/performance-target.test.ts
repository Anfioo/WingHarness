import { describe, expect, it } from "vitest";
import {
  performanceDeviceKey,
  requestPerformanceTarget,
  subscribePerformanceTarget,
  takePerformanceTarget,
} from "./performance-target";

describe("performance target", () => {
  it("maps the vitals keys to the performance tab's device keys", () => {
    expect(performanceDeviceKey("cpu")).toBe("cpu");
    expect(performanceDeviceKey("memory")).toBe("memory");
    expect(performanceDeviceKey("disk:0")).toBe("disk.0");
    expect(performanceDeviceKey("nic:eth-1")).toBe("nic.eth-1");
    expect(performanceDeviceKey("gpu:0")).toBe("gpu.0");
    expect(performanceDeviceKey("bat:1")).toBe("bat.1");
  });

  it("keeps a request until the tab mounts when nobody is listening", () => {
    requestPerformanceTarget("gpu:0");
    expect(takePerformanceTarget()).toBe("gpu:0");
    expect(takePerformanceTarget()).toBeNull();
  });

  it("delivers to a mounted listener and leaves nothing behind", () => {
    const seen: string[] = [];
    const stop = subscribePerformanceTarget((target) => seen.push(target));
    requestPerformanceTarget("disk:2");
    stop();
    expect(seen).toEqual(["disk:2"]);
    expect(takePerformanceTarget()).toBeNull();
  });
});
