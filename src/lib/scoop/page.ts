import type { ScoopEnvVar, ScoopLocation, ScoopProxyMode, ScoopStatus } from "@/commands";

/** One remembered folder choice. */
export interface ScoopPathPrefs {
  location: ScoopLocation;
  customPath: string;
}

/** What the install tab remembers between visits. */
export interface ScoopPrefs {
  /** The normal `scoop` folder behind `ScoopCurrent`. */
  scoop: ScoopPathPrefs;
  /** The global `scoopg` folder behind `ScoopGlobalCurrent`. */
  global: ScoopPathPrefs;
  proxyMode: ScoopProxyMode;
  proxyUrl: string;
}

/** Which of the two roots a path belongs to. */
export type ScoopPathKind = "scoop" | "global";

/** A run handed to the terminal: one script, its folder and its environment. */
export interface ScoopRun {
  id: number;
  command: string;
  cwd: string;
  env: Record<string, string>;
}

const PREFS_KEY = "scoop-page-prefs";

/**
 * The default folder follows the app's data directory, which is the choice the
 * page preselected when the feature was specified. The proxy follows Settings.
 */
export const DEFAULT_SCOOP_PREFS: ScoopPrefs = {
  scoop: { location: "data", customPath: "" },
  global: { location: "data", customPath: "" },
  proxyMode: "inherit",
  proxyUrl: "",
};

const LOCATIONS: ScoopLocation[] = ["data", "user", "custom"];
const PROXY_MODES: ScoopProxyMode[] = ["inherit", "none", "custom"];

/** A stored value, or the default, with the legacy flat shape migrated. */
function readPath(
  value: unknown,
  legacy: { location?: unknown; customPath?: unknown } | undefined,
  fallback: ScoopPathPrefs
): ScoopPathPrefs {
  if (value && typeof value === "object") {
    const entry = value as Partial<ScoopPathPrefs>;
    return {
      location: LOCATIONS.includes(entry.location as ScoopLocation)
        ? (entry.location as ScoopLocation)
        : fallback.location,
      customPath: typeof entry.customPath === "string" ? entry.customPath : fallback.customPath,
    };
  }
  // Before the two folders were split, one choice covered both. It now seeds
  // the normal folder; the global one starts at its default.
  if (legacy && legacy.location !== undefined) {
    return {
      location: LOCATIONS.includes(legacy.location as ScoopLocation)
        ? (legacy.location as ScoopLocation)
        : fallback.location,
      customPath: typeof legacy.customPath === "string" ? legacy.customPath : fallback.customPath,
    };
  }
  return fallback;
}

export function loadScoopPrefs(): ScoopPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<ScoopPrefs> & {
      location?: unknown;
      customPath?: unknown;
    };
    return {
      scoop: readPath(parsed.scoop, parsed, DEFAULT_SCOOP_PREFS.scoop),
      global: readPath(parsed.global, undefined, DEFAULT_SCOOP_PREFS.global),
      proxyMode: PROXY_MODES.includes(parsed.proxyMode as ScoopProxyMode)
        ? (parsed.proxyMode as ScoopProxyMode)
        : DEFAULT_SCOOP_PREFS.proxyMode,
      proxyUrl:
        typeof parsed.proxyUrl === "string" ? parsed.proxyUrl : DEFAULT_SCOOP_PREFS.proxyUrl,
    };
  } catch {
    return DEFAULT_SCOOP_PREFS;
  }
}

export function saveScoopPrefs(prefs: ScoopPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // View state only: a full or disabled storage must not break the page.
  }
}

/** Turns the plan's variable list into what `local_shell_start` expects. */
export function envRecord(values: ScoopEnvVar[]): Record<string, string> {
  return Object.fromEntries(values.map((entry) => [entry.name, entry.value]));
}

/** Lexical comparison, the same rule the backend uses for the link decision. */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

/** Joins with a backslash; every path here is a Windows path. */
export function joinWindows(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")
    )
    .join("\\");
}

/**
 * The real folder the current choice would install into.
 *
 * The data and user presets keep the folder names the page documents:
 * `scoop` for `SCOOP` and `scoopg` for `SCOOP_GLOBAL`.
 */
export function chosenPath(
  kind: ScoopPathKind,
  choice: ScoopPathPrefs,
  status: ScoopStatus | null
): string {
  switch (choice.location) {
    case "user":
      return (kind === "scoop" ? status?.userDir : status?.userGlobalDir) ?? "";
    case "custom":
      return choice.customPath.trim();
    default:
      return status ? joinWindows(status.dataDir, kind === "scoop" ? "scoop" : "scoopg") : "";
  }
}

/**
 * The proxy label the page shows and the backend will log. Mirrors the
 * backend's resolution so the summary is meaningful before anything runs.
 */
export function proxySummary(
  prefs: ScoopPrefs,
  status: ScoopStatus | null
): { mode: "none" | "system" | "custom"; url: string | null; source: "settings" | "page" } {
  if (prefs.proxyMode === "none") return { mode: "none", url: null, source: "page" };
  if (prefs.proxyMode === "custom") {
    const url = prefs.proxyUrl.trim();
    return url
      ? {
          mode: "custom",
          url: url.includes("://") ? url : `http://${url}`,
          source: "page",
        }
      : { mode: "none", url: null, source: "page" };
  }
  return status?.proxy ?? { mode: "none", url: null, source: "settings" };
}
