import { presetById, presetVars } from "./presets";
import type { ColorMode } from "./types";

/**
 * The variables the last call wrote, so the next one can take them back out.
 * Every preset carries the same set, so a switch that only set properties would
 * leave nothing behind — this is what covers the switch *back* to the default
 * theme, where the stylesheet's own values have to show through again.
 */
let applied: string[] = [];

/**
 * Paint the app as `id`, in `mode`.
 *
 * Assignment is inline on the document element, which outranks both `:root` and
 * `.dark` in the stylesheet — so the theme in force is always the last one
 * applied, and the default theme is what those blocks already hold.
 *
 * An unknown id (including [`DEFAULT_PRESET_ID`], which deliberately has no
 * entry) clears the inline variables and leaves the stylesheet alone.
 */
export function applyThemePreset(id: string, mode: ColorMode): void {
  const root = document.documentElement;
  for (const name of applied) root.style.removeProperty(name);
  applied = [];

  const preset = presetById(id);
  if (!preset) return;

  for (const [name, value] of Object.entries(presetVars(preset, mode))) {
    const property = `--${name}`;
    root.style.setProperty(property, value);
    applied.push(property);
  }
}
