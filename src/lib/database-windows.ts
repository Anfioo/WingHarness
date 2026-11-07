import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { DATABASE_WINDOW_PATH } from "@/lib/database-routes";
import { createWindow } from "@/lib/window";
import { hashedWindowLabel } from "@/lib/window-label";

/** One window per data source; the id is hashed, see `@/lib/window-label`. */
const DATABASE_PREFIX = "database-";

export function databaseWindowLabel(id: string) {
  return hashedWindowLabel(DATABASE_PREFIX, id);
}

/**
 * Show `id` in a window of its own, creating it if this is the first time. A
 * window with that label already on screen is focused instead, which is what
 * makes opening the same data source twice idempotent.
 *
 * The data source id travels in the query string, not the label, because the
 * label is a hash. `main.tsx` routes on `pathname` only, so the query is
 * ignored there and the window's page reads it itself.
 *
 * `root` is the project the window should work against: a project-scoped data
 * source lives under its own root, and an app-wide one with a relative SQLite
 * path resolves against the project the page had selected. Its own JS context
 * means the new window cannot inherit that from the page that opened it.
 */
export async function openDatabaseWindow(id: string, name: string, root = "") {
  const label = databaseWindowLabel(id);
  const query = new URLSearchParams({ source: id });
  if (root) query.set("root", root);

  await createWindow(label, {
    title: name,
    url: `${DATABASE_WINDOW_PATH}?${query.toString()}`,
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    resizable: true,
    maximizable: true,
    minimizable: true,
    // Every window of this app draws its own frame (`WindowFrame` + `TitleBar`),
    // so the native one has to stay off or the bars would stack.
    decorations: false,
    transparent: true,
    shadow: false,
  });

  return label;
}

/**
 * The labels of the data source windows that are already open. Callers compare
 * them against `databaseWindowLabel(id)` to mark a data source as open. There is
 * no backend event for one of these windows closing — it is a plain window, not
 * a plugin host — so callers re-scan on mount and on focus instead.
 */
export async function openDatabaseWindowLabels() {
  try {
    const windows = await getAllWebviewWindows();
    return windows
      .map((window) => window.label)
      .filter((label) => label.startsWith(DATABASE_PREFIX));
  } catch (error) {
    console.error("Failed to list open data source windows:", error);
    return [];
  }
}
