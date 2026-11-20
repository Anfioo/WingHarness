// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import type { Snapshot } from "@/commands";
import { snapshotMetrics } from "./chart-metrics";

function makeSnapshot(): Snapshot {
  return {
    seq: 1,
    timestamp: 0,
    system: {
      cpu: 10,
      cpuKernel: 3,
      cores: [10, 20],
      logicalCpus: 2,
      memTotal: 1000,
      memUsed: 400,
      memAvailable: 600,
      commitUsed: 0,
      commitLimit: 0,
      cached: 0,
      memoryLists: null,
      kernelPaged: 0,
      kernelNonpaged: 0,
      processCount: 0,
      threadCount: 0,
      handleCount: 0,
      uptimeMs: 0,
      ioRead: 0,
      ioWrite: 0,
      ioOther: 0,
    },
    hardware: {
      cpu: {
        name: "",
        vendor: "",
        family: 0,
        model: 0,
        stepping: 0,
        instructions: [],
        microcode: null,
        baseMhz: 0,
        baseSource: null,
        sockets: 1,
        cores: 2,
        performanceCores: 0,
        efficiencyCores: 0,
        logical: 2,
        l1: 0,
        l2: 0,
        l3: 0,
        virtualization: false,
        threads: [
          { group: 0, processor: 0, core: 0, efficient: false },
          { group: 0, processor: 1, core: 1, efficient: true },
        ],
      },
      cpuMhz: null,
      coreMhz: [],
      memory: {
        installed: 0,
        speed: null,
        slotsUsed: 0,
        slotsTotal: 0,
        formFactor: null,
        kind: null,
      },
      disks: [
        {
          info: {
            index: 0,
            model: "",
            size: 0,
            bus: "nvme",
            ssd: true,
            removable: false,
            volumes: [],
          },
          active: 12,
          read: 100,
          write: 50,
          responseMs: 0,
          temperature: null,
          temperatureWarning: null,
        },
      ],
      nics: [
        {
          info: {
            id: "nic-1",
            name: "",
            description: "",
            kind: "ethernet",
            linkSpeed: 0,
            mac: null,
            ipv4: [],
            ipv6: [],
          },
          rx: 10,
          tx: 5,
        },
      ],
      gpus: [
        {
          info: {
            id: "gpu-1",
            name: "",
            dedicatedTotal: 0,
            sharedTotal: 0,
            engines: ["3D"],
            temperatureMax: null,
          },
          util: 30,
          utilSource: "windows",
          engines: [30],
          dedicatedUsed: 100,
          sharedUsed: 0,
          temperature: null,
          fanRpm: null,
          power: null,
          boardPower: null,
          boardPowerLimit: null,
          powerSource: null,
          clockMhz: null,
          clockMaxMhz: null,
          voltageMv: null,
          memoryClockMhz: null,
        },
      ],
      batteries: [
        {
          info: {
            id: "bat-1",
            name: "",
            manufacturer: "",
            serial: "",
            chemistry: "",
            designedCapacity: null,
            fullCapacity: null,
            cycleCount: null,
            manufactured: null,
          },
          percent: 80,
          capacity: null,
          rate: null,
          voltage: null,
          state: "idle",
          pluggedIn: true,
          critical: false,
          remaining: null,
          temperature: null,
        },
      ],
    },
    processes: [],
    processNetwork: false,
  };
}

describe("snapshot metrics", () => {
  it("records the machine-wide totals used by the device list", () => {
    const metrics = snapshotMetrics(makeSnapshot());
    expect(metrics.cpu).toBe(10);
    expect(metrics.cpuKernel).toBe(3);
    expect(metrics.mem).toBe(400);
    expect(metrics.diskRead).toBe(100);
    expect(metrics.diskWrite).toBe(50);
    expect(metrics.netRx).toBe(10);
    expect(metrics.netTx).toBe(5);
    expect(metrics.gpu).toBe(30);
  });

  it("records each device under its stable key", () => {
    const metrics = snapshotMetrics(makeSnapshot());
    expect(metrics["core.0.0"]).toBe(10);
    expect(metrics["core.0.1"]).toBe(20);
    expect(metrics["disk.0.active"]).toBe(12);
    expect(metrics["disk.0.read"]).toBe(100);
    expect(metrics["nic.nic-1.rx"]).toBe(10);
    expect(metrics["gpu.gpu-1.util"]).toBe(30);
    expect(metrics["gpu.gpu-1.e0"]).toBe(30);
    expect(metrics["bat.bat-1.pct"]).toBe(80);
  });
});
