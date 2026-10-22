/** User-configurable terminal appearance & behavior preferences. */
export type TerminalPrefs = {
  fontFamily: string;
  fontSize: number; // px
  tabStopWidth: number;
  autoWrap: boolean;
  highlightCurrentLine: boolean;
};

const STORAGE_KEY = "local-terminal-prefs";

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontFamily: "Consolas",
  fontSize: 14,
  tabStopWidth: 4,
  autoWrap: true,
  highlightCurrentLine: true,
};

/**
 * The picker stores a single family name; earlier builds stored a whole CSS
 * stack, so collapse a legacy value to its leading family.
 */
function normalizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TERMINAL_PREFS.fontFamily;
  const first = value
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
  return first || DEFAULT_TERMINAL_PREFS.fontFamily;
}

export function loadTerminalPrefs(): TerminalPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TERMINAL_PREFS };
    const parsed = JSON.parse(raw) as Partial<TerminalPrefs>;
    return {
      ...DEFAULT_TERMINAL_PREFS,
      ...parsed,
      fontFamily: normalizeFontFamily(parsed.fontFamily),
    };
  } catch {
    return { ...DEFAULT_TERMINAL_PREFS };
  }
}

export function saveTerminalPrefs(prefs: TerminalPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
