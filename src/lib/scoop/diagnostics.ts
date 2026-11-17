/** An error as the diagnostics tab prints it. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A size as the cache list prints it: `4.2 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${power === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}
