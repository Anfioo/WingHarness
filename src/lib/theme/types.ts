/** The app's own light/dark split, which every theme carries one half of. */
export type ColorMode = "light" | "dark";

/**
 * A theme's variables for one mode, exactly as tweakcn publishes them: the keys
 * are CSS custom property names without their leading `--`, the values are ready
 * to assign. Fonts and shadows are in here too, not just colors.
 */
export type ThemeVars = Record<string, string>;

/** One of tweakcn's themes, in both modes. */
export type ThemePreset = {
  id: string;
  /** tweakcn's display name for the theme, kept in English. */
  label: string;
  light: ThemeVars;
  dark: ThemeVars;
};
