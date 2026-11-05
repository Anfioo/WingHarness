import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Package } from "lucide-react";
import { pluginsBrowserCloseAll, type PluginView } from "@/commands";
import { AppShell } from "@/components/app-shell";
import { PluginPanel } from "@/components/plugin-panel";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { usePluginsUp } from "@/hooks/use-plugins-up";
import { usePluginWindows } from "@/hooks/use-plugin-windows";
import { usePluginsStore } from "@/hooks/use-plugins-store";
import { useSidebarStore } from "@/hooks/use-sidebar-store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { DOCUMENT_ID } from "@/lib/document-id";
import { usePageActive } from "@/lib/page-active";
import { placedIds } from "@/lib/sidebar-config";
import { cn } from "@/lib/utils";

/** Plugins that can fill a pane: readable, enabled, and pointing at a page. */
function panelable(plugins: PluginView[]): PluginView[] {
  return plugins.filter(
    (plugin) => plugin.error === null && plugin.enabled && (plugin.ui?.length ?? 0) > 0
  );
}

export default function PluginsPage() {
  const { t } = useAppTranslation();
  const { plugins: allPlugins, loaded } = usePluginsStore();
  const { config } = useSidebarStore();

  // Only plugins shown as tabs: one the sidebar manager placed in the layout has
  // no tab here — the sidebar is its entry point.
  const plugins = useMemo(() => {
    const placed = config ? placedIds(config).plugins : new Set<string>();
    return panelable(allPlugins).filter((plugin) => !placed.has(plugin.id));
  }, [allPlugins, config]);

  const [activeId, setActiveId] = useState<string | null>(null);
  // Panes start lazily: a plugin should not be launched by a visit to a tab the
  // user never opened. Once visited a pane stays mounted, so switching tabs does
  // not reload the plugin's page and lose whatever was on it.
  const [visited, setVisited] = useState<string[]>([]);
  // Which plugins are up, shared by every pane. Decided by whether each plugin's
  // address answers, so a page served by an instance this app did not start
  // still counts as running.
  const { up, known: upKnown, refresh: refreshUp } = usePluginsUp(allPlugins);
  // Plugin pages open in their own window: their tab is greyed out here.
  const { openIds, openWindow } = usePluginWindows();
  // A native webview stays painted while this page is cached but off screen.
  const pageActive = usePageActive();

  // Keep the selection valid as plugins come and go (a tab moved to the sidebar
  // removes itself from this list).
  useEffect(() => {
    if (plugins.length === 0) return;
    if (activeId && plugins.some((plugin) => plugin.id === activeId)) return;
    const first = plugins[0].id;
    setActiveId(first);
    setVisited((current) => (current.includes(first) ? current : [...current, first]));
  }, [plugins, activeId]);

  // The sidebar navigates with plain links, so leaving this page is a full
  // document load and no React cleanup runs. A plugin's page is a native
  // webview owned by the window, which means it would outlive the page that
  // asked for it and stay painted over whatever came next — so it is closed
  // here, on the way out. Scoped both to this window and to this page load: a
  // page open in a plugin's own window is not ours to close, and a call that
  // lands after the next page has begun opening its own pages must not reach
  // them.
  useEffect(() => {
    const closePages = () =>
      void pluginsBrowserCloseAll("main", DOCUMENT_ID).catch((error: unknown) =>
        console.error("Failed to close plugin pages:", error)
      );

    window.addEventListener("pagehide", closePages);
    return () => window.removeEventListener("pagehide", closePages);
  }, []);

  const select = useCallback((id: string) => {
    setActiveId(id);
    setVisited((current) => (current.includes(id) ? current : [...current, id]));
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

  if (plugins.length === 0) {
    return (
      <AppShell>
        <div className="border-border flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center">
          <Package className="text-muted-foreground size-8" />
          <p className="text-sm font-medium">{t("pluginPanel.empty")}</p>
          <p className="text-muted-foreground max-w-md text-xs">{t("pluginPanel.emptyHint")}</p>
        </div>
      </AppShell>
    );
  }

  const active = plugins.find((plugin) => plugin.id === activeId) ?? plugins[0];

  return (
    <AppShell>
      <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
        {/* Tab bar: one tab per plugin that has a page to show. A plugin whose
            own window is open keeps its tab, greyed out — clicking it would only
            fight the window for the same page. */}
        <div className="bg-muted/40 flex h-10 shrink-0 items-center gap-1 border-b px-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {plugins.map((plugin) => {
              const isActive = plugin.id === active.id;
              const inWindow = openIds.has(plugin.id);

              const tab = (
                <button
                  key={plugin.id}
                  type="button"
                  disabled={inWindow}
                  title={inWindow ? t("pluginPanel.inWindow") : undefined}
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-1.5 rounded px-2.5 text-xs transition-colors",
                    inWindow
                      ? "border-border text-muted-foreground cursor-not-allowed border border-dashed"
                      : isActive
                        ? "bg-background font-medium shadow-sm"
                        : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                  )}
                  onClick={() => select(plugin.id)}
                >
                  <Package className="size-3.5" />
                  <span className="max-w-40 truncate">{plugin.name}</span>
                </button>
              );

              return (
                <ContextMenu key={plugin.id}>
                  <ContextMenuTrigger asChild>{tab}</ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem disabled={inWindow} onSelect={() => void openWindow(plugin)}>
                      {t("pluginPanel.openWindow")}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </div>

        {/* Panes: only the visited ones exist, and all of them stay mounted.
            A plugin whose own window is open is skipped — its page lives there
            now, and painting a second copy here would just fight it. */}
        <div className="relative min-h-0 flex-1">
          {plugins
            .filter((plugin) => visited.includes(plugin.id) && !openIds.has(plugin.id))
            .map((plugin) => (
              <div
                key={plugin.id}
                className={cn("absolute inset-0", plugin.id !== active.id && "hidden")}
              >
                <PluginPanel
                  plugin={plugin}
                  active={plugin.id === active.id && pageActive}
                  up={up?.has(plugin.id) ?? false}
                  known={upKnown}
                  onUpChanged={refreshUp}
                />
              </div>
            ))}
        </div>
      </section>
    </AppShell>
  );
}
