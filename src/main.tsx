import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./i18n";
import { AppShell } from "./components/app-shell";
import { RouterProvider, useRouter } from "./lib/router";
import { UpdaterProvider } from "./hooks/use-updater";

// Each window opens exactly one page, so the routes are dynamic imports: Vite
// splits them into their own chunks and a window only loads the page it shows
// instead of every page in the app.
const pageMap = {
  "/": lazy(() => import("./pages/start/index")),
  "/local-terminal": lazy(() => import("./pages/local-terminal/index")),
  "/notes": lazy(() => import("./pages/notes/index")),
  "/file-preview": lazy(() => import("./pages/file-preview/index")),
  "/project": lazy(() => import("./pages/project/index")),
  "/about": lazy(() => import("./windows/about/index")),
  "/settings": lazy(() => import("./windows/settings/index")),
  "/tray-menu": lazy(() => import("./windows/tray-menu/index")),
};

// Routes that are their own window (settings, about, the tray menu) and so bring
// their own frame. Every other route is a page of the main window, which the
// router keeps wrapped in the shared app shell so the sidebar survives
// navigation.
const standalonePaths = new Set(["/about", "/settings", "/tray-menu"]);

function RoutedApp() {
  const { pathname } = useRouter();
  const PageComponent = pageMap[pathname as keyof typeof pageMap] ?? pageMap["/"];

  // The shell keys its scroller on the URL, which remounts the page inside it, so
  // a new page starts clean and at the top.
  const page = (
    <Suspense fallback={null}>
      <PageComponent />
    </Suspense>
  );

  if (standalonePaths.has(pathname)) {
    return page;
  }

  return <AppShell>{page}</AppShell>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider>
      <UpdaterProvider>
        <RoutedApp />
      </UpdaterProvider>
    </RouterProvider>
  </React.StrictMode>
);
