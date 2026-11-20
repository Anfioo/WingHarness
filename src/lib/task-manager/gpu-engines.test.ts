// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import {
  arrange,
  chartCount,
  isSmart,
  shownEngines,
  wasBusy,
  withCount,
  withEngine,
  withSmart,
} from "./gpu-engines";

const ENGINES = ["3D", "Copy", "Video Encode", "Video Decode", "Compute_0", "Security"];

describe("GPU engine choice", () => {
  it("charts every engine in the GPU's order until chosen", () => {
    expect(shownEngines(ENGINES)).toEqual(ENGINES);
    expect(chartCount(ENGINES)).toBe(6);
    expect(shownEngines([])).toEqual([]);
  });

  it("keeps the arranged order and stays within the engines", () => {
    const two = withCount(ENGINES, undefined, 2);
    expect(two).toEqual({ count: 2, order: ENGINES });
    expect(shownEngines(ENGINES, two)).toEqual(["3D", "Copy"]);
    expect(withCount(ENGINES, two, 6).count).toBeNull();
    expect(withCount(ENGINES, two, 99).count).toBeNull();
    expect(withCount(ENGINES, two, 0).count).toBe(1);
    expect(chartCount(["3D", "Copy"], { count: 4, order: [] })).toBe(2);
  });

  it("puts an engine not charted in the place and moves the replaced one next", () => {
    const two = withCount(ENGINES, undefined, 2);
    const chosen = withEngine(ENGINES, two, 0, "Video Decode");
    expect(shownEngines(ENGINES, chosen)).toEqual(["Video Decode", "Copy"]);
    expect(chosen.order).toEqual([
      "Video Decode",
      "Copy",
      "3D",
      "Video Encode",
      "Compute_0",
      "Security",
    ]);
    expect(shownEngines(ENGINES, withCount(ENGINES, chosen, 3))).toEqual([
      "Video Decode",
      "Copy",
      "3D",
    ]);
  });

  it("trades places with an engine charted elsewhere", () => {
    const two = withCount(ENGINES, undefined, 2);
    expect(shownEngines(ENGINES, withEngine(ENGINES, two, 0, "Copy"))).toEqual(["Copy", "3D"]);
    expect(withEngine(ENGINES, two, 1, "Copy")).toEqual(two);
    expect(shownEngines(ENGINES, withEngine(ENGINES, two, 0, "VR"))).toEqual(["3D", "Copy"]);
  });

  it("keeps what still applies from a choice made on another driver", () => {
    const stored = { count: 3, order: ["Video Decode", "Legacy Overlay", "Video Decode", "Copy"] };
    expect(arrange(ENGINES, stored)).toEqual([
      "Video Decode",
      "Copy",
      "3D",
      "Video Encode",
      "Compute_0",
      "Security",
    ]);
    expect(shownEngines(ENGINES, stored)).toEqual(["Video Decode", "Copy", "3D"]);
  });

  const busy = (engine: string) => engine === "3D" || engine === "Video Encode";

  it("charts the busy engines under smart display", () => {
    expect(isSmart(undefined)).toBe(true);
    expect(shownEngines(ENGINES, undefined, busy)).toEqual(["3D", "Video Encode"]);
    expect(shownEngines(ENGINES, undefined, () => false)).toEqual(["3D"]);
    const arranged: ReturnType<typeof withCount> = {
      ...withCount(ENGINES, undefined, 6),
      smart: true,
      order: ["Video Encode", ...ENGINES.filter((engine) => engine !== "Video Encode")],
    };
    expect(shownEngines(ENGINES, arranged, busy)).toEqual(["Video Encode", "3D"]);
  });

  it("keeps a count picked before smart display existed", () => {
    const saved = { count: 2, order: ENGINES };
    expect(isSmart(saved)).toBe(false);
    expect(shownEngines(ENGINES, saved, busy)).toEqual(["3D", "Copy"]);
  });

  it("counts an engine as busy from 1% within the span", () => {
    expect(wasBusy([0, 0, 1.2, 0])).toBe(true);
    expect(wasBusy([0, 0.4, 0.9, null, Number.NaN])).toBe(false);
    expect(wasBusy([])).toBe(false);
  });

  it("starts a count picked under smart display from the charts on screen", () => {
    const two = withCount(ENGINES, undefined, 2, ["3D", "Video Encode"]);
    expect(isSmart(two)).toBe(false);
    expect(shownEngines(ENGINES, two, busy)).toEqual(["3D", "Video Encode"]);
    expect(shownEngines(ENGINES, withCount(ENGINES, two, 3), busy)).toEqual([
      "3D",
      "Video Encode",
      "Copy",
    ]);
  });

  it("picks the charts by hand once an engine is chosen under smart display", () => {
    const chosen = withEngine(ENGINES, undefined, 1, "Copy", ["3D", "Video Encode"]);
    expect(isSmart(chosen)).toBe(false);
    expect(shownEngines(ENGINES, chosen, busy)).toEqual(["3D", "Copy"]);
  });

  it("keeps count and order when switching back to smart display", () => {
    const two = withCount(ENGINES, undefined, 2, ["3D", "Video Encode"]);
    const smart = withSmart(ENGINES, two);
    expect(isSmart(smart)).toBe(true);
    expect(shownEngines(ENGINES, smart, busy)).toEqual(["3D", "Video Encode"]);
    expect(shownEngines(ENGINES, { ...smart, smart: false }, busy)).toEqual(["3D", "Video Encode"]);
  });
});
