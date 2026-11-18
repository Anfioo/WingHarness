// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The process table's rows: the three views, their sorting and their
// filtering. Everything here is pure so the table component can memoize on the
// row array and the tests can cover the tree and group edge cases.

import type { GpuEngineUsage, ProcessRow } from "@/commands";
import { applicationKey, procKey, processLabel } from "./process-identity";
import { createProcessMatcher } from "./process-search";

export type ProcessView = "apps" | "tree" | "list";

export type ProcessSortKey = "name" | "pid" | "cpu" | "mem" | "disk" | "net" | "gpu";

export type ProcessSort = { key: ProcessSortKey; desc: boolean };

/** Like Windows Task Manager: the busiest process first. */
export const DEFAULT_PROCESS_SORT: ProcessSort = { key: "cpu", desc: true };

/** Sorting a column for the first time starts in this direction. */
export const SORT_DESC_FIRST: Record<ProcessSortKey, boolean> = {
  name: false,
  pid: false,
  cpu: true,
  mem: true,
  disk: true,
  net: true,
  gpu: true,
};

/**
 * A malicious or corrupt snapshot could contain a parent chain that never
 * ends; the tree stops indenting and expanding at this depth.
 */
export const MAX_TREE_DEPTH = 32;

export const SORT_KEYS: readonly ProcessSortKey[] = [
  "cpu",
  "mem",
  "disk",
  "net",
  "gpu",
  "pid",
  "name",
];

/** One rendered line: a process, or an application group above its members. */
export type ProcessTableRow = {
  /** `pid:createTime` for a process; the application key for a group. */
  key: string;
  kind: "process" | "group";
  depth: number;
  /** The process itself, or a group's earliest-started member. */
  process: ProcessRow;
  label: string;
  detail: string | null;
  /** Members in a group; 1 for a process. */
  count: number;
  expandable: boolean;
  expanded: boolean;
  cpu: number;
  mem: number;
  diskRead: number | null;
  diskWrite: number | null;
  netSent: number;
  netReceived: number;
  gpu: number;
  gpuEngine: string | null;
  suspended: boolean;
  /** Processes in efficiency mode: 0 or 1 for a process, any number for a group. */
  efficiency: number;
  sessionId: number;
  user: string | null;
};

export type ProcessBuildOptions = {
  view: ProcessView;
  sort: ProcessSort;
  query: string;
  /** Expanded application groups (collapsed by default). */
  expandedGroups?: ReadonlySet<string>;
  /** Collapsed tree nodes (expanded by default). */
  collapsedNodes?: ReadonlySet<string>;
};

type Metrics = Pick<
  ProcessTableRow,
  | "cpu"
  | "mem"
  | "diskRead"
  | "diskWrite"
  | "netSent"
  | "netReceived"
  | "gpu"
  | "gpuEngine"
  | "suspended"
  | "efficiency"
>;

/**
 * The `user` column is not part of the frozen ProcessRow yet. Read it when a
 * producer adds it and fall back to "unknown" until then.
 */
function readUser(process: ProcessRow): string | null {
  const user = (process as ProcessRow & { user?: unknown }).user;
  return typeof user === "string" && user.length > 0 ? user : null;
}

function readGpuEngines(process: ProcessRow): GpuEngineUsage[] {
  if (process.gpuEngines?.length) return process.gpuEngines;
  if (process.gpuEngine) {
    return [{ id: `label:${process.gpuEngine}`, name: process.gpuEngine, util: process.gpu }];
  }
  return [];
}

/**
 * Independent GPU engines run concurrently: add contributions to the same
 * physical engine first, then take the busiest one. Already-reduced
 * percentages are never summed across engines.
 */
export function aggregateGpu(members: readonly ProcessRow[]): {
  gpu: number;
  gpuEngine: string | null;
} {
  const engines = new Map<string, GpuEngineUsage>();
  let unknown = 0;
  for (const process of members) {
    const usages = readGpuEngines(process);
    if (usages.length === 0 && Number.isFinite(process.gpu)) {
      unknown = Math.max(unknown, process.gpu);
    }
    for (const usage of usages) {
      if (!Number.isFinite(usage.util) || usage.util <= 0) continue;
      const previous = engines.get(usage.id);
      engines.set(usage.id, {
        ...usage,
        util: Math.min(100, (previous?.util ?? 0) + usage.util),
      });
    }
  }

  let gpu = Math.min(100, Math.max(0, unknown));
  let gpuEngine: string | null = null;
  for (const engine of engines.values()) {
    if (engine.util > gpu) {
      gpu = engine.util;
      gpuEngine = engine.name;
    }
  }
  return { gpu, gpuEngine };
}

