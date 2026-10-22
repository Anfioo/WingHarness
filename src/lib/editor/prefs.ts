import type { Theme } from "codelet";
import { themeNamed, themesFor } from "./themes";

/**
 * Editor preferences shared by every surface that mounts one.
 *
 * A theme is chosen per light/dark mode rather than once, so switching the app
 * to dark does not drop the reader onto whatever the dark half happens to hold
 * — the two slots are independent, and each is picked from the palettes built
 * for that side.
 *
 * Kept in `localStorage` alongside the other view preferences, and read by
 * every window: the settings window writes it, an editor page reads it at mount
 * and again on a `storage` event, so a change there reaches an open editor
 * without a restart.
 */
export type EditorPrefs = {
  /** Theme name used while the app is in light mode. */
  lightTheme: string;
  /** Theme name used while the app is in dark mode. */
  darkTheme: string;
  /** CSS font-family stack for the editor's text. Empty means the built-in default. */
  fontFamily: string;
  /** Editor text size in px. */
  fontSize: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Whether the line-number gutter is shown. */
  lineNumbers: boolean;
  /** Whether the activity bar carries an "Extensions" view beside Explorer and Search. */
  extensionsView: boolean;
};

const STORAGE_KEY = "editor-prefs";

/** The stack codelet ships with; shown as the placeholder when the field is blank. */
export const DEFAULT_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Bounds the number fields are clamped to, so a stray keystroke cannot break the layout. */
export const FONT_SIZE_RANGE = { min: 10, max: 28 } as const;
export const LINE_HEIGHT_RANGE = { min: 1, max: 3 } as const;

/** First entries of each palette are codelet's own defaults for that side. */
export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  lightTheme: themesFor(false)[0]?.name ?? "",
  darkTheme: themesFor(true)[0]?.name ?? "",
  fontFamily: "",
  fontSize: 13,
  lineHeight: 1.5,
  lineNumbers: true,
  extensionsView: true,
};

/** Reads the stored preferences, falling back per field so a partial write still loads. */
export function loadEditorPrefs(): EditorPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_EDITOR_PREFS };
    const parsed = JSON.parse(raw) as Partial<EditorPrefs>;
    return { ...DEFAULT_EDITOR_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_EDITOR_PREFS };
  }
}

export function saveEditorPrefs(prefs: EditorPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A failed write only means the choice is not remembered next time.
  }
}

/**
 * Calls `onChange` when another window writes the preferences. Returns the
 * unsubscribe.
 *
 * A `storage` event never fires in the document that made the write, so this is
 * exactly the direction that matters: the settings window changes a theme, and
 * an editor open in the main window repaints.
 */
export function subscribeEditorPrefs(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/**
 * The theme to paint an editor with right now: the slot for the current mode,
 * or the other side's default when a stored name no longer matches a theme.
 */
export function themeForMode(dark: boolean): Theme {
  const prefs = loadEditorPrefs();
  const name = dark ? prefs.darkTheme : prefs.lightTheme;
  return themeNamed(name) ?? themesFor(dark)[0];
}
