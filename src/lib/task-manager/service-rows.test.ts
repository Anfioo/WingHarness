import { describe, expect, it } from "vitest";
import type { ServiceInfo, ServiceState, ServiceStartType } from "@/commands";
import {
  buildServiceRows,
  DEFAULT_SERVICE_SORT,
  filterServices,
  isServicePending,
  matchesServiceFilter,
  matchesServiceQuery,
  sortServices,
  type ServiceFilter,
  type ServiceSort,
} from "./service-rows";

function makeService(overrides: Partial<ServiceInfo> & { name: string }): ServiceInfo {
  return {
    displayName: overrides.name,
    description: null,
    state: "running",
    startType: "manual",
    pid: 0,
    path: null,
    account: null,
    canStop: true,
    shared: false,
    ...overrides,
  };
}

const services: ServiceInfo[] = [
  makeService({
    name: "Dnscache",
    displayName: "DNS Client",
    description: "Resolves domain names.",
    state: "running",
    startType: "auto",
    pid: 1200,
  }),
  makeService({
    name: "Spooler",
    displayName: "Print Spooler",
    description: "Loads files to memory for printing.",
    state: "stopped",
    startType: "autoDelayed",
    pid: 0,
  }),
  makeService({
    name: "wuauserv",
    displayName: "Windows Update",
    description: "Enables detection of updates.",
    state: "startPending",
    startType: "manual",
    pid: 2400,
  }),
  makeService({
    name: "WSearch",
    displayName: "Windows Search",
    description: null,
    state: "running",
    startType: "disabled",
    pid: 3600,
  }),
];

describe("service search", () => {
  it("matches display name, key name, description and an exact PID", () => {
    expect(matchesServiceQuery(services[0], "dns client")).toBe(true);
    expect(matchesServiceQuery(services[0], "dnscache")).toBe(true);
    expect(matchesServiceQuery(services[0], "resolves")).toBe(true);
    expect(matchesServiceQuery(services[0], "1200")).toBe(true);
    expect(matchesServiceQuery(services[0], "12")).toBe(false);
  });

  it("is case-insensitive, trimmed and empty for a blank query", () => {
    expect(matchesServiceQuery(services[1], "  PRINT  ")).toBe(true);
    expect(matchesServiceQuery(services[1], "   ")).toBe(true);
  });

  it("ignores a missing description", () => {
    expect(matchesServiceQuery(services[3], "search")).toBe(true);
    expect(matchesServiceQuery(services[3], "anything")).toBe(false);
  });
});

describe("service filter", () => {
  const count = (filter: ServiceFilter) =>
    services.filter((service) => matchesServiceFilter(service, filter)).length;

  it("keeps pending services only in all", () => {
    expect(count("all")).toBe(4);
    expect(count("running")).toBe(2);
    expect(count("stopped")).toBe(1);
  });

  it("recognizes every pending state", () => {
    for (const state of [
      "startPending",
      "stopPending",
      "continuePending",
      "pausePending",
    ] as ServiceState[]) {
      expect(isServicePending(makeService({ name: "x", state }))).toBe(true);
    }
    expect(isServicePending(services[0])).toBe(false);
    expect(isServicePending(makeService({ name: "x", state: "paused" }))).toBe(false);
  });
});

describe("service sorting", () => {
  it("defaults to display name ascending", () => {
    const rows = sortServices(services, DEFAULT_SERVICE_SORT);
    expect(rows.map((service) => service.displayName)).toEqual([
      "DNS Client",
      "Print Spooler",
      "Windows Search",
      "Windows Update",
    ]);
  });

  it("reverses a key and keeps the exact ordering for ties", () => {
    const tied = [
      makeService({ name: "b", displayName: "Same", pid: 2 }),
      makeService({ name: "a", displayName: "Same", pid: 1 }),
      makeService({ name: "c", displayName: "Same", pid: 3 }),
    ];
    const sort: ServiceSort = { key: "display", desc: true };
    expect(sortServices(tied, sort).map((service) => service.name)).toEqual(["b", "a", "c"]);
    expect(sortServices(tied, { key: "display", desc: false })).toEqual(tied);
  });

  it("sorts start types by their Windows order and puts unknown ones last", () => {
    const withUnknown = [
      makeService({ name: "m", displayName: "m", startType: "manual" }),
      makeService({ name: "u", displayName: "u", startType: null }),
      makeService({ name: "d", displayName: "d", startType: "disabled" }),
      makeService({ name: "a", displayName: "a", startType: "autoDelayed" }),
      makeService({ name: "b", displayName: "b", startType: "boot" }),
    ];
    const startTypes: ServiceStartType[] = ["boot", "autoDelayed", "manual", "disabled"];
    expect(
      sortServices(withUnknown, { key: "startType", desc: false }).map(
        (service) => service.startType
      )
    ).toEqual([...startTypes, null]);
  });

  it("sorts PID numerically", () => {
    expect(
      sortServices(services, { key: "pid", desc: false }).map((service) => service.pid)
    ).toEqual([0, 1200, 2400, 3600]);
  });
});

describe("buildServiceRows", () => {
  it("combines query, filter and sort", () => {
    expect(
      buildServiceRows(services, "windows", "running", DEFAULT_SERVICE_SORT).map(
        (service) => service.name
      )
    ).toEqual(["WSearch"]);
    expect(buildServiceRows(services, "", "stopped", DEFAULT_SERVICE_SORT)).toEqual([services[1]]);
    expect(filterServices(services, "nope", "all")).toEqual([]);
  });
});
