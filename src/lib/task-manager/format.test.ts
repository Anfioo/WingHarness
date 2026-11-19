// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

import { describe, expect, it } from "vitest";
import {
  formatBitRate,
  formatBytes,
  formatDuration,
  formatGigabytes,
  formatLinkSpeed,
  formatPercent,
  formatRate,
  formatRemainingTime,
  formatWatts,
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

describe("formatBitRate", () => {
  it("converts bytes per second to bits", () => {
    expect(formatBitRate(1000)).toBe("8.0 Kbps");
    expect(formatBitRate(125_000)).toBe("1.00 Mbps");
    expect(formatBitRate(125_000_000)).toBe("1.00 Gbps");
  });

  it("returns an em dash for a missing rate", () => {
    expect(formatBitRate(Number.NaN)).toBe("—");
  });
});

describe("formatLinkSpeed", () => {
  it("shows bits per second in the largest whole unit", () => {
    expect(formatLinkSpeed(100_000_000)).toBe("100 Mbps");
    expect(formatLinkSpeed(1_000_000_000)).toBe("1 Gbps");
  });

  it("returns an em dash when the adapter reports no speed", () => {
    expect(formatLinkSpeed(0)).toBe("—");
  });
});

describe("formatWatts", () => {
  it("keeps one decimal below ten watts and rounds above", () => {
    expect(formatWatts(7.44)).toBe("7.4 W");
    expect(formatWatts(78.4)).toBe("78 W");
  });

  it("returns an em dash for a missing reading", () => {
    expect(formatWatts(Number.NaN)).toBe("—");
  });
});

describe("formatGigabytes", () => {
  it("shows binary gigabytes with the performance page's GB label", () => {
    expect(formatGigabytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatGigabytes(1024 ** 3 * 31.94)).toBe("31.9 GB");
    expect(formatGigabytes(1024 ** 3 * 32, 0)).toBe("32 GB");
  });

  it("returns an em dash for a missing size", () => {
    expect(formatGigabytes(Number.NaN)).toBe("—");
  });
});

describe("formatRemainingTime", () => {
  it("shows hours and minutes, or whole minutes", () => {
    expect(formatRemainingTime(45 * 60)).toBe("45m");
    expect(formatRemainingTime(80 * 60)).toBe("1h 20m");
    expect(formatRemainingTime(3600)).toBe("1h 00m");
  });

  it("returns an em dash for a missing or negative time", () => {
    expect(formatRemainingTime(Number.NaN)).toBe("—");
    expect(formatRemainingTime(-1)).toBe("—");
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
