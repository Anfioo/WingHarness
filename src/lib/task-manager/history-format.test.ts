import { describe, expect, it } from "vitest";
import { createHistoryTimeFormat } from "./history-format";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("createHistoryTimeFormat", () => {
  const format = createHistoryTimeFormat("en-US");
  const afternoon = new Date(2026, 9, 11, 13, 5, 9).getTime();

  it("labels non-midnight ticks with the clock and midnights with the date", () => {
    expect(format.tick(afternoon)).toBe("13:05");
    expect(format.tick(new Date(2026, 9, 11).getTime())).toBe("Oct 11");
  });

  it("gives the cursor a precision that follows the window", () => {
    expect(format.cursor(afternoon, 15 * 60_000)).toBe("13:05:09");
    expect(format.cursor(afternoon, 7 * HOUR)).toBe("13:05");
    expect(format.cursor(afternoon, 2 * DAY)).toBe("Oct 11 13:05");
  });

  it("adds the date to a moment that is not today", () => {
    expect(format.moment(afternoon)).toBe("Oct 11 13:05:09");
    const today = new Date();
    today.setHours(13, 5, 9, 0);
    expect(format.moment(today.getTime())).toBe("13:05:09");
  });
});
