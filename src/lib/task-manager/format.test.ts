// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
} from "@/components/task-manager/format";

describe("formatBytes", () => {
  it("returns an em dash for a value that is not a finite number", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("shows whole bytes below one unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("steps through binary prefixes", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MiB");
    expect(formatBytes(1024 ** 3 * 2.25)).toBe("2.3 GiB");
  });

  it("honours the fraction digits", () => {
    expect(formatBytes(1536, 0)).toBe("2 KiB");
    expect(formatBytes(1536, 3)).toBe("1.500 KiB");
  });
});

describe("formatRate", () => {
  it("appends a per-second unit", () => {
    expect(formatRate(1024)).toBe("1.0 KiB/s");
    expect(formatRate(1536, 2)).toBe("1.50 KiB/s");
  });

  it("returns an em dash for a missing rate", () => {
    expect(formatRate(Number.NaN)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("fixes the fraction digits", () => {
    expect(formatPercent(42.04)).toBe("42.0%");
    expect(formatPercent(42.04, 2)).toBe("42.04%");
  });

  it("returns an em dash for a missing reading", () => {
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("shows fractions of a second below a minute", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(7200)).toBe("7.2s");
  });

  it("shows minutes with padded seconds", () => {
    expect(formatDuration(65_000)).toBe("1m 05s");
  });

  it("shows hours with padded minutes", () => {
    expect(formatDuration((3 * 3600 + 4 * 60) * 1000)).toBe("3h 04m");
  });

  it("shows days with the remaining hours", () => {
    expect(formatDuration(25 * 3600 * 1000)).toBe("1d 1h");
  });

  it("returns an em dash for a missing or negative duration", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});
