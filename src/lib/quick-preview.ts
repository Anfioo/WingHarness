import { emit } from "@tauri-apps/api/event";
import { createWindow } from "@/lib/window";

/** The route and window label of the quick look; the capability lists the label. */
export const QUICK_PREVIEW_PATH = "/quick-preview";
export const QUICK_PREVIEW_LABEL = "quick-preview";

/**
 * Sent to a quick-look window that already exists. A reused window keeps the
 * URL it was created with, so the new target travels as an event instead.
 */
export const QUICK_PREVIEW_OPEN_EVENT = "quick-preview-open";

/** The file or folder a quick look shows. */
export interface QuickPreviewTarget {
  /** The project the target path is rooted in. */
  root: string;
  /** `/`-rooted path inside that project. */
  path: string;
  name: string;
  kind: "file" | "directory";
}

/**
 * Shows a file or folder in the quick-look window, creating the window the
 * first time. The window is transient — closing it destroys it, and it is never
 * recorded as a project or a tab.
 *
 * A file is shown as the preview pane alone; a folder is shown as the file tree
 * with a preview beside it, which is the file preview page without its picker.
 */
export async function openQuickPreview(target: QuickPreviewTarget) {
  const query = new URLSearchParams({
    root: target.root,
    path: target.path,
    name: target.name,
    kind: target.kind,
  });

  await createWindow(QUICK_PREVIEW_LABEL, {
    title: target.name,
    url: `${QUICK_PREVIEW_PATH}?${query.toString()}`,
    width: 960,
    height: 720,
    minWidth: 480,
    minHeight: 320,
    resizable: true,
    maximizable: true,
    minimizable: true,
    // Every window of this app draws its own frame (`WindowFrame` + `TitleBar`),
    // so the native one has to stay off or the bars would stack.
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    shadow: false,
    // Center it over the window whose file it is showing.
    parent: "main",
  });

  // The first creation reads the target from its URL; a window that already
  // exists is only shown by `createWindow`, so it is told here.
  await emit(QUICK_PREVIEW_OPEN_EVENT, target);
}

/** The target a quick-look window was opened for, taken from its own URL. */
export function quickPreviewTargetFromUrl(search: string): QuickPreviewTarget | null {
  const params = new URLSearchParams(search);
  const root = params.get("root") ?? "";
  const path = params.get("path") ?? "";
  if (!root || !path) return null;

  const name = params.get("name") || path.split("/").filter(Boolean).pop() || path;
  return {
    root,
    path,
    name,
    kind: params.get("kind") === "directory" ? "directory" : "file",
  };
}
