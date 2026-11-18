// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import { rateCeiling, rateCeilingLabel, roundCeiling } from "./chart-scale";

const KIB = 1024;
const MIB = 1024 ** 2;

describe("chart scale", () => {
  it("rounds a ceiling to a readable whole number", () => {
    expect(roundCeiling(0)).toBe(1);
    expect(roundCeiling(0.4)).toBe(1);
    expect(roundCeiling(1.2)).toBe(2);
    expect(roundCeiling(10)).toBe(10);
    expect(roundCeiling(10.1)).toBe(20);
    expect(roundCeiling(30.000000000004)).toBe(30);
  });

  it("keeps a minimum one-unit top for an idle chart", () => {
    expect(rateCeiling(0)).toBe(KIB);
    expect(rateCeiling(Number.NaN)).toBe(KIB);
    expect(rateCeiling(500)).toBe(KIB);
  });

  it("rounds a rate up in the unit it is shown in", () => {
    expect(rateCeiling(1500)).toBe(2 * KIB);
    expect(rateCeiling(8 * MIB)).toBe(8 * MIB);
    // Above ten the top moves in tens, so the axis keeps short labels.
    expect(rateCeiling(12 * MIB)).toBe(20 * MIB);
    expect(rateCeiling(12.4 * MIB)).toBe(20 * MIB);
  });

  it("moves into the next unit when rounding would overflow it", () => {
    expect(rateCeiling(MIB - 1)).toBe(MIB);
  });

  it("labels the top with its unit", () => {
    expect(rateCeilingLabel(2 * KIB)).toBe("2 KiB/s");
    expect(rateCeilingLabel(12 * MIB)).toBe("12 MiB/s");
    expect(rateCeilingLabel(150 * MIB)).toBe("150 MiB/s");
  });
});
