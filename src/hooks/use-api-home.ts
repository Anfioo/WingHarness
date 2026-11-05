import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { API_HOME_EVENT, openApiClientHome } from "@/lib/api-routes";

/**
 * Show the API client picker when a workspace window asks for it. The picker is
 * a page of the main window, so only that window owns the route and acts on the
 * event; every other window ignores it.
 */
export function useApiHome(): void {
  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "main") return;
    const unlisten = listen(API_HOME_EVENT, () => {
      openApiClientHome();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