function sumDisk(
  members: readonly ProcessRow[],
  pick: (process: ProcessRow) => number | null
): number | null {
  let total: number | null = null;
  for (const process of members) {
    const value = pick(process);
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
}

function aggregateMembers(members: readonly ProcessRow[]): Metrics {
  let cpu = 0;
  let mem = 0;
  let netSent = 0;
  let netReceived = 0;
  for (const process of members) {
    cpu += process.cpu;
    mem += process.privateWs;
    netSent += process.netSent;
    netReceived += process.netReceived;
  }
  const gpu = aggregateGpu(members);
  return {
    cpu,
    mem,
    diskRead: sumDisk(members, (process) => process.diskRead),
    diskWrite: sumDisk(members, (process) => process.diskWrite),
    netSent,
    netReceived,
    gpu: gpu.gpu,
    gpuEngine: gpu.gpuEngine,
    suspended: members.every((process) => process.suspended),
    efficiency: members.filter((process) => process.efficiency).length,
  };
}

function toProcessRow(
  process: ProcessRow,
  depth: number,
  label: string,
  detail: string | null
): ProcessTableRow {
  return {
    key: procKey(process),
    kind: "process",
    depth,
    process,
    label,
    detail,
    count: 1,
    expandable: false,
    expanded: false,
    cpu: process.cpu,
    mem: process.privateWs,
    diskRead: process.diskRead,
    diskWrite: process.diskWrite,
    netSent: process.netSent,
    netReceived: process.netReceived,
    gpu: process.gpu,
    gpuEngine: process.gpuEngine,
    suspended: process.suspended,
    efficiency: process.efficiency ? 1 : 0,
    sessionId: process.sessionId,
    user: readUser(process),
  };
}

function processDetail(process: ProcessRow, label: string): string | null {
  const detail = process.webView ? process.name : process.description;
  return detail && detail !== label ? detail : null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function byLabel(left: ProcessTableRow, right: ProcessTableRow): number {
  return collator.compare(left.label, right.label) || left.process.pid - right.process.pid;
}

function diskTotal(row: ProcessTableRow): number | null {
  if (row.diskRead === null && row.diskWrite === null) return null;
  return (row.diskRead ?? 0) + (row.diskWrite ?? 0);
}

/**
 * Missing disk readings sort after measured ones in either direction. Values
 * are compared at the precision the table prints, so rows do not trade places
 * on every sample.
 */
function compareDisk(left: number | null, right: number | null, desc: boolean): number {
  if (left === null || right === null) {
    return left === null ? (right === null ? 0 : 1) : -1;
  }
  return (desc ? -1 : 1) * (Math.round(left / 1024) - Math.round(right / 1024));
}

function metric(row: ProcessTableRow, key: ProcessSortKey): number {
  switch (key) {
    case "cpu":
      return Math.round(row.cpu * 10);
    case "mem":
      return Math.round(row.mem / 104_858);
    case "net":
      return Math.round((row.netSent + row.netReceived) / 1024);
    case "gpu":
      return Math.round(row.gpu * 10);
    default:
      return 0;
  }
}

export function compareProcessRows(
  left: ProcessTableRow,
  right: ProcessTableRow,
  sort: ProcessSort
): number {
  const direction = sort.desc ? -1 : 1;
  switch (sort.key) {
    case "name":
      return direction * byLabel(left, right);
    case "pid":
      return direction * (left.process.pid - right.process.pid || byLabel(left, right));
    case "disk": {
      const compared = compareDisk(diskTotal(left), diskTotal(right), sort.desc);
      return compared !== 0 ? compared : byLabel(left, right);
    }
    default:
      return direction * (metric(left, sort.key) - metric(right, sort.key)) || byLabel(left, right);
  }
}

/** True when `parent` is a plausible parent: it exists, differs and is older. */
function validParent(
  byPid: ReadonlyMap<number, ProcessRow>,
  process: ProcessRow
): ProcessRow | null {
  const parent = byPid.get(process.ppid);
  if (!parent || parent.pid === process.pid) return null;
  return parent.createTime <= process.createTime ? parent : null;
}

/**
 * Every process a search keeps: the matches and all of their ancestors, so a
 * match stays in its tree context. Guards against a parent chain that loops.
 */
function visibleKeys(
  processes: readonly ProcessRow[],
  byPid: ReadonlyMap<number, ProcessRow>,
  matcher: (process: ProcessRow) => boolean
): Set<string> {
  const visible = new Set<string>();
  for (const process of processes) {
    if (!matcher(process)) continue;
    let current: ProcessRow | null = process;
    const seen = new Set<string>();
    while (current) {
      const key = procKey(current);
      if (visible.has(key) || seen.has(key)) break;
      seen.add(key);
      visible.add(key);
      current = validParent(byPid, current);
    }
  }
  return visible;
}

function buildListRows(
  processes: readonly ProcessRow[],
  matcher: ((process: ProcessRow) => boolean) | null,
  sort: ProcessSort
): ProcessTableRow[] {
  return processes
    .filter((process) => !matcher || matcher(process))
    .map((process) => {
      const label = processLabel(process);
      return toProcessRow(process, 0, label, processDetail(process, label));
    })
    .sort((left, right) => compareProcessRows(left, right, sort));
}

function buildTreeRows(
  processes: readonly ProcessRow[],
  matcher: ((process: ProcessRow) => boolean) | null,
  sort: ProcessSort,
  collapsed: ReadonlySet<string>
): ProcessTableRow[] {
  const byPid = new Map<number, ProcessRow>();
  for (const process of processes) {
    if (!byPid.has(process.pid)) byPid.set(process.pid, process);
  }
  const visible = matcher ? visibleKeys(processes, byPid, matcher) : null;

  const children = new Map<string, ProcessRow[]>();
  const roots: ProcessRow[] = [];
  for (const process of processes) {
    const key = procKey(process);
    if (visible && !visible.has(key)) continue;
    const parent = validParent(byPid, process);
    if (parent && (!visible || visible.has(procKey(parent)))) {
      const key = procKey(parent);
      const list = children.get(key);
      if (list) list.push(process);
      else children.set(key, [process]);
    } else {
      roots.push(process);
    }
  }

  const rows: ProcessTableRow[] = [];
  const seen = new Set<string>();
  // Depth-first, with an explicit stack: a corrupt parent chain must neither
  // overflow the call stack nor indent past MAX_TREE_DEPTH.
  const stack: { level: ProcessTableRow[]; index: number; depth: number }[] = [];
  const pushLevel = (nodes: readonly ProcessRow[], depth: number) => {
    const level = nodes
      .map((process) => {
        const label = processLabel(process);
        const row = toProcessRow(process, depth, label, processDetail(process, label));
        row.expandable = (children.get(row.key)?.length ?? 0) > 0;
        // A search shows every match in context, folding included.
        row.expanded = row.expandable && (matcher !== null || !collapsed.has(row.key));
        return row;
      })
      .sort((left, right) => compareProcessRows(left, right, sort));
    stack.push({ level, index: 0, depth });
  };

  const drain = () => {
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.index >= frame.level.length) {
        stack.pop();
        continue;
      }
      const row = frame.level[frame.index];
      frame.index += 1;
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      rows.push(row);
      if (!row.expanded) continue;
      const descendants = children.get(row.key);
      if (descendants?.length) {
        pushLevel(descendants, Math.min(frame.depth + 1, MAX_TREE_DEPTH - 1));
      }
    }
  };

  pushLevel(roots, 0);
  drain();

  // A parent chain that loops never reaches a root, so those processes would
  // otherwise disappear; show each unvisited one as a root. A process merely
  // hidden under a collapsed ancestor does reach a root, so it stays hidden.
  const reachesRoot = (process: ProcessRow): boolean => {
    let current: ProcessRow | null = process;
    const chain = new Set<string>();
    while (current) {
      const key = procKey(current);
      if (chain.has(key)) return false;
      chain.add(key);
      current = validParent(byPid, current);
    }
    return true;
  };

  for (const process of processes) {
    const key = procKey(process);
    if (seen.has(key) || (visible && !visible.has(key)) || reachesRoot(process)) continue;
    pushLevel([process], 0);
    drain();
  }

  return rows;
}

