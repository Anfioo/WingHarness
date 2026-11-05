import { createContext, useContext } from "react";

/**
 * Whether the page reading this is the one on screen.
 *
 * With page caching on, a page the user has moved away from stays mounted and
 * only its DOM goes off screen. A native webview is painted by the OS, so it
 * has to be hidden by hand; a page that owns one reads this and tells it.
 */
const PageActiveContext = createContext(true);

export const PageActiveProvider = PageActiveContext.Provider;

export function usePageActive() {
  return useContext(PageActiveContext);
}
