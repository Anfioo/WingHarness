// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import type { ProcessRow } from "@/commands";
import {
  aggregateGpu,
  buildProcessRows,
  compareProcessRows,
  countDescendants,
  DEFAULT_PROCESS_SORT,
  MAX_TREE_DEPTH,
  type ProcessTableRow,
} from "./process-sections";

function makeProcess(pid: number, overrides: Partial<ProcessRow> = {}): ProcessRow {
  return {
    pid,
    ppid: 0,
    createTime: pid * 100,
    name: `app-${pid}.exe`,
    path: `C:\\Apps\\app-${pid}.exe`,
    description: null,
    company: null,
    icon: null,
    cpu: 0,
    cpuTime: 0,
    privateWs: 0,
    workingSet: 0,
    commit: 0,
    ioRead: 0,
    ioWrite: 0,
    ioOther: 0,
    diskRead: null,
    diskWrite: null,
    gpu: 0,
    gpuEngine: null,
    gpuDedicated: 0,
    gpuShared: 0,
    netSent: 0,
    netReceived: 0,
    threads: 0,
    handles: 0,
    sessionId: 1,
    basePriority: 8,
    suspended: false,
    efficiency: false,
    appWindow: false,
    windowsProcess: false,
    ...overrides,
  };
}

function keys(rows: ProcessTableRow[]): string[] {
  return rows.map((row) => row.key);
}

describe("buildProcessRows - list view", () => {
  it("filters by name, path and PID prefix", () => {
    const processes = [
      makeProcess(1, { name: "alpha.exe", path: "C:\\A\\alpha.exe" }),
      makeProcess(2, { name: "beta.exe", path: "C:\\B\\beta.exe" }),
      makeProcess(3, { name: "gamma.exe", path: "D:\\Tools\\gamma.exe" }),
    ];
    expect(
      keys(
        buildProcessRows(processes, { view: "list", sort: DEFAULT_PROCESS_SORT, query: "ALPHA" })
      )
    ).toEqual(["1:100"]);
    expect(
      keys(
        buildProcessRows(processes, {
          view: "list",
          sort: DEFAULT_PROCESS_SORT,
          query: "d:\\tools",
        })
      )
    ).toEqual(["3:300"]);
    expect(
      keys(buildProcessRows(processes, { view: "list", sort: DEFAULT_PROCESS_SORT, query: "2" }))
    ).toEqual(["2:200"]);
  });

  it("sorts by CPU descending by default", () => {
    const processes = [
      makeProcess(1, { cpu: 5, name: "alpha.exe" }),
      makeProcess(2, { cpu: 40, name: "beta.exe" }),
      makeProcess(3, { cpu: 20, name: "gamma.exe" }),
    ];
    const rows = buildProcessRows(processes, {
      view: "list",
      sort: DEFAULT_PROCESS_SORT,
      query: "",
    });
    expect(rows.map((row) => row.process.pid)).toEqual([2, 3, 1]);
  });

  it("keeps a stable order for equal values", () => {
    const processes = [
      makeProcess(3, { cpu: 10, name: "zeta.exe" }),
      makeProcess(1, { cpu: 10, name: "alpha.exe" }),
      makeProcess(2, { cpu: 10, name: "beta.exe" }),
    ];
    const rows = buildProcessRows(processes, {
      view: "list",
      sort: DEFAULT_PROCESS_SORT,
      query: "",
    });
    expect(rows.map((row) => row.label)).toEqual(["alpha.exe", "beta.exe", "zeta.exe"]);
  });

  it("puts missing disk readings last in both directions", () => {
    const measured = makeProcess(1, { diskRead: 2048, diskWrite: 0, name: "a.exe" });
    const missing = makeProcess(2, { diskRead: null, diskWrite: null, name: "b.exe" });
    const desc = buildProcessRows([missing, measured], {
      view: "list",
      sort: { key: "diskRead", desc: true },
      query: "",
    });
    const asc = buildProcessRows([missing, measured], {
      view: "list",
      sort: { key: "diskRead", desc: false },
      query: "",
    });
    expect(desc.map((row) => row.process.pid)).toEqual([1, 2]);
    expect(asc.map((row) => row.process.pid)).toEqual([1, 2]);
  });
});

