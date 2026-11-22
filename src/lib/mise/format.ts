// Display helpers for the environment page.
//
// Pure functions only: byte counts, durations, timestamps and the lookup tables
// that turn engine enums into i18n keys. Components translate the returned keys
// themselves, so nothing here needs React or Tauri.

import type {
  MiseHealthLevel,
  MiseHistoryStatus,
  MiseImpactReason,
  MiseNoticeCode,
  MiseRuntimeSource,
  MiseSignalCode,
  MiseToolSourceKind,
} from "@/commands";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Byte count in the largest fitting unit, one decimal. `—` when unknown. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Relative time such as "3 minutes ago", in the past or the future.
 * `ms` is a Unix timestamp in milliseconds. Missing values return an empty
 * string, so the caller decides which "unknown" wording to show.
 */
export function formatRelativeTime(ms: number | null | undefined, language: string): string {
  if (ms == null || !Number.isFinite(ms)) return "";

  const deltaSeconds = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });

  if (abs < MINUTE) return formatter.format(deltaSeconds, "second");
  if (abs < HOUR) return formatter.format(Math.round(deltaSeconds / MINUTE), "minute");
  if (abs < DAY) return formatter.format(Math.round(deltaSeconds / HOUR), "hour");
  if (abs < MONTH) return formatter.format(Math.round(deltaSeconds / DAY), "day");
  if (abs < YEAR) return formatter.format(Math.round(deltaSeconds / MONTH), "month");
  return formatter.format(Math.round(deltaSeconds / YEAR), "year");
}

/** Command duration: `842 ms` below a second, `1.2 s` above. `—` when unknown. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Absolute local date and time for a Unix millisecond timestamp. */
export function formatTimestamp(ms: number, language: string): string {
  return new Date(ms).toLocaleString(language);
}

/** The health-level label key, used by badges and card headers. */
export function levelLabelKey(level: MiseHealthLevel): string {
  return `mise.level.${level}`;
}

const SIGNAL_KEYS: Record<MiseSignalCode, string> = {
  runtime: "mise.signal.runtime",
  "active-tools": "mise.signal.activeTools",
  "path-export": "mise.signal.pathExport",
  "java-home": "mise.signal.javaHome",
  "config-source": "mise.signal.configSource",
};

/** The i18n prefix for a signal; append `.title` or `.detail`. */
export function signalKey(code: MiseSignalCode): string {
  return SIGNAL_KEYS[code];
}

// The locale keeps notice copy as one flat string per code (the detail and
// command travel in the DTO), so this is the whole message key.
const NOTICE_KEYS: Record<MiseNoticeCode, string> = {
  "windows-shim-missing": "mise.tools.notice.windowsShimMissing",
  "remote-unavailable": "mise.tools.notice.remoteUnavailable",
  "project-trust": "mise.tools.notice.projectTrust",
  other: "mise.tools.notice.other",
};

/** The message key for a notice code. */
export function noticeKey(code: MiseNoticeCode): string {
  return NOTICE_KEYS[code];
}

/** The label key for where an installed tool version is configured. */
export function sourceKey(kind: MiseToolSourceKind): string {
  return `mise.tools.source.${kind}`;
}

const RUNTIME_SOURCE_KEYS: Record<MiseRuntimeSource, string> = {
  path: "mise.runtime.sources.path",
  scoop: "mise.runtime.sources.scoop",
  direct: "mise.runtime.sources.direct",
  unknown: "mise.runtime.sources.unknown",
};

/** The label key for where the mise executable comes from. */
export function runtimeSourceKey(source: MiseRuntimeSource | null | undefined): string {
  return RUNTIME_SOURCE_KEYS[source ?? "unknown"];
}

/** The status label key for a history entry. */
export function historyStatusKey(status: MiseHistoryStatus): string {
  return `mise.history.status.${status}`;
}

/** The label key for why a project's version binding differs from the global one. */
export function impactReasonKey(reason: MiseImpactReason): string {
  return `mise.tools.impact.reason.${reason}`;
}
