import { useMemo } from "react";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRouter } from "@/lib/router";
import { WelcomeView } from "./welcome-view";
import { WorkspaceView } from "./workspace-view";

/** The working copy this window was opened for, taken from its own URL. */
function workspaceFromUrl(search: string) {
  return new URLSearchParams(search).get("path") ?? "";
}

/** Last path segment, used as the window title until the copy loads. */
function baseName(path: string) {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/**
 * A working copy's window. It is its own window and draws its own frame
 * (`WindowFrame` + `TitleBar`), and the working copy it shows comes from
 * `?path=`. Without one it falls back to the no-workspace guidance, which is
 * what a window opened by hand shows.
 */
export default function SvnWorkspaceWindow() {
  const { t } = useAppTranslation();
  const { search } = useRouter();
  const path = useMemo(() => workspaceFromUrl(search), [search]);
  const title = path ? baseName(path) : t("svnWorkspace.welcome.window.title");

  return (
    <WindowFrame
      titleBar={<TitleBar title={title} showPin showMaximize closeOnEscape={!path} />}
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      {path ? <WorkspaceView path={path} /> : <WelcomeView />}
    </WindowFrame>
  );
}