describe("buildProcessRows - tree view", () => {
  it("indents children under their parent", () => {
    const processes = [
      makeProcess(1, { name: "root.exe" }),
      makeProcess(2, { ppid: 1, name: "child.exe" }),
      makeProcess(3, { ppid: 2, name: "grandchild.exe" }),
      makeProcess(4, { name: "other.exe" }),
    ];
    const rows = buildProcessRows(processes, {
      view: "tree",
      sort: { key: "name", desc: false },
      query: "",
    });
    expect(rows.map((row) => [row.label, row.depth])).toEqual([
      ["other.exe", 0],
      ["root.exe", 0],
      ["child.exe", 1],
      ["grandchild.exe", 2],
    ]);
  });

  it("keeps a search match and its ancestors", () => {
    const processes = [
      makeProcess(1, { name: "root.exe" }),
      makeProcess(2, { ppid: 1, name: "child.exe" }),
      makeProcess(3, { ppid: 2, name: "target.exe" }),
      makeProcess(4, { name: "unrelated.exe" }),
    ];
    const rows = buildProcessRows(processes, {
      view: "tree",
      sort: { key: "name", desc: false },
      query: "target",
    });
    expect(rows.map((row) => row.label)).toEqual(["root.exe", "child.exe", "target.exe"]);
  });

  it("collapses a node unless a search is active", () => {
    const processes = [
      makeProcess(1, { name: "root.exe" }),
      makeProcess(2, { ppid: 1, name: "child.exe" }),
    ];
    const collapsed = buildProcessRows(processes, {
      view: "tree",
      sort: { key: "name", desc: false },
      query: "",
      collapsedNodes: new Set(["1:100"]),
    });
    expect(collapsed.map((row) => row.label)).toEqual(["root.exe"]);

    const searching = buildProcessRows(processes, {
      view: "tree",
      sort: { key: "name", desc: false },
      query: "child",
      collapsedNodes: new Set(["1:100"]),
    });
    expect(searching.map((row) => row.label)).toEqual(["root.exe", "child.exe"]);
  });

  it("shows an unreachable parent cycle once and stops", () => {
    const processes = [
      makeProcess(1, { ppid: 2, createTime: 100, name: "first.exe" }),
      makeProcess(2, { ppid: 1, createTime: 100, name: "second.exe" }),
    ];
    const rows = buildProcessRows(processes, {
      view: "tree",
      sort: { key: "name", desc: false },
      query: "",
    });
    expect(rows).toHaveLength(2);
    expect(new Set(keys(rows)).size).toBe(2);
  });

  it("caps the indent depth on a chain that never ends", () => {
    const processes = Array.from({ length: 40 }, (_, index) =>
      makeProcess(index + 1, {
        ppid: index === 0 ? 0 : index,
        createTime: 100,
        name: `chain-${index}.exe`,
      })
    );
    const rows = buildProcessRows(processes, {
      view: "tree",
      sort: { key: "name", desc: true },
      query: "",
    });
    expect(rows).toHaveLength(40);
    expect(Math.max(...rows.map((row) => row.depth))).toBe(MAX_TREE_DEPTH - 1);
  });

  it("treats a parent created after its child as a stale PID reuse", () => {
    const processes = [
      makeProcess(1, { createTime: 200, name: "new-parent.exe" }),
      makeProcess(2, { ppid: 1, createTime: 100, name: "old-child.exe" }),
    ];
    const rows = buildProcessRows(processes, {
      view: "tree",
      sort: { key: "name", desc: false },
      query: "",
    });
    expect(rows.map((row) => [row.label, row.depth])).toEqual([
      ["new-parent.exe", 0],
      ["old-child.exe", 0],
    ]);
  });
});

