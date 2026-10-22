import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** The parts of the URL this app routes on: the path, plus the query a page may
 *  carry (the focused plugin's id, a file to diff, ...). */
type Location = {
  pathname: string;
  search: string;
};

function readLocation(): Location {
  return { pathname: window.location.pathname, search: window.location.search };
}

type RouterValue = Location & {
  /** Go to another in-app page without reloading the document. */
  navigate: (to: string) => void;
};

const RouterContext = createContext<RouterValue | null>(null);

/**
 * In-app navigation, callable outside a component too: a feature that owns its
 * own store and dialogs still has to be able to move the main window from one
 * page of itself to the next.
 *
 * Clicking the entry for the page you are already on does nothing at all, rather
 * than reloading it. Otherwise the URL goes onto the history and the provider is
 * told through the event it already listens to, so this works whether or not a
 * component is doing the navigating.
 */
export function navigateApp(to: string) {
  const target = new URL(to, window.location.origin);
  if (target.pathname === window.location.pathname && target.search === window.location.search) {
    return;
  }
  window.history.pushState({}, "", `${target.pathname}${target.search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * In-app navigation for the main window.
 *
 * Sidebar entries used to be plain `<a href>` links, so every click was a full
 * document load: the window blanked, the view jumped back to the top, and the
 * whole shell (sidebar, updater, global shortcut) was rebuilt from scratch.
 * Pages now push the new URL onto the history and swap only the page component,
 * leaving the shell mounted.
 */
export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<Location>(readLocation);

  useEffect(() => {
    const onPopState = () => setLocation(readLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const value = useMemo<RouterValue>(() => ({ ...location, navigate: navigateApp }), [location]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) {
    throw new Error("useRouter must be used inside a RouterProvider.");
  }
  return value;
}
