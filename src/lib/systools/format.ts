const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Locale-aware binary byte size; zero means unknown. */
export function formatBytes(bytes: number, language?: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${BYTE_UNITS[0]}`;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatter = new Intl.NumberFormat(language, {
    maximumFractionDigits: value < 10 && unitIndex > 0 ? 1 : 0,
  });
  return `${formatter.format(value)} ${BYTE_UNITS[unitIndex]}`;
}

/** Locale-aware integer count. */
export function formatCount(value: number, language?: string): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
}

/** Percentage of a total, clamped for display; zero totals read as 0%. */
export function formatShare(part: number, total: number, language?: string): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || part <= 0 || total <= 0) return "0%";
  const share = Math.min(1, part / total);
  const digits = share < 0.01 ? 2 : share < 0.1 ? 1 : 0;
  return new Intl.NumberFormat(language, {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(share);
}

/** Locale-aware date and time for a scan or entry timestamp. */
export function formatModifiedDate(timestampMs: number | null, language?: string): string {
  if (timestampMs === null || !Number.isFinite(timestampMs) || timestampMs <= 0) return "-";
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestampMs));
}
