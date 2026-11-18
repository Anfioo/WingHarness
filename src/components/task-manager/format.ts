// Formatting helpers shared by the process and performance tabs.
//
// Every helper returns an em dash for a value that is not a finite number, so a
// not-yet-measured rate renders as "—" instead of "NaN".

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** A byte count with a binary-prefix unit, e.g. `1.5 GiB`. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(fractionDigits)} ${BYTE_UNITS[unit]}`;
}

/** A transfer rate, e.g. `12.3 MiB/s`. */
export function formatRate(bytesPerSecond: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytesPerSecond)) return "—";
  return `${formatBytes(bytesPerSecond, fractionDigits)}/s`;
}

/** A percentage, e.g. `42.0%`. */
export function formatPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(fractionDigits)}%`;
}

/** A duration in milliseconds as `1d 2h`, `3h 04m`, `5m 06s` or `7.2s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${String(totalMinutes % 60).padStart(2, "0")}m`;
  return `${totalMinutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}
