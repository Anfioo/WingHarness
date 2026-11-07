import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from "react";
import { Package } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { MainTitleBar } from "@/components/main-title-bar";
import { UpdaterAutoCheck } from "@/components/updater-auto-check";
import { WindowFrame } from "@/components/window-frame";
import { HelpTip } from "@/components/ui/help-tip";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { getAppRouteByPath } from "@/lib/app-routes";
import { resolveIcon } from "@/lib/icon-set";
import {
  PLUGIN_FOCUS_PATH,
  pluginOverride,
  pluginTagline,
  routeOverride,
} from "@/lib/sidebar-config";
import { registerShortcut } from "@/lib/shortcut";
import { toggleWindow } from "@/lib/window";
import { useRouter } from "@/lib/router";
import { listen } from "@tauri-apps/api/event";
import { useApiHome } from "@/hooks/use-api-home";
import { useCustomIcons } from "@/hooks/use-custom-icons";
import { useGitHome } from "@/hooks/use-git-home";
import { usePluginsStore } from "@/hooks/use-plugins-store";
import { useProjectHome } from "@/hooks/use-project-home";
import { useSidebarStore } from "@/hooks/use-sidebar-store";
import { useSvnHome } from "@/hooks/use-svn-home";

const SHORTCUT_KEY = "global-shortcut-show-main";

type AppShellProps = {
  children: ReactNode;
};

// Marks the subtree of the shell the router owns. Every main-window page still
// renders `<AppShell>` around its own content, so that inner one has to become a
// no-op — otherwise it would draw a second frame and remount the sidebar on
// every navigation, which is exactly the reload this router exists to avoid.
const ShellContext = createContext(false);

export function AppShell({ children }: AppShellProps) {
  if (useContext(ShellContext)) {
    return <>{children}</>;
  }

  return (
    <ShellContext.Provider value={true}>
      <AppShellFrame>{children}</AppShellFrame>
    </ShellContext.Provider>
  );
}

function AppShellFrame({ children }: AppShellProps) {
  const { pathname, search } = useRouter();
  const { config } = useSidebarStore();
  const { plugins } = usePluginsStore();
  const { byName: customIcons } = useCustomIcons();
  const currentRoute = getAppRouteByPath(pathname);

  const keepPages = config?.cachePages ?? false;
  const pageKey = `${pathname}${search}`;

  // A plugin's page has no entry in the route table, so its header is built from
  // the plugin itself; every other page's comes from its route.
  const pluginId = pathname === PLUGIN_FOCUS_PATH ? new URLSearchParams(search).get("id") : null;
  const plugin = pluginId ? plugins.find((entry) => entry.id === pluginId) : undefined;
  const own = pluginId
    ? {
        title: plugin?.name ?? "",
        scope: plugin ? pluginTagline(plugin) : "",
        notes: plugin?.description ?? "",
        icon: Package,
      }
    : {
        title: currentRoute.title,
        scope: currentRoute.scope,
        notes: currentRoute.description,
        icon: currentRoute.icon,
      };

  // The sidebar manager can rename a page and rewrite its header, so the header
  // shows the layout entry's overrides on top of the page's own wording.
  const override = pluginId
    ? pluginOverride(config, pluginId)
    : routeOverride(config, currentRoute.id);
  const pageTitle = override?.label ?? own.title;
  const pageScope = override?.scope ?? own.scope;
  const pageNotes = override?.notes ?? own.notes;
  const PageIcon = resolveIcon(override?.icon, customIcons) ?? own.icon;
  const pageIconColor = override?.iconColor ?? null;

  // The Git picker is one of this window's pages, so a repository window asking
  // for it is answered here.
  useGitHome();
  useSvnHome();
  useProjectHome();

  // The API client picker is one of this window's pages too, so a workspace
  // window asking for it is answered here.
  useApiHome();

  // With pages kept, one scroller is shared by all of them, so each page's own
  // offset is put back by hand; the key below would otherwise have to remount
  // the page to scroll it to the top.
  const scrollRef = useRef<HTMLElement>(null);
  const scrollOffsets = useRef(new Map<string, number>());

  useEffect(() => {
    if (!keepPages) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const offsets = scrollOffsets.current;

    scroller.scrollTop = offsets.get(pageKey) ?? 0;
    return () => {
      offsets.set(pageKey, scroller.scrollTop);
    };
  }, [keepPages, pageKey]);

  useEffect(() => {
    const unlistenShortcutChanged = listen<{ shortcut: string }>(
      "shortcut-changed",
      async (event) => {
        console.log("Shortcut changed event received:", event.payload.shortcut);
        const newShortcut = event.payload.shortcut;
        if (newShortcut) {
          await registerShortcut(newShortcut, async () => {
            await toggleWindow("main");
          });
        }
      }
    );

    const initShortcut = async () => {
      const savedShortcut = localStorage.getItem(SHORTCUT_KEY);
      if (savedShortcut) {
        console.log("Registering saved shortcut:", savedShortcut);
        await registerShortcut(savedShortcut, async () => {
          await toggleWindow("main");
        });
      }
    };
    initShortcut();

    return () => {
      unlistenShortcutChanged.then((fn) => fn());
    };
  }, []);

  return (
    <WindowFrame titleBar={<MainTitleBar />} contentClassName="flex flex-1 overflow-hidden">
      <UpdaterAutoCheck />
      <SidebarProvider className="min-h-0 flex-1">
        <AppSidebar activePath={currentRoute.path} />
        <SidebarInset className="min-w-0 overflow-hidden">
          <header className="border-border flex h-12 shrink-0 items-center gap-3 border-b px-4">
            <SidebarTrigger />
            <div className="bg-muted flex size-7 items-center justify-center rounded-md">
              {createElement(PageIcon, {
                className: "size-4",
                style: pageIconColor ? { color: pageIconColor } : undefined,
              })}
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold">{pageTitle}</h1>
                <p className="text-muted-foreground truncate text-xs">{pageScope}</p>
              </div>
              <HelpTip title={pageTitle} side="bottom" align="start">
                {pageNotes}
              </HelpTip>
            </div>
          </header>

          {/* Keyed on the URL so each page starts at the top: the scroller
              itself survives navigation, so without this a new page would open
              at the previous page's scroll offset. Kept pages are not remounted,
              and restore their own offset above instead. */}
          <main
            key={keepPages ? undefined : pageKey}
            ref={scrollRef}
            className="flex min-h-0 flex-1 overflow-auto p-6"
          >
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </WindowFrame>
  );
}
