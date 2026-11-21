// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Time formatting for the history charts. Every formatter follows the app's
// language, and the precision follows the span the cursor is read within.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type HistoryTimeFormat = {
  /** An axis tick: a date at midnight, the clock elsewhere. */
  tick: (ts: number) => string;
  /** The cursor's time, as precise as the points under it. */
  cursor: (ts: number, span: number) => string;
  /** A moment, with its date unless it is today. */
  moment: (ts: number) => string;
};

export function createHistoryTimeFormat(locale: string): HistoryTimeFormat {
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const seconds = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  // "short" months read "10月11日" in Chinese; "numeric" gives "10/11".
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });

  const isToday = (ts: number) => new Date(ts).toDateString() === new Date().toDateString();
  const moment = (ts: number) =>
    isToday(ts) ? seconds.format(ts) : `${day.format(ts)} ${seconds.format(ts)}`;
  const cursor = (ts: number, span: number) =>
    span > DAY
      ? `${day.format(ts)} ${time.format(ts)}`
      : span > 6 * HOUR
        ? time.format(ts)
        : seconds.format(ts);
  const tick = (ts: number) => {
    const date = new Date(ts);
    return date.getHours() === 0 && date.getMinutes() === 0 ? day.format(ts) : time.format(ts);
  };

  return { tick, cursor, moment };
}
