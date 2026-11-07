import { emit } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { PROJECT_HOME_EVENT, PROJECT_WINDOW_PATH } from "@/lib/project-routes";
import { createWindow, showWindow } from "@/lib/window";
import { hashedWindowLabel } from "@/lib/window-label";

/**
 * One window per project; the normalized path is hashed, see
 * `@/lib/window-label`. The prefix must stay `project-`: the Tauri capability
 * grants the window pattern `project-*`, and any other prefix makes the window
 * fail to open at runtime.
 */
const PROJECT_WINDOW_PREFIX = "project-";

/**
 * Paths that differ only by separator, trailing slash or case are the same
 * folder on Windows, and must therefore produce the same window label.
 */
export function normalizeProjectPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function projectWindowLabel(root: string) {
  return hashedWindowLabel(PROJECT_WINDOW_PREFIX, normalizeProjectPath(root));
}

/**
 * Show `root` in a window of its own, creating it if this is the first time. A
 * window with that label already on screen is focused instead, which is what
 * makes opening the same project twice idempotent — and what lets two projects
 * be open at the same time, each in its own window.
 *
 * The path travels in the query string, not the label, because the label is a
 * hash. `main.tsx` routes on `pathname` only, so the query is ignored there and
 * the window's page reads it itself.
 */
export async function openProjectWindow(root: string) {
  const path = root.trim();
  const label = projectWindowLabel(path);

  await createWindow(label, {
    title: projectTitle(path),
    url: `${PROJECT_WINDOW_PATH}?path=${encodeURIComponent(path)}`,
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
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
 * The labels of the project windows that are already open. Callers compare them
 * against `projectWindowLabel(path)` to mark a project as open. There is no
 * backend event for a project window closing — it is a plain window — so
 * callers re-scan on mount and on focus instead of subscribing.
 */
export async function openProjectWindowLabels() {
  try {
    const windows = await getAllWebviewWindows();
    return windows
      .map((window) => window.label)
      .filter((label) => label.startsWith(PROJECT_WINDOW_PREFIX));
  } catch (error) {
    console.error("Failed to list open project windows:", error);
    return [];
  }
}

/**
 * Ask the main window — which owns the picker route — to show it, and bring it
 * to the front. Called from a project window, whose own page has no picker.
 */
export async function showProjectHome() {
  await emit(PROJECT_HOME_EVENT);
  await showWindow("main");
}

/** Last path segment, used as the window title. */
export function projectTitle(path: string) {
  const parts = normalizeProjectPath(path).split("/");
  return parts[parts.length - 1] || path;
}
