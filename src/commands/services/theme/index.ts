import { invokeCommand } from "../../base";

/**
 * `@font-face` rules for a theme's fonts, downloading anything the machine does
 * not already have.
 *
 * Resolves to an empty string when nothing could be fetched — offline, or a
 * family the sources do not carry — which the caller reads as "use the theme's
 * fallback stack".
 */
export function themeFontsCss(families: string[]): Promise<string> {
  return invokeCommand("theme_fonts_css", { families });
}
