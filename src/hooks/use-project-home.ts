import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PROJECT_HOME_EVENT, openProjectHome } from "@/lib/project-routes";

/**
 * Show the project picker when a project window asks for it. The picker is a
 * page of the main window, so only that window owns the route and acts on the
 * event; every other window ignores it.
 */
export function useProjectHome(): void {
  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "main") return;
    const unlisten = listen(PROJECT_HOME_EVENT, () => {
      openProjectHome();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
