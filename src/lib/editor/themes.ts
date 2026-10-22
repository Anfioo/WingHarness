import type { Theme } from "codelet";
import { rangiThemes } from "codelet/themes";

/**
 * The editor's theme catalog, from codelet's own palettes.
 *
 * Shared by every surface that mounts an editor and by the settings page that
 * chooses between them, so there is one list rather than a copy per page.
 */
export const EDITOR_THEMES: readonly Theme[] = rangiThemes;

/** The themes belonging to one side of the light/dark split. */
export function themesFor(dark: boolean): Theme[] {
  return EDITOR_THEMES.filter((theme) => theme.dark === dark);
}

export function themeNamed(name: string): Theme | undefined {
  return EDITOR_THEMES.find((theme) => theme.name === name);
}

/**
 * Whether the app is painting its dark side right now.
 *
 * The app's ThemeProvider adds `light`/`dark` to <html>, but that runs in an
 * effect after a page's own effect on first mount, so the class may not be
 * there yet — fall back to the system preference in that window, which is what
 * the provider itself does for the `system` setting.
 */
export function isDarkMode(): boolean {
  const root = document.documentElement;
  if (root.classList.contains("dark")) return true;
  if (root.classList.contains("light")) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Calls `onChange` whenever the app's colour scheme changes. Returns the unsubscribe. */
export function watchColorMode(onChange: () => void): () => void {
  // Two signals, because a preset and a mode reach the page by different routes:
  // an explicit choice and the `system` setting land as a class on <html>, while
  // a theme preset is written there as inline variables instead.
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  return () => observer.disconnect();
}
