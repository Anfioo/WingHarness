import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openSvnHome, SVN_HOME_EVENT } from "@/lib/svn-routes";

/**
 * Show the SVN picker when a working-copy window asks for it. The picker is a
 * page of the main window, so only that window owns the route and acts on the
 * event; every other window ignores it.
 */
export function useSvnHome(): void {
  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "main") return;
    const unlisten = listen(SVN_HOME_EVENT, () => {
      openSvnHome();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
