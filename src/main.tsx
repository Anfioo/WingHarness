import React, { lazy, Suspense, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./i18n";
import { AppShell } from "./components/app-shell";
import { RouterProvider, useRouter } from "./lib/router";
import { UpdaterProvider } from "./hooks/use-updater";
import { PluginsProvider } from "@/hooks/use-plugins-store";
import { CustomIconsProvider } from "@/hooks/use-custom-icons";
import { SidebarProvider, useSidebarStore } from "@/hooks/use-sidebar-store";
import { PageActiveProvider } from "@/lib/page-active";

// Each window opens exactly one page, so the routes are dynamic imports: Vite
// splits them into their own chunks and a window only loads the page it shows
// instead of every page in the app.
const pageMap = {
  "/": lazy(() => import("./pages/project/index")),
  "/project-window": lazy(() => import("./pages/project/window")),
  "/git-repo": lazy(() => import("./pages/git-repo/index")),
  "/git-repo-window": lazy(() => import("./pages/git-repo/window")),
  "/svn-workspace": lazy(() => import("./pages/svn-workspace/index")),
  "/svn-workspace-window": lazy(() => import("./pages/svn-workspace/window")),
  "/svn-workspace-diff": lazy(() => import("./pages/svn-workspace/diff-window")),
  "/api-client": lazy(() => import("./pages/api-client/index")),
  "/api-client-window": lazy(() => import("./pages/api-client/window")),
  "/systools": lazy(() => import("./pages/systools/index")),
  "/systools-window": lazy(() => import("./pages/systools/window")),
  "/servers": lazy(() => import("./pages/servers/index")),
  "/ports": lazy(() => import("./pages/ports/index")),
  "/database": lazy(() => import("./pages/database/index")),
  "/database-window": lazy(() => import("./pages/database/window")),
  "/frp": lazy(() => import("./pages/frp/index")),
  "/md-editor": lazy(() => import("./pages/md-editor/index")),
  "/server-window": lazy(() => import("./pages/server-window/index")),
  "/private-registry": lazy(() => import("./pages/private-registry/index")),
  "/local-terminal": lazy(() => import("./pages/local-terminal/index")),
  "/clash": lazy(() => import("./pages/clash/index")),
  "/plugins": lazy(() => import("./pages/plugins/index")),
  "/plugin-focus": lazy(() => import("./pages/plugin-focus/index")),
  "/mcp-hub": lazy(() => import("./pages/mcp-hub/index")),
  "/ai-config": lazy(() => import("./pages/ai-config/index")),
  "/claude-chat": lazy(() => import("./pages/claude-chat/index")),
  "/claude-history": lazy(() => import("./pages/claude-history/index")),
  "/claude-workflow": lazy(() => import("./pages/claude-workflow/index")),
  "/notes": lazy(() => import("./pages/notes/index")),
  "/moin": lazy(() => import("./pages/moin/index")),
  "/file-preview": lazy(() => import("./pages/file-preview/index")),
  "/preview-window": lazy(() => import("./pages/preview-window/index")),
  "/cc-switch": lazy(() => import("./pages/cc-switch/index")),
  "/about": lazy(() => import("./windows/about/index")),
  "/settings": lazy(() => import("./windows/settings/index")),
  "/plugin-config": lazy(() => import("./windows/plugin-config/index")),
  "/plugin-window": lazy(() => import("./windows/plugin-window/index")),
  "/sidebar-manager": lazy(() => import("./windows/sidebar-manager/index")),
  "/tray-menu": lazy(() => import("./windows/tray-menu/index")),
  "/update": lazy(() => import("./windows/update/index")),
};

// Routes that are their own window (settings, about, the review/diff dialogs,
// the plugin windows, a Git repository) and so bring their own frame. Every
// other route is a page of the main window, which the router keeps wrapped in
// the shared app shell so the sidebar survives navigation. The Git picker is
// one of those pages; each repository it opens is a window of its own.
const standalonePaths = new Set([
  "/about",
  "/settings",
  "/project-window",
  "/git-repo-window",
  "/svn-workspace-window",
  "/svn-workspace-diff",
  "/api-client-window",
  "/systools-window",
  "/server-window",
  "/database-window",
  "/plugin-config",
  "/plugin-window",
  "/sidebar-manager",
  "/tray-menu",
  "/preview-window",
  "/update",
]);

/** A page the main window has opened and, with caching on, left mounted. */
type OpenPage = { key: string; pathname: string };

/** One page, loaded the first time it is shown. */
function Page({ pathname }: { pathname: string }) {
  const PageComponent = pageMap[pathname as keyof typeof pageMap] ?? pageMap["/"];

  return (
    <Suspense fallback={null}>
      <PageComponent />
    </Suspense>
  );
}

function RoutedApp() {
  const { pathname, search } = useRouter();
  const { config } = useSidebarStore();
  const keepPages = config?.cachePages ?? false;
  const pageKey = `${pathname}${search}`;
  const [opened, setOpened] = useState<OpenPage[]>([]);

  // With caching on, a page stays mounted once visited, so coming back to it
  // finds the same state instead of a rebuilt one; turning the setting off
  // closes them all.
  useEffect(() => {
    if (!keepPages) {
      setOpened((current) => (current.length === 0 ? current : []));
      return;
    }
    if (standalonePaths.has(pathname)) return;

    setOpened((current) =>
      current.some((page) => page.key === pageKey)
        ? current
        : [...current, { key: pageKey, pathname }]
    );
  }, [keepPages, pageKey, pathname]);

  if (standalonePaths.has(pathname)) {
    return <Page pathname={pathname} />;
  }

  if (!keepPages) {
    return (
      <AppShell>
        <Page pathname={pathname} />
      </AppShell>
    );
  }

  // The effect above runs after this render, so the page being opened right now
  // may not be in the list yet.
  const pages = opened.some((page) => page.key === pageKey)
    ? opened
    : [...opened, { key: pageKey, pathname }];

  return (
    <AppShell>
      {pages.map((page) => (
        // `contents` keeps a live page laid out exactly as if it were the only
        // child of the shell's scroller; `hidden` only takes it off screen, and
        // the provider tells a page that owns a native webview to hide it too.
        <div key={page.key} className={page.key === pageKey ? "contents" : "hidden"}>
          <PageActiveProvider value={page.key === pageKey}>
            <Page pathname={page.pathname} />
          </PageActiveProvider>
        </div>
      ))}
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider>
      <UpdaterProvider>
        <PluginsProvider>
          <CustomIconsProvider>
            <SidebarProvider>
              <RoutedApp />
            </SidebarProvider>
          </CustomIconsProvider>
        </PluginsProvider>
      </UpdaterProvider>
    </RouterProvider>
  </React.StrictMode>
);
