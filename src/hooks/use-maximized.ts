import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * Whether the current window is maximized, re-read on every resize.
 *
 * Both the window frame (to drop the rounded corners when maximized) and the
 * title bar (to pick the maximize/restore icon) need this, so the subscription
 * lives here once. Pass `enabled = false` when nothing reads it.
 */
export function useMaximized(enabled = true): boolean {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    const appWindow = getCurrentWebviewWindow();
    appWindow.isMaximized().then(setIsMaximized);

    const unlisten = appWindow.onResized(async () => {
      setIsMaximized(await appWindow.isMaximized());
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [enabled]);

  return isMaximized;
}
