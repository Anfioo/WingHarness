/** The tabs the Scoop page can show; `install` is the pre-install screen. */
export type ScoopTab = "overview" | "search" | "buckets" | "tray" | "diagnostics" | "settings";

const SCOOP_TABS: ScoopTab[] = ["overview", "search", "buckets", "tray", "diagnostics", "settings"];

/** Event another window sends to the main window to select a Scoop tab. */
export const SCOOP_TAB_EVENT = "scoop-select-tab";

export function isScoopTab(value: unknown): value is ScoopTab {
  return typeof value === "string" && SCOOP_TABS.includes(value as ScoopTab);
}

/** The tab named by `?tab=` in a location's search string, if it is one. */
export function scoopTabFromSearch(search: string): ScoopTab | null {
  const value = new URLSearchParams(search).get("tab");
  return isScoopTab(value) ? value : null;
}
