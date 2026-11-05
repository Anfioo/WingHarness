/**
 * The systools feature's picker: one page of the main window holding six
 * independent tools as top tabs.
 */
export const SYSTOOLS_PATH = "/systools";

/**
 * The systools window. `main.tsx` routes on `pathname` alone and decides
 * shell-or-window from the same string, so the window cannot share the page's
 * route: it needs a pathname of its own to stay out of the app shell. Which tab
 * it shows travels in the query.
 */
export const SYSTOOLS_WINDOW_PATH = "/systools-window";

export type SystoolsTab =
  | "startup"
  | "uninstall"
  | "optimize"
  | "analysis"
  | "duplicates"
  | "largeFiles";

export const SYSTOOLS_TABS: readonly SystoolsTab[] = [
  "startup",
  "uninstall",
  "optimize",
  "analysis",
  "duplicates",
  "largeFiles",
] as const;

export function isSystoolsTab(value: unknown): value is SystoolsTab {
  return typeof value === "string" && (SYSTOOLS_TABS as readonly string[]).includes(value);
}

/** Read the tab a URL asked for, falling back to the first one. */
export function readSystoolsTab(search: string): SystoolsTab {
  const value = new URLSearchParams(search).get("tab");
  return isSystoolsTab(value) ? value : "startup";
}
