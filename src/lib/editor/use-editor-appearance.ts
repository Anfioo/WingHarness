import { useCallback, useEffect, useState } from "react";
import type { Theme } from "codelet";
import { appShellTheme } from "./app-theme";
import { isDarkMode, watchColorMode } from "./themes";
import { loadEditorPrefs, subscribeEditorPrefs, type EditorPrefs } from "./prefs";
import { applyEditorTypography } from "./typography";

/**
 * The editor's whole appearance, kept current: the theme to paint with and the
 * preferences behind it.
 *
 * The theme covers both halves of a workbench — its chrome follows the app's own
 * theme, while the syntax colours inside the tabs stay the Settings → Editor
 * choice. Everything re-resolves when the app's colour scheme changes, or when
 * the settings window writes a new choice, so a surface mounting an editor holds
 * the values it is handed rather than tracking where they came from.
 *
 * The caller must give the element wrapping its editor the `editor-surface`
 * class for the typography to reach it — codelet offers no option for a font, so
 * it arrives as a scoped stylesheet instead.
 */
export function useEditorAppearance(): { theme: Theme; prefs: EditorPrefs } {
  const [theme, setTheme] = useState<Theme>(() => appShellTheme(isDarkMode()));
  const [prefs, setPrefs] = useState<EditorPrefs>(() => loadEditorPrefs());

  // A passive effect, not a layout one, and deliberately so: the shell theme
  // reads variables the app's provider writes in its own layout effect, which
  // has not run yet by the time render or a child layout effect gets here.
  const refresh = useCallback(() => {
    applyEditorTypography();
    setTheme(appShellTheme(isDarkMode()));
    setPrefs(loadEditorPrefs());
  }, []);

  useEffect(() => {
    refresh();
    const unwatchMode = watchColorMode(refresh);
    const unwatchPrefs = subscribeEditorPrefs(refresh);
    return () => {
      unwatchMode();
      unwatchPrefs();
    };
  }, [refresh]);

  return { theme, prefs };
}
