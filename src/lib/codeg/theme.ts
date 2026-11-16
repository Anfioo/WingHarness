import { presetById, presetVars } from "@/lib/theme/presets";
import type { ColorMode } from "@/lib/theme/types";
import type { CodegTheme } from "@/commands";

/**
 * The variables Codeg accepts in its custom theme.
 *
 * Mirrors `CUSTOM_THEME_TOKENS` in Codeg's own `src/lib/custom-style.ts`: the 31
 * shadcn semantic colors plus `radius`, keys without the leading `--`. Anything
 * else is dropped by Codeg, so sending more would only pretend to work — which
 * is why fonts, shadows and spacing are not carried across.
 */
const CODEG_TOKENS = [
  "primary",
  "primary-foreground",
  "background",
  "foreground",
  "accent",
  "accent-foreground",
  "border",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "destructive",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "radius",
] as const;

/**
 * The app's palette in the mode on screen, read from the document.
 *
 * The values are read rather than copied from a table: `--radius` and the colors
 * come from either `src/index.css` or the selected preset's inline variables blown
 * up by {@link applyThemePreset}, and reading the computed value is the only way
 * to get the answer without duplicating either source.
 *
 * It must be called *after* the mode class and the preset have been applied —
 * that is, from an effect, never during render.
 */
function currentVars(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const token of CODEG_TOKENS) {
    const value = style.getPropertyValue(`--${token}`).trim();
    // A token the app does not define (its charts have their own names) is left
    // out so Codeg keeps its own value instead of receiving an empty one.
    if (value) vars[token] = value;
  }
  return vars;
}

/**
 * The appearance to push into the Codeg page.
 *
 * Codeg stores one bucket per mode and reads only the one it is in, so the
 * bucket for the mode on screen holds the app's real palette. The other bucket
 * is filled from the selected preset when there is one, and left empty for the
 * built-in theme — whose values live in the stylesheet alone — so Codeg falls
 * back to its own default for a mode the app is not in.
 *
 * One-way: nothing here is ever read back from Codeg.
 */
export function buildCodegTheme(preset: string, mode: ColorMode): CodegTheme {
  const current = currentVars();
  const other: ColorMode = mode === "dark" ? "light" : "dark";
  const theme = presetById(preset);
  const otherVars = theme ? clean(presetVars(theme, other)) : {};

  const buckets =
    mode === "dark" ? { light: otherVars, dark: current } : { light: current, dark: otherVars };

  return { mode, custom: JSON.stringify(buckets) };
}

/** A preset's values, minus the ones Codeg would refuse anyway. */
function clean(vars: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const token of CODEG_TOKENS) {
    const value = vars[token]?.trim();
    if (value) kept[token] = value;
  }
  return kept;
}
