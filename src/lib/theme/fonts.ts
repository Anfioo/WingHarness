import { themeFontsCss } from "@/commands";
import { presetById } from "./presets";
import type { ColorMode } from "./types";

/**
 * The fonts a theme asks for, fetched once and cached on disk.
 *
 * A theme names its own typefaces in `font-*`, but the app ships none of them:
 * every stack ends in a generic family, so an unavailable font is a silent
 * fallback to whatever the system picks. Bringing the named ones down is what
 * makes a theme look like its card in the picker; the fetch and the cache are
 * the backend's (`src-tauri/src/theme/fonts.rs`), which hands back ready-made
 * `@font-face` rules.
 *
 * Fonts belong to the theme, not the mode, but a few themes do name different
 * ones per side — so the families are read out of the mode being applied.
 */

/**
 * Families there is nothing to fetch for: the generic keywords, which the system
 * resolves itself, and the handful of typefaces tweakcn stacks as a fallback
 * that ship with the OS and are on no font CDN.
 */
const GENERIC_FAMILY =
  /^(ui-(sans|serif|mono)|sans-serif|serif|monospace|system-ui|menlo|courier new|georgia|times new roman)$/;

/** The family a stack asks for is its leading entry; the rest is the fallback chain. */
function stackFamily(stack: string | undefined): string[] {
  const first = stack
    ?.split(",")[0]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  if (!first || GENERIC_FAMILY.test(first.toLowerCase())) return [];
  return [first];
}

/** The families a preset names in one mode. */
export function themeFontFamilies(id: string, mode: ColorMode): string[] {
  const preset = presetById(id);
  if (!preset) return [];

  const vars = mode === "dark" ? preset.dark : preset.light;
  const families = new Set([
    ...stackFamily(vars["font-sans"]),
    ...stackFamily(vars["font-mono"]),
    ...stackFamily(vars["font-serif"]),
  ]);
  return [...families];
}

const STYLE_ID = "theme-fonts";

/** The families already in this document's stylesheet, so re-selecting a theme is free. */
let injected: string | null = null;

/** The newest request, so a slow one cannot land after a newer theme's fonts. */
let latest = 0;

/**
 * Put the selected theme's fonts in the document.
 *
 * Failures are silent on purpose: a font that could not be fetched is already
 * covered by the fallback in the theme's own stack, and the selection should not
 * report an error for a typeface.
 */
export async function applyThemeFonts(id: string, mode: ColorMode): Promise<void> {
  const families = themeFontFamilies(id, mode);
  const signature = families.join("|");
  if (signature === injected) return;
  if (families.length === 0) {
    injected = signature;
    return;
  }

  const ticket = ++latest;
  let css: string;
  try {
    css = await themeFontsCss(families);
  } catch (error) {
    console.warn("theme fonts unavailable:", error);
    return;
  }
  if (ticket !== latest) return;

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = css;
  // Only a stylesheet with something in it counts as done: an empty one means
  // the fetch failed, and that is worth another try the next time the theme is
  // selected rather than remembering the failure.
  if (css) injected = signature;
}
