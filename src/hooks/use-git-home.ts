import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { GIT_HOME_EVENT, openGitRepoHome } from "@/lib/git-routes";

/**
 * Show the Git picker when a repository window asks for it. The picker is a
 * page of the main window, so only that window owns the route and acts on the
 * event; every other window ignores it.
 */
export function useGitHome(): void {
  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "main") return;
    const unlisten = listen(GIT_HOME_EVENT, () => {
      openGitRepoHome();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
