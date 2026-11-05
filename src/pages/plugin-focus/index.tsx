import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { pluginsBrowserCloseAll } from "@/commands";
import { AppShell } from "@/components/app-shell";
import { PluginPanel } from "@/components/plugin-panel";
import { usePluginsStore } from "@/hooks/use-plugins-store";
import { usePluginsUp } from "@/hooks/use-plugins-up";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { DOCUMENT_ID } from "@/lib/document-id";
import { usePageActive } from "@/lib/page-active";

/** The plugin this page was opened for, from its own URL. */
function pluginIdFromUrl(): string {
  return new URLSearchParams(window.location.search).get("id") ?? "";
}

/**
 * One plugin, filling the main window with no tab bar.
 *
 * This is where a sidebar plugin's entry lands: the sidebar navigates to
 * `/plugin-focus?id=<pluginId>`, so a plugin switched to sidebar mode shows as
 * the whole page rather than as a tab among many.
 */
export default function PluginFocusPage() {
  const { t } = useAppTranslation();
  const { plugins, loaded } = usePluginsStore();
  // The plugin this page was opened for, kept from its first render: with page
  // caching on the page outlives the URL that opened it.
  const [id] = useState(pluginIdFromUrl);
  const visible = usePageActive();

  const plugin = plugins.find((item) => item.id === id) ?? null;
  // Usable only if it can actually render a page: readable, enabled, and
  // pointing at one.
  const usable = plugin !== null && plugin.error === null && plugin.enabled && plugin.ui !== null;

  const { up, known, refresh } = usePluginsUp(plugins);

  // Navigating away in-app unmounts this page, and `PluginBrowser`'s own cleanup
  // releases the webview then. This listener is the safety net for the case that
  // has no cleanup: the window itself going away, which would otherwise leave the
  // native webview painted over whatever comes next. Scoped to this window and
  // this page load, so a late call cannot reach a later document.
  useEffect(() => {
    const closePages = () =>
      void pluginsBrowserCloseAll("main", DOCUMENT_ID).catch((error: unknown) =>
        console.error("Failed to close plugin pages:", error)
      );

    window.addEventListener("pagehide", closePages);
    return () => window.removeEventListener("pagehide", closePages);
  }, []);

  if (!loaded) {
    return (
      <AppShell>
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t("pluginPanel.loading")}
        </div>
      </AppShell>
    );
  }

  if (!plugin || !usable) {
    return (
      <AppShell>
        <div className="text-muted-foreground text-sm">{t("pluginFocus.missing")}</div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
        <PluginPanel
          plugin={plugin}
          active={visible}
          up={up?.has(plugin.id) ?? false}
          known={known}
          onUpChanged={refresh}
        />
      </section>
    </AppShell>
  );
}
