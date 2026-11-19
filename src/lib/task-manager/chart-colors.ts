// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// Chart colors, expressed as CSS values so the same token paints the legend
// swatch in the DOM and the line on the canvas. The performance page has its
// own palette (`--perf-*`): one hue per resource, distinct in both themes.

export const CHART_COLORS = {
  cpu: "var(--perf-cpu)",
  /** Efficiency cores: a second hue beside the performance cores'. */
  cpuE: "var(--perf-cpu-e)",
  memory: "var(--perf-mem)",
  diskRead: "var(--perf-io)",
  diskWrite: "var(--perf-io)",
  netReceived: "var(--perf-net)",
  netSent: "var(--perf-net)",
  gpu: "var(--perf-gpu)",
  battery: "var(--perf-bat)",
  grid: "var(--border)",
  axis: "var(--muted-foreground)",
  /** The unallocated part of a composition bar. */
  free: "var(--border)",
} as const;

const FALLBACK = "#8a8a8a";
const VAR_PATTERN = /^var\(\s*(--[\w-]+)\s*\)$/;
const HSL_VAR_PATTERN = /^hsl\(\s*var\(\s*(--[\w-]+)\s*\)\s*\)$/i;

/**
 * Resolves a theme token to a color a canvas accepts. `getComputedStyle` is
 * needed because a canvas has no CSS cascade of its own; the element only
 * supplies the theme in effect.
 */
export function resolveChartColor(element: Element, color: string): string {
  const value = color.trim();
  const styles = getComputedStyle(element);

  const hslToken = HSL_VAR_PATTERN.exec(value);
  if (hslToken) {
    const raw = styles.getPropertyValue(hslToken[1]).trim();
    return raw ? `hsl(${raw})` : FALLBACK;
  }

  const token = VAR_PATTERN.exec(value);
  if (token) {
    const raw = styles.getPropertyValue(token[1]).trim();
    return raw || FALLBACK;
  }

  return value || FALLBACK;
}
