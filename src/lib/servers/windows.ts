import { emitTo } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createWindow, showWindow } from "@/lib/window";

/**
 * The server manager is one window for the whole app. Unlike the Git and SVN
 * windows its label is fixed: every server is a tab inside it, so opening a
 * profile never stacks a second window.
 */
export const SERVER_WINDOW_LABEL = "server-manager";

/**
 * The window's own pathname. `main.tsx` decides shell-or-window from the
 * pathname alone, so the window cannot share the picker's `/servers` route.
 * The profile to focus on first travels in `?profile=`.
 */
export const SERVER_WINDOW_PATH = "/server-window";

/**
 * Tells an already-open window which profile to add or focus. The frontend has
 * no cross-window navigation API, so the profile id travels as an event rather
 * than a document reload.
 */
export const SERVER_OPEN_PROFILE_EVENT = "server-open-profile";

/** Payload of {@link SERVER_OPEN_PROFILE_EVENT}. */
export type ServerOpenProfilePayload = { profileId: string };

/**
 * Show the server manager window, creating it the first time.
 *
 * Opening the same profile twice focuses the existing tab instead of opening a
 * second connection: the window dedupes by profile id.
 */
export async function openServerWindow(profileId: string): Promise<void> {
  const existing = await WebviewWindow.getByLabel(SERVER_WINDOW_LABEL);
  if (existing) {
    await showWindow(SERVER_WINDOW_LABEL);
    await emitTo(SERVER_WINDOW_LABEL, SERVER_OPEN_PROFILE_EVENT, { profileId });
    return;
  }

  await createWindow(SERVER_WINDOW_LABEL, {
    title: "Server manager",
    url: `${SERVER_WINDOW_PATH}?profile=${encodeURIComponent(profileId)}`,
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    resizable: true,
    minimizable: true,
    maximizable: true,
    // Every window of this app draws its own frame (`WindowFrame` + `TitleBar`),
    // so the native one has to stay off or the bars would stack.
    decorations: false,
    transparent: true,
    shadow: false,
  });
}
