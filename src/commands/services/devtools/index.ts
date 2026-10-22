import { invokeCommand } from "../../base";

/**
 * Opens the WebView inspector of the calling window.
 *
 * Dev-only: a build without the inspector answers with an error rather than
 * doing nothing, which is what the window context menu's item would surface.
 */
export function openDevtools(): Promise<void> {
  return invokeCommand("open_devtools", {});
}