describe("buildProcessRows - apps view", () => {
  it("aggregates one executable into a group and expands its members", () => {
    const processes = [
      makeProcess(1, { name: "helper.exe", path: "C:\\App\\helper.exe", cpu: 10, privateWs: 100 }),
      makeProcess(2, { name: "helper.exe", path: "C:\\App\\helper.exe", cpu: 5, privateWs: 50 }),
      makeProcess(3, { name: "other.exe", path: "C:\\Other\\other.exe", cpu: 1, privateWs: 10 }),
    ];
    const collapsed = buildProcessRows(processes, {
      view: "apps",
      sort: { key: "cpu", desc: true },
      query: "",
    });
    expect(collapsed.map((row) => [row.kind, row.label, row.count, row.depth])).toEqual([
      ["group", "helper.exe", 2, 0],
      ["process", "other.exe", 1, 0],
    ]);
    expect(collapsed[0].cpu).toBe(15);
    expect(collapsed[0].mem).toBe(150);

    const expanded = buildProcessRows(processes, {
      view: "apps",
      sort: { key: "cpu", desc: true },
      query: "",
      expandedGroups: new Set(["g:image:c:\\app\\helper.exe"]),
    });
    expect(expanded.map((row) => [row.kind, row.label, row.depth])).toEqual([
      ["group", "helper.exe", 0],
      ["process", "helper.exe", 1],
      ["process", "helper.exe", 1],
      ["process", "other.exe", 0],
    ]);
  });

  it("shows a single instance as a process, not a group", () => {
    const rows = buildProcessRows([makeProcess(1, { name: "solo.exe" })], {
      view: "apps",
      sort: DEFAULT_PROCESS_SORT,
      query: "",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("process");
  });

  it("unfolds a group when the search only matches some of its members", () => {
    const processes = [
      makeProcess(1, {
        name: "shared.exe",
        path: "C:\\App\\shared.exe",
        description: null,
        createTime: 100,
      }),
      makeProcess(2, {
        name: "renderer.exe",
        path: "C:\\App\\shared.exe",
        createTime: 200,
      }),
    ];
    const rows = buildProcessRows(processes, {
      view: "apps",
      sort: { key: "name", desc: false },
      query: "renderer",
    });
    expect(rows.map((row) => [row.kind, row.label, row.expanded])).toEqual([
      ["group", "shared.exe", true],
      ["process", "renderer.exe", false],
    ]);
  });

  it("drops a group whose members do not match", () => {
    const processes = [
      makeProcess(1, { name: "first.exe", path: "C:\\A\\first.exe" }),
      makeProcess(2, { name: "second.exe", path: "C:\\B\\second.exe" }),
    ];
    const rows = buildProcessRows(processes, {
      view: "apps",
      sort: DEFAULT_PROCESS_SORT,
      query: "second",
    });
    expect(rows.map((row) => row.label)).toEqual(["second.exe"]);
  });
});

describe("aggregateGpu", () => {
  it("adds contributions to the same physical engine and takes the busiest", () => {
    const first = makeProcess(1, {
      gpuEngines: [
        { id: "gpu0-3d", name: "GPU 0 - 3D", util: 30 },
        { id: "gpu0-copy", name: "GPU 0 - Copy", util: 10 },
      ],
    });
    const second = makeProcess(2, {
      gpuEngines: [
        { id: "gpu0-3d", name: "GPU 0 - 3D", util: 20 },
        { id: "gpu1-3d", name: "GPU 1 - 3D", util: 60 },
      ],
    });
    expect(aggregateGpu([first, second])).toEqual({
      gpu: 60,
      gpuEngine: "GPU 1 - 3D",
    });
  });

  it("never reduces a contribution below its own reading", () => {
    const process = makeProcess(1, { gpu: 40, gpuEngine: "GPU 0 - 3D" });
    expect(aggregateGpu([process]).gpu).toBe(40);
  });

  it("ignores engines at zero", () => {
    const process = makeProcess(1, {
      gpuEngines: [{ id: "gpu0-3d", name: "GPU 0 - 3D", util: 0 }],
    });
    expect(aggregateGpu([process]).gpu).toBe(0);
  });
});

describe("countDescendants", () => {
  it("counts the whole subtree once", () => {
    const processes = [
      makeProcess(1),
      makeProcess(2, { ppid: 1 }),
      makeProcess(3, { ppid: 2 }),
      makeProcess(4, { ppid: 1 }),
      makeProcess(5),
    ];
    expect(countDescendants(processes, processes[0])).toBe(3);
    expect(countDescendants(processes, processes[4])).toBe(0);
  });

  it("stops on a parent cycle", () => {
    const processes = [
      makeProcess(1, { ppid: 2, createTime: 100 }),
      makeProcess(2, { ppid: 1, createTime: 100 }),
    ];
    expect(countDescendants(processes, processes[0])).toBe(1);
  });
});

describe("compareProcessRows", () => {
  it("ignores differences below the printed precision", () => {
    const left: ProcessTableRow = {
      ...buildProcessRows([makeProcess(1, { cpu: 1.01 })], {
        view: "list",
        sort: DEFAULT_PROCESS_SORT,
        query: "",
      })[0],
    };
    const right: ProcessTableRow = {
      ...buildProcessRows([makeProcess(2, { cpu: 1.04 })], {
        view: "list",
        sort: DEFAULT_PROCESS_SORT,
        query: "",
      })[0],
    };
    expect(compareProcessRows(left, right, { key: "cpu", desc: true })).toBeLessThan(0);
  });
});