function buildApplicationRows(
  processes: readonly ProcessRow[],
  matcher: ((process: ProcessRow) => boolean) | null,
  query: string,
  sort: ProcessSort,
  expanded: ReadonlySet<string>
): ProcessTableRow[] {
  const groups = new Map<string, ProcessRow[]>();
  for (const process of processes) {
    const key = applicationKey(process);
    const members = groups.get(key);
    if (members) members.push(process);
    else groups.set(key, [process]);
  }

  const needle = query.trim().toLowerCase();
  const entries: { row: ProcessTableRow; members: ProcessRow[] }[] = [];

  for (const [key, members] of groups) {
    const representative = members.reduce((earliest, process) =>
      process.createTime < earliest.createTime ? process : earliest
    );
    const label = processLabel(representative);
    const labelMatches =
      !matcher || matcher(representative) || label.toLowerCase().includes(needle);
    const shown = labelMatches ? members : members.filter((process) => matcher?.(process));
    if (shown.length === 0) continue;

    if (members.length === 1) {
      entries.push({
        row: toProcessRow(representative, 0, label, processDetail(representative, label)),
        members: [],
      });
      continue;
    }

    const metrics = aggregateMembers(members);
    const description =
      representative.description && representative.description !== label
        ? representative.description
        : null;
    const row: ProcessTableRow = {
      key,
      kind: "group",
      depth: 0,
      process: representative,
      label,
      detail: description,
      count: members.length,
      expandable: true,
      // A search that only matched members unfolds the group to show them.
      expanded: expanded.has(key) || shown.length < members.length,
      ...metrics,
      sessionId: representative.sessionId,
      user: readUser(representative),
    };
    entries.push({ row, members: shown });
  }

  entries.sort((left, right) => compareProcessRows(left.row, right.row, sort));

  const rows: ProcessTableRow[] = [];
  for (const { row, members } of entries) {
    rows.push(row);
    if (row.kind !== "group" || !row.expanded) continue;
    rows.push(
      ...members
        .map((process) => {
          const label = process.name;
          return toProcessRow(process, 1, label, processDetail(process, label));
        })
        .sort((left, right) => compareProcessRows(left, right, sort))
    );
  }
  return rows;
}

