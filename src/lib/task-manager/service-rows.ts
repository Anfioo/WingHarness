// Pure filtering, search and sorting for the services tab.
//
// The tab keeps no service state of its own beyond these inputs, and every
// function here is side-effect free so it can be tested without the SCM.

import type { ServiceInfo, ServiceStartType } from "@/commands";

export type ServiceFilter = "all" | "running" | "stopped";

export type ServiceSortKey = "display" | "name" | "pid" | "state" | "startType" | "description";

export type ServiceSort = { key: ServiceSortKey; desc: boolean };

export const SERVICE_FILTERS: readonly ServiceFilter[] = ["all", "running", "stopped"];

export const SERVICE_SORT_KEYS: readonly ServiceSortKey[] = [
  "display",
  "name",
  "pid",
  "state",
  "startType",
  "description",
];

export const DEFAULT_SERVICE_SORT: ServiceSort = { key: "display", desc: false };

/** Start types in the order Windows' own Services console lists them. */
const START_TYPE_ORDER: Record<ServiceStartType, number> = {
  boot: 0,
  system: 1,
  auto: 2,
  autoDelayed: 3,
  manual: 4,
  disabled: 5,
};

/** A pending transition is still running through the SCM; actions wait for it. */
export function isServicePending(service: ServiceInfo): boolean {
  return service.state.endsWith("Pending");
}

/** Running and stopped are exact matches, so pending states only appear in `all`. */
export function matchesServiceFilter(service: ServiceInfo, filter: ServiceFilter): boolean {
  switch (filter) {
    case "running":
      return service.state === "running";
    case "stopped":
      return service.state === "stopped";
    case "all":
      return true;
  }
}

/** Display name, key name, description or an exact PID. */
export function matchesServiceQuery(service: ServiceInfo, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    String(service.pid) === needle ||
    service.name.toLowerCase().includes(needle) ||
    service.displayName.toLowerCase().includes(needle) ||
    (service.description?.toLowerCase().includes(needle) ?? false)
  );
}

function sortValue(service: ServiceInfo, key: ServiceSortKey): string | number {
  switch (key) {
    case "display":
      return service.displayName.toLowerCase();
    case "name":
      return service.name.toLowerCase();
    case "pid":
      return service.pid;
    case "state":
      return service.state;
    case "startType":
      // Missing configuration sorts after every known start type.
      return service.startType === null ? 99 : START_TYPE_ORDER[service.startType];
    case "description":
      return service.description?.toLowerCase() ?? "";
  }
}

/** Filter by state and query, keeping the SCM's display-name order. */
export function filterServices(
  services: readonly ServiceInfo[],
  query: string,
  filter: ServiceFilter
): ServiceInfo[] {
  return services.filter(
    (service) => matchesServiceFilter(service, filter) && matchesServiceQuery(service, query)
  );
}

/** Sort a copy; equal values keep the incoming order, never the engine's. */
export function sortServices(services: readonly ServiceInfo[], sort: ServiceSort): ServiceInfo[] {
  const direction = sort.desc ? -1 : 1;
  return services
    .map((service, index) => ({ service, index }))
    .sort((a, b) => {
      const left = sortValue(a.service, sort.key);
      const right = sortValue(b.service, sort.key);
      if (left < right) return -direction;
      if (left > right) return direction;
      return a.index - b.index;
    })
    .map((entry) => entry.service);
}

/** The complete pipeline: filter, then sort. */
export function buildServiceRows(
  services: readonly ServiceInfo[],
  query: string,
  filter: ServiceFilter,
  sort: ServiceSort
): ServiceInfo[] {
  return sortServices(filterServices(services, query, filter), sort);
}
