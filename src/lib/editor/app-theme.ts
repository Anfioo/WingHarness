import type { Theme } from "codelet";
import { mix, toHex } from "./color";
import { themeForMode } from "./prefs";

/**
 * The theme a workbench's chrome is painted with, built from the app's own.
 *
 * Tab strip, activity bar, sidebar, panel, status bar, menus — the shell belongs
 * to the window it sits in, so it follows whatever preset the app is wearing
 * (written onto `<html>` by `src/lib/theme/apply.ts`). The code inside the open
 * tabs is the exception: its syntax colours stay the choice made in
 * Settings → Editor, which is why `tokens` is the one field read from there.
 *
 * Must be read in a passive effect rather than during render: the provider
 * writes the variables in a layout effect, and a child's layout effect runs
 * before its parent's, so an earlier read sees the stylesheet's default.
 */

let cached: { key: string; theme: Theme } | null = null;

export function appShellTheme(dark: boolean): Theme {
  const root = getComputedStyle(document.documentElement);
  const read = (name: string) => toHex(root.getPropertyValue(name).trim());
  const bg = read("--background");
  const fg = read("--foreground");
  const sidebar = read("--sidebar");
  const line = read("--border");
  const muted = read("--muted-foreground");
  const accent = read("--primary");

  // The object's identity is load-bearing: codelet caches the styles it builds
  // per `Theme`, and remounts the whole shell when handed a different one — so
  // this returns the previous object until something it was built from moved.
  const key = [dark, bg, fg, sidebar, line, muted, accent].join("|");
  if (cached?.key === key) return cached.theme;

  const theme: Theme = {
    name: `app:${dark ? "dark" : "light"}`,
    dark,
    bg,
    fg,
    // `--sidebar` is the app's own secondary surface. A preset that leaves it
    // level with the background would flatten the chrome into one sheet, so that
    // case falls back to codelet's own derivation.
    panel: sidebar && sidebar !== bg ? sidebar : mix(bg, fg, 0.04),
    line,
    muted,
    accent,
    // Codelet's only translucent field: it is painted over whatever it lands on,
    // so it follows the foreground rather than a fixed black or white.
    hover: `${fg}12`,
    // Opaque, as the type demands — it has to read the same over an active line.
    selection: mix(bg, fg, 0.22),
    tokens: themeForMode(dark).tokens,
  };
  cached = { key, theme };
  return theme;
}
