import presets from "./presets.json";
import type { ColorMode, ThemePreset, ThemeVars } from "./types";

/**
 * tweakcn's published themes, snapshotted by `pnpm themes:fetch` (see
 * `scripts/fetch-theme-presets.mjs` for where they come from and what is left
 * out of them).
 */
export const THEME_PRESETS = presets as ThemePreset[];

/**
 * The theme the app wears when no preset is selected: the values baked into
 * `src/index.css` itself. It has no entry in `THEME_PRESETS` because nothing
 * needs to be applied for it — the stylesheet already says so.
 */
export const DEFAULT_PRESET_ID = "default";

const byId = new Map(THEME_PRESETS.map((preset) => [preset.id, preset]));

/** The preset with this id, or `undefined` for the default and for ids that no longer exist. */
export function presetById(id: string): ThemePreset | undefined {
  return byId.get(id);
}

/**
 * The variables a preset contributes in one mode.
 *
 * Dark inherits whatever it does not override, exactly as the stylesheet does:
 * tweakcn writes its dark block as `.dark` rules over a `:root` that already
 * holds the light values, and a handful of settings — `tracking-normal` among
 * them — are stated once there and never repeated.
 */
export function presetVars(preset: ThemePreset, mode: ColorMode): ThemeVars {
  return mode === "dark" ? { ...preset.light, ...preset.dark } : preset.light;
}

/** The variables a preview swatch needs to stand for a whole theme. */
const PREVIEW_KEYS = ["background", "foreground", "primary", "secondary", "accent", "border"];

export type PreviewColors = Record<(typeof PREVIEW_KEYS)[number], string>;

function previewOf(vars: ThemeVars): PreviewColors {
  const preview = {} as PreviewColors;
  for (const key of PREVIEW_KEYS) preview[key] = vars[key] ?? "";
  return preview;
}

/**
 * Mirrors the default theme's `:root` and `.dark` blocks in `src/index.css`.
 *
 * Only the swatch colors are duplicated: the variables themselves are never
 * applied from here, so a future edit to the stylesheet only has to keep these
 * six in step to keep the default card's preview honest.
 */
const DEFAULT_PREVIEW: Record<ColorMode, PreviewColors> = {
  light: previewOf({
    background: "oklch(1 0 0)",
    foreground: "oklch(0.145 0 0)",
    primary: "oklch(0.205 0 0)",
    secondary: "oklch(0.97 0 0)",
    accent: "oklch(0.97 0 0)",
    border: "oklch(0.922 0 0)",
  }),
  dark: previewOf({
    background: "oklch(0.145 0 0)",
    foreground: "oklch(0.985 0 0)",
    primary: "oklch(0.985 0 0)",
    secondary: "oklch(0.269 0 0)",
    accent: "oklch(0.269 0 0)",
    border: "oklch(0.269 0 0)",
  }),
};

/** Colors for a preset's card, falling back to the default theme's for the default itself. */
export function previewColors(id: string, mode: ColorMode): PreviewColors {
  const preset = presetById(id);
  if (!preset) return DEFAULT_PREVIEW[mode];
  return previewOf(presetVars(preset, mode));
}
