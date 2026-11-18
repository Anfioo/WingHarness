// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import { compositionPercent, memoryComposition } from "./chart-memory";

describe("memory composition", () => {
  it("falls back to used and total without the memory lists", () => {
    const composition = memoryComposition({ memTotal: 100, memUsed: 40, memoryLists: null });
    expect(composition).toEqual({
      total: 100,
      used: 40,
      modified: null,
      standby: null,
      free: null,
    });
  });

  it("splits memory into disjoint parts when the lists are present", () => {
    const composition = memoryComposition({
      memTotal: 100,
      memUsed: 70,
      memoryLists: { free: 30, standby: 20, modified: 10 },
    });
    expect(composition.used).toBe(40);
    expect(composition.standby).toBe(20);
    expect(composition.modified).toBe(10);
    expect(composition.free).toBe(30);
    expect(
      composition.used +
        (composition.modified ?? 0) +
        (composition.standby ?? 0) +
        (composition.free ?? 0)
    ).toBe(100);
  });

  it("bounds parts that do not fit the total", () => {
    const composition = memoryComposition({
      memTotal: 100,
      memUsed: 0,
      memoryLists: { free: 200, standby: 50, modified: 50 },
    });
    expect(composition.free).toBe(100);
    expect(composition.standby).toBe(0);
    expect(composition.modified).toBe(0);
    expect(composition.used).toBe(0);
  });

  it("measures a part as a clamped percentage of the total", () => {
    expect(compositionPercent(25, 100)).toBe(25);
    expect(compositionPercent(25, 0)).toBe(0);
    expect(compositionPercent(150, 100)).toBe(100);
    expect(compositionPercent(-5, 100)).toBe(0);
  });
});
