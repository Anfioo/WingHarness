import { createContext, useContext, useEffect, type ReactNode } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { MainTitleBar } from "@/components/main-title-bar";
import { UpdaterAutoCheck } from "@/components/updater-auto-check";
import { WindowFrame } from "@/components/window-frame";
import { HelpTip } from "@/components/ui/help-tip";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { appRoutes, getAppRouteByPath } from "@/lib/app-routes";
import { registerShortcut } from "@/lib/shortcut";
import { toggleWindow } from "@/lib/window";
import { useRouter } from "@/lib/router";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { listen } from "@tauri-apps/api/event";

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
  const { t } = useAppTranslation();
  const currentRoute = getAppRouteByPath(pathname);
  const CurrentIcon = currentRoute.icon;
  const routeTitle = t(`routes.${currentRoute.id}.title`);

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
        <AppSidebar routes={appRoutes} activePath={currentRoute.path} />
        <SidebarInset className="min-w-0 overflow-hidden">
          <header className="border-border flex h-12 shrink-0 items-center gap-3 border-b px-4">
            <SidebarTrigger />
            <div className="bg-muted flex size-7 items-center justify-center rounded-md">
              <CurrentIcon className="size-4" />
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold">{routeTitle}</h1>
                <p className="text-muted-foreground truncate text-xs">
                  {t(`routes.${currentRoute.id}.scope`)}
                </p>
              </div>
              <HelpTip title={routeTitle} side="bottom" align="start">
                {t(`routes.${currentRoute.id}.description`)}
              </HelpTip>
            </div>
          </header>

          {/* Keyed on the URL so each page starts at the top: the scroller
              itself survives navigation, so without this a new page would open
              at the previous page's scroll offset. */}
          <main key={`${pathname}${search}`} className="flex min-h-0 flex-1 overflow-auto p-6">
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </WindowFrame>
  );
}
