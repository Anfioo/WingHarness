// Pure display helpers for the server manager.
//
// Nothing here touches Tauri, React or the DOM: every function takes plain
// data and (where needed) an injected locale or translator, so both the list
// page and the window can share the exact same formatting.

import { isServerError, serverErrorCode } from "@/commands/services/servers/types";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** Human-readable size. `0` and negative values render as `0 B`. */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const fractionDigits = unit === 0 || value >= 100 ? 0 : 1;
  const formatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  });
  return `${formatter.format(value)} ${BYTE_UNITS[unit]}`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Relative time such as "3 minutes ago".
 *
 * `at` is a Unix timestamp in seconds, as the engine reports it; `now` is a
 * millisecond timestamp from `Date.now()`. Returns `null` when the timestamp is
 * missing or invalid, which lets callers show their own "never" wording.
 */
export function formatRelativeTime(
  at: number | null | undefined,
  now: number,
  locale?: string
): string | null {
  if (at === null || at === undefined || !Number.isFinite(at) || at <= 0) return null;

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const deltaSeconds = at - now / 1000;
  const abs = Math.abs(deltaSeconds);

  if (abs < MINUTE) return formatter.format(Math.round(deltaSeconds), "second");
  if (abs < HOUR) return formatter.format(Math.round(deltaSeconds / MINUTE), "minute");
  if (abs < DAY) return formatter.format(Math.round(deltaSeconds / HOUR), "hour");
  if (abs < MONTH) return formatter.format(Math.round(deltaSeconds / DAY), "day");
  if (abs < YEAR) return formatter.format(Math.round(deltaSeconds / MONTH), "month");
  return formatter.format(Math.round(deltaSeconds / YEAR), "year");
}

function octalToSymbolic(octal: string): string {
  return octal
    .slice(-3)
    .split("")
    .map((digit) => {
      const bits = Number(digit);
      return `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
    })
    .join("");
}

/**
 * Permission display. Accepts either an already symbolic mode (`drwxr-xr-x`)
 * or an octal one (`755`); anything unrecognized is passed through unchanged.
 */
export function formatPermissions(mode: string | null | undefined): string {
  if (!mode) return "—";

  const trimmed = mode.trim();
  if (/^[bcdlps-][rwxsStT-]{9}$/.test(trimmed)) return trimmed;

  const octal = trimmed.replace(/^0o/i, "");
  if (/^[0-7]{3,4}$/.test(octal)) return octalToSymbolic(octal);

  return trimmed;
}

/**
 * Shorten a path for a single-line label, keeping the tail (the interesting
 * part) and cutting at a separator so no segment is sliced in half.
 */
export function formatPath(path: string, maxLength = 56): string {
  if (!path) return "/";

  const normalized = path.replace(/\\/g, "/");
  const limit = Math.max(8, maxLength);
  if (normalized.length <= limit) return normalized;

  const tail = normalized.slice(-(limit - 1));
  const boundary = tail.indexOf("/");
  return `…${boundary > 0 ? tail.slice(boundary) : tail}`;
}

/** `user@host:port`, the string every server row shows. */
export function formatEndpoint(host: string, port: number, username: string): string {
  return `${username}@${host}:${port}`;
}

/** Byte rate such as `1.2 MB/s`. */
export function formatRate(bytesPerSec: number, locale?: string): string {
  return `${formatBytes(bytesPerSec, locale)}/s`;
}

/** Percentage with one decimal such as `42.7%`. */
export function formatPercent(value: number): string {
  return `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`;
}

/**
 * Compact uptime: `36d 2h`, `2h 15m`, `15m`, `42s`.
 *
 * Only the two most significant units are shown; the metric cards are narrow.
 */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";

  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

/**
 * i18n key for a known engine error code, or `null` when the code has no
 * dedicated wording. The code names the behaviour, the message stays English
 * and is only used as a fallback.
 */
export function serverErrorKey(code: string | null): string | null {
  switch (code) {
    case "host-key-unknown":
      return "servers.error.hostKeyUnknown";
    case "host-key-mismatch":
      return "servers.error.hostKeyMismatch";
    case "auth-failed":
      return "servers.error.authFailed";
    case "connect-timeout":
      return "servers.error.connectTimeout";
    case "file-too-large":
      return "servers.error.fileTooLarge";
    case "not-implemented":
      return "servers.error.notImplemented";
    default:
      return null;
  }
}

/**
 * Best-effort text for any thrown value. Never includes credentials because
 * the engine never puts them into a message.
 */
export function errorText(error: unknown): string {
  if (isServerError(error)) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** i18n key for an engine error, falling back to `null` for unknown values. */
export function serverErrorCodeKey(error: unknown): string | null {
  return serverErrorKey(serverErrorCode(error));
}
