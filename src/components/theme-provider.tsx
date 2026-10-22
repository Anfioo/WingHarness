import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";
import { applyThemePreset } from "@/lib/theme/apply";
import { applyThemeFonts } from "@/lib/theme/fonts";
import { DEFAULT_PRESET_ID } from "@/lib/theme/presets";
import type { ColorMode } from "@/lib/theme/types";

type Theme = "dark" | "light" | "system";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  defaultPreset?: string;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** The selected theme preset: one of `THEME_PRESETS`, or the built-in default. */
  preset: string;
  setPreset: (preset: string) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  setTheme: () => null,
  preset: DEFAULT_PRESET_ID,
  setPreset: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

/** The mode a theme class resolves to, following the OS when the theme is "system". */
export function resolveMode(theme: Theme): ColorMode {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "vite-ui-theme",
  defaultPreset = DEFAULT_PRESET_ID,
  ...props
}: ThemeProviderProps) {
  // Derived rather than a prop of its own: the preset is the other half of the
  // same choice, and the two keys drifting apart would strand one of them.
  const presetStorageKey = `${storageKey}-preset`;

  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
  );
  const [preset, setPreset] = useState<string>(
    () => localStorage.getItem(presetStorageKey) || defaultPreset
  );

  // Layout effect, not effect: both the mode class and the preset's variables
  // are what the first paint is supposed to show, and a frame of the default
  // theme before them would be visible.
  useLayoutEffect(() => {
    const root = window.document.documentElement;
    const mode = resolveMode(theme);
    root.classList.remove("light", "dark");
    root.classList.add(mode);
    applyThemePreset(preset, mode);
  }, [theme, preset]);

  // Fonts are fetched, so they arrive after the fact — the theme's own stacks
  // cover the gap, which is also what shows when a download is impossible.
  useEffect(() => {
    void applyThemeFonts(preset, resolveMode(theme));
  }, [theme, preset]);

  // Listen for localStorage changes to sync theme and preset across windows
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === storageKey && e.newValue) {
        setTheme(e.newValue as Theme);
      }
      if (e.key === presetStorageKey && e.newValue) {
        setPreset(e.newValue);
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, [storageKey, presetStorageKey]);

  const value = {
    theme,
    setTheme: (newTheme: Theme) => {
      localStorage.setItem(storageKey, newTheme);
      setTheme(newTheme);
    },
    preset,
    setPreset: (newPreset: string) => {
      localStorage.setItem(presetStorageKey, newPreset);
      setPreset(newPreset);
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
};
