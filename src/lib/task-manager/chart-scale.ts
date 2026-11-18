// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Tops for the charts without a fixed one: a whole number in the unit the
// label shows, and above ten a multiple of ten, so the axis reads
// "2 MiB/s" rather than "1.73 MiB/s".

/** Floating-point slack, so 30.000000000004 rounds to 30, not 40. */
const EPSILON = 1e-9;

/** Binary-prefix rate units, matching `formatRate` in the format helpers. */
const RATE_UNITS = [
  { size: 1024, label: "KiB/s" },
  { size: 1024 ** 2, label: "MiB/s" },
  { size: 1024 ** 3, label: "GiB/s" },
] as const;

/** The least whole number at or above `x`, at least 1; above ten, the least multiple of ten. */
export function roundCeiling(x: number): number {
  if (!(x > 1)) return 1;
  const whole = Math.ceil(x - EPSILON);
  return whole <= 10 ? whole : Math.ceil(x / 10 - EPSILON) * 10;
}

/** The unit a rate is shown in: the largest one it reaches. */
function unitIndex(bytesPerSecond: number): number {
  let index = 0;
  while (
    index + 1 < RATE_UNITS.length &&
    bytesPerSecond >= RATE_UNITS[index + 1].size * (1 - EPSILON)
  ) {
    index += 1;
  }
  return index;
}

/** The top for a rate chart whose highest point is `peak` bytes per second. */
export function rateCeiling(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return RATE_UNITS[0].size;
  let index = unitIndex(peak);
  for (;;) {
    const top = roundCeiling(peak / RATE_UNITS[index].size) * RATE_UNITS[index].size;
    // Rounded up into the next unit: round there, "1 MiB/s" rather than "1030 KiB/s".
    if (index + 1 < RATE_UNITS.length && top >= RATE_UNITS[index + 1].size * (1 - EPSILON)) {
      index += 1;
      continue;
    }
    return top;
  }
}

/** A ceiling's label, e.g. `8 MiB/s`, `150 MiB/s`. */
export function rateCeilingLabel(top: number): string {
  const unit = RATE_UNITS[unitIndex(top)];
  return `${Math.round(top / unit.size)} ${unit.label}`;
}
