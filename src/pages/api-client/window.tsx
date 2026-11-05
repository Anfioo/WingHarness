import { useMemo } from "react";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRouter } from "@/lib/router";
import { WelcomeView } from "./welcome-view";
import { WorkspaceView } from "./workspace-view";

/** The workspace this window was opened for, taken from its own URL. */
function workspaceFromUrl(search: string) {
  return new URLSearchParams(search).get("id") ?? "";
}

/**
 * A workspace window. It is its own window and draws its own frame
 * (`WindowFrame` + `TitleBar`), and the workspace it shows comes from `?id=`.
 * Without one it falls back to the welcome guidance, which is what a window
 * opened by hand shows.
 */
export default function ApiClientWindow() {
  const { t } = useAppTranslation();
  const { search } = useRouter();
  const id = useMemo(() => workspaceFromUrl(search), [search]);

  return (
    <WindowFrame
      titleBar={
        <TitleBar
          title={t("apiClient.welcome.window.title")}
          showPin
          showMaximize
          closeOnEscape={!id}
        />
      }
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      {id ? <WorkspaceView workspaceId={id} /> : <WelcomeView />}
    </WindowFrame>
  );
}
