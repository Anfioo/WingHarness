import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { pluginsList, type PluginView } from "@/commands";
import { PluginPanel } from "@/components/plugin-panel";
import { TitleBar } from "@/components/title-bar";
import { Skeleton } from "@/components/ui/skeleton";
import { WindowFrame } from "@/components/window-frame";
import { usePluginsUp } from "@/hooks/use-plugins-up";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** The plugin this window was opened for, from its own URL. */
function pluginIdFromUrl(): string {
  return new URLSearchParams(window.location.search).get("id") ?? "";
}

/**
 * One plugin's page in its own OS window.
 *
 * Opened from a plugin tab's right-click menu as `/plugin-window?id=<id>`. The
 * window is frameless and transparent, so `WindowFrame` supplies the chrome and
 * the message below is rendered inside it: an unmounted tree in a transparent
 * window does not read as a crash, it reads as a window that opens and then
 * vanishes with nothing to go on.
 *
 * `host` is passed explicitly so the native webview attaches to **this**
 * window — the same plugin can be open in the main window at the same time
 * without the two views colliding.
 *
 * The plugins page learns this window is open when it opens it, and learns it is
 * gone from the `plugin-window-closed` event the backend emits on destruction —
 * so this window announces nothing itself.
 */
export default function PluginWindow() {
  const { t } = useAppTranslation();
  const [id] = useState(pluginIdFromUrl);
  const [plugin, setPlugin] = useState<PluginView | null>(null);
  const [failed, setFailed] = useState(false);
  const host = getCurrentWebviewWindow().label;

  useEffect(() => {
    let cancelled = false;

    pluginsList()
      .then((list) => {
        if (cancelled) return;
        const found = list.find((item) => item.id === id);
        // A plugin with no page to show cannot fill this window; treat it the
        // same as one that is not installed.
        if (!found || found.error !== null || !found.enabled || found.ui === null) {
          setFailed(true);
          return;
        }
        setPlugin(found);
      })
      .catch((error: unknown) => {
        console.error("Failed to load the plugin:", error);
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  // Only this one plugin is shown here, so the watch is just its own address.
  const { up, known, refresh } = usePluginsUp(plugin ? [plugin] : []);

  return (
    <WindowFrame
      titleBar={<TitleBar title={t("pluginWindow.title")} showPin showMaximize />}
      contentClassName="flex flex-1 min-h-0 flex-col overflow-hidden"
    >
      {failed ? (
        <div className="text-muted-foreground p-4 text-sm">{t("pluginFocus.missing")}</div>
      ) : plugin === null ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      ) : (
        <PluginPanel
          plugin={plugin}
          active
          up={up?.has(plugin.id) ?? false}
          known={known}
          onUpChanged={refresh}
          host={host}
        />
      )}
    </WindowFrame>
  );
}
