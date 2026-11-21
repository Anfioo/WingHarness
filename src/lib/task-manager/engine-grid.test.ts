// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// How the GPU view lays out its engine charts.

import { describe, expect, it } from "vitest";
import { evenRest, fills, type GridPlan, planGrid, samePlan } from "./engine-grid";

const CELL = { width: 150, height: 76 };
const GAP = 6;
/** A wide area like the window at its usual size, and a tall, narrow one. */
const WIDE = [1040, 400] as const;
const TALL = [420, 760] as const;
/** The grid, and the first chart's block. */
const shape = (plan: GridPlan) =>
  `${plan.columns}×${plan.rows} first ${plan.cells[0].columns}×${plan.cells[0].rows}`;
/** Each chart as "column,row" (from 1). */
const spots = (plan: GridPlan) => plan.cells.map((c) => `${c.column},${c.row}`);

describe("engine grid plan", () => {
  it("focus follows the preset for each count: the first chart a block, every other one unit", () => {
    const focus = (n: number) => planGrid("focus", n, ...WIDE, CELL, GAP);
    expect(shape(focus(2))).toBe("2×1 first 1×1");
    // Three: the first two units square, two stacked beside it.
    expect(shape(focus(3))).toBe("3×2 first 2×2");
    expect(spots(focus(3))).toEqual(["1,1", "3,1", "3,2"]);
    // Four: three square, three stacked beside it.
    expect(shape(focus(4))).toBe("4×3 first 3×3");
    // Five: two square, four beside it in two columns.
    expect(shape(focus(5))).toBe("4×2 first 2×2");
    expect(spots(focus(5))).toEqual(["1,1", "3,1", "4,1", "3,2", "4,2"]);
    // Six: two square in an L of five.
    expect(shape(focus(6))).toBe("3×3 first 2×2");
    expect(spots(focus(6))).toEqual(["1,1", "3,1", "3,2", "1,3", "2,3", "3,3"]);
    // Eight: three square in an L of seven.
    expect(shape(focus(8))).toBe("4×4 first 3×3");
  });

  it("in a tall area focus turns the arrangement on its side: the first chart on top", () => {
    const three = planGrid("focus", 3, ...TALL, CELL, GAP);
    expect(shape(three)).toBe("2×3 first 2×2");
    expect(spots(three)).toEqual(["1,1", "1,3", "2,3"]);
    expect(shape(planGrid("focus", 4, ...TALL, CELL, GAP))).toBe("3×4 first 3×3");
  });

  it("focus falls back to a more compact preset where the first would make cells too small", () => {
    // Eight in a short, wide area: four rows of units would be too low.
    expect(shape(planGrid("focus", 8, 1040, 260, CELL, GAP))).toBe("5×3 first 4×2");
  });

  it("every layout fills its grid, and every chart but the first is one unit", () => {
    for (const layout of ["grid", "focus", "rows"] as const) {
      for (let n = 1; n <= 20; n++) {
        for (const [w, h] of [WIDE, TALL, [904, 234], [1285, 560], [524, 240]] as const) {
          const plan = planGrid(layout, n, w, h, CELL, GAP);
          expect(plan.cells.length, `${layout} ${n} in ${w}×${h}: count`).toBe(n);
          expect(fills(plan), `${layout} ${n} in ${w}×${h}: fills`).toBe(true);
          expect(evenRest(plan), `${layout} ${n} in ${w}×${h}: equal`).toBe(true);
        }
      }
    }
  });

  it("a grid of a count that splits into rows and columns has every chart the same size", () => {
    const grid = (n: number) => planGrid("grid", n, ...WIDE, CELL, GAP);
    expect(shape(grid(2))).toBe("2×1 first 1×1");
    expect(shape(grid(3))).toBe("3×1 first 1×1");
    expect(shape(grid(4))).toBe("2×2 first 1×1");
    expect(shape(grid(6))).toBe("3×2 first 1×1");
    expect(shape(grid(8))).toBe("4×2 first 1×1");
    expect(shape(grid(9))).toBe("3×3 first 1×1");
    expect(shape(grid(12))).toBe("4×3 first 1×1");
    expect(shape(grid(15))).toBe("5×3 first 1×1");
    expect(shape(grid(16))).toBe("4×4 first 1×1");
  });

  it("a count that does not split: one row where it reads well, else the first chart takes the spare unit", () => {
    // Five in a short, wide area: one row of five.
    expect(shape(planGrid("grid", 5, 904, 234, CELL, GAP))).toBe("5×1 first 1×1");
    // Five in a taller one: three by two, the first two units wide.
    const five = planGrid("grid", 5, ...WIDE, CELL, GAP);
    expect(shape(five)).toBe("3×2 first 2×1");
    expect(spots(five)).toEqual(["1,1", "3,1", "1,2", "2,2", "3,2"]);
    // Seven: four by two, the first two units wide.
    expect(shape(planGrid("grid", 7, ...WIDE, CELL, GAP))).toBe("4×2 first 2×1");
  });

  it("rows put every engine in a row of its own", () => {
    expect(shape(planGrid("rows", 4, ...WIDE, CELL, GAP))).toBe("1×4 first 1×1");
  });

  it("plans compare by value", () => {
    expect(
      samePlan(planGrid("focus", 6, ...WIDE, CELL, GAP), planGrid("focus", 6, ...WIDE, CELL, GAP))
    ).toBe(true);
    expect(
      samePlan(planGrid("grid", 4, ...WIDE, CELL, GAP), planGrid("focus", 4, ...WIDE, CELL, GAP))
    ).toBe(false);
  });
});