/** Builds the visible rows for the current view, search and sort. */
export function buildProcessRows(
  processes: readonly ProcessRow[],
  options: ProcessBuildOptions
): ProcessTableRow[] {
  const matcher = createProcessMatcher(options.query);
  switch (options.view) {
    case "tree":
      return buildTreeRows(processes, matcher, options.sort, options.collapsedNodes ?? new Set());
    case "apps":
      return buildApplicationRows(
        processes,
        matcher,
        options.query,
        options.sort,
        options.expandedGroups ?? new Set()
      );
    default:
      return buildListRows(processes, matcher, options.sort);
  }
}

/**
 * How many descendants ending a process tree would take down with it. Used by
 * the confirmation, so the number is shown before anything is terminated.
 */
export function countDescendants(
  processes: readonly ProcessRow[],
  root: Pick<ProcessRow, "pid" | "createTime">
): number {
  const byPid = new Map<number, ProcessRow>();
  for (const process of processes) {
    if (!byPid.has(process.pid)) byPid.set(process.pid, process);
  }
  const children = new Map<string, ProcessRow[]>();
  for (const process of processes) {
    const parent = validParent(byPid, process);
    if (!parent) continue;
    const key = procKey(parent);
    const list = children.get(key);
    if (list) list.push(process);
    else children.set(key, [process]);
  }

  const seen = new Set<string>([procKey(root)]);
  const queue = [...(children.get(procKey(root)) ?? [])];
  let count = 0;
  while (queue.length > 0) {
    const process = queue.shift();
    if (!process) break;
    const key = procKey(process);
    if (seen.has(key)) continue;
    seen.add(key);
    count += 1;
    queue.push(...(children.get(key) ?? []));
  }
  return count;
}
