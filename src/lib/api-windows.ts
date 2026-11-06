import { emit } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { API_CLIENT_WINDOW_PATH, API_HOME_EVENT } from "@/lib/api-routes";
import { createWindow, showWindow } from "@/lib/window";
import { hashedWindowLabel } from "@/lib/window-label";

/** One window per workspace; the id is hashed, see `@/lib/window-label`. */
const API_WORKSPACE_PREFIX = "api-ws-";

export function apiWorkspaceWindowLabel(workspaceId: string) {
  return hashedWindowLabel(API_WORKSPACE_PREFIX, workspaceId);
}

/**
 * Show `workspaceId` in a window of its own, creating it if this is the first
 * time. A window with that label already on screen is focused instead, which is
 * what makes opening the same workspace twice idempotent.
 *
 * The workspace id travels in the query string, not the label, because the
 * label is a hash. `main.tsx` routes on `pathname` only, so the query is
 * ignored there and the window's page reads it itself.
 */
export async function openApiWorkspaceWindow(workspaceId: string, name: string) {
  const id = workspaceId.trim();
  const label = apiWorkspaceWindowLabel(id);

  await createWindow(label, {
    title: name,
    url: `${API_CLIENT_WINDOW_PATH}?id=${encodeURIComponent(id)}`,
    width: 1280,
    height: 800,
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
 * The labels of the workspace windows that are already open. Callers compare
 * them against `apiWorkspaceWindowLabel(id)` to mark a workspace as open. There
 * is no backend event for a workspace window closing — it is a plain window,
 * not a plugin host — so callers re-scan on mount and on focus instead of
 * subscribing.
 */
export async function openApiWorkspaceWindowLabels() {
  try {
    const windows = await getAllWebviewWindows();
    return windows
      .map((window) => window.label)
      .filter((label) => label.startsWith(API_WORKSPACE_PREFIX));
  } catch (error) {
    console.error("Failed to list open workspace windows:", error);
    return [];
  }
}

/**
 * Ask the main window — which owns the picker route — to show it, and bring it
 * to the front. Called from a workspace window, whose own page has no picker.
 */
export async function showApiHome() {
  await emit(API_HOME_EVENT);
  await showWindow("main");
}
