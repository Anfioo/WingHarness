import { invokeCommand } from "../../base";
import type { PluginPageBounds } from "./types";

/**
 * The embedded browser a plugin's page is shown in.
 *
 * A plugin's site is rendered by a native webview rather than an iframe —
 * plugins forbid framing (`X-Frame-Options: DENY`), and an iframe's address is
 * unreadable across origins. That webview is an OS-level view, not a DOM node,
 * so the frontend drives it through these commands instead of `<iframe>` props.
 *
 * Every command names a `host` window and a `document`: the same plugin page can
 * be embedded in the main window and in a plugin's own window at once, so which
 * window a page belongs to is part of its identity; and a window's page can be
 * replaced by a navigation, so which page *load* opened it is part of the
 * identity too. `host` is the label of the window whose DOM asked for the page —
 * `getCurrentWebviewWindow().label` — and `document` is that window's current
 * page load, {@link DOCUMENT_ID}.
 */

/** Opens a plugin's page over `bounds`. Omitting `url` uses the manifest's `ui`. */
export function pluginsBrowserOpen(
  host: string,
  document: string,
  id: string,
  bounds: PluginPageBounds,
  url?: string
): Promise<void> {
  return invokeCommand("plugins_browser_open", { host, document, id, url: url ?? null, bounds });
}

/** Moves and resizes the page to match its placeholder. */
export function pluginsBrowserSetBounds(
  host: string,
  id: string,
  bounds: PluginPageBounds
): Promise<void> {
  return invokeCommand("plugins_browser_set_bounds", { host, id, bounds });
}

/** Shows or hides the page; CSS cannot hide a native view. */
export function pluginsBrowserSetVisible(
  host: string,
  id: string,
  visible: boolean
): Promise<void> {
  return invokeCommand("plugins_browser_set_visible", { host, id, visible });
}

/** Navigates to another address on the plugin's own site. */
export function pluginsBrowserNavigate(host: string, id: string, url: string): Promise<void> {
  return invokeCommand("plugins_browser_navigate", { host, id, url });
}

/** Walks the page's history back one step. */
export function pluginsBrowserBack(host: string, id: string): Promise<void> {
  return invokeCommand("plugins_browser_back", { host, id });
}

/** Walks the page's history forward one step. */
export function pluginsBrowserForward(host: string, id: string): Promise<void> {
  return invokeCommand("plugins_browser_forward", { host, id });
}

/** Reloads the page. */
export function pluginsBrowserReload(host: string, id: string): Promise<void> {
  return invokeCommand("plugins_browser_reload", { host, id });
}

/**
 * The address the page is on right now.
 *
 * Polled rather than pushed: a client-side route change (`pushState`) is not a
 * navigation the host is told about, but it does change the document's address.
 */
export function pluginsBrowserUrl(host: string, id: string): Promise<string> {
  return invokeCommand("plugins_browser_url", { host, id });
}

/** Closes one plugin's page, if the calling document owns it. */
export function pluginsBrowserClose(host: string, document: string, id: string): Promise<void> {
  return invokeCommand("plugins_browser_close", { host, document, id });
}

/**
 * Closes every plugin page this host window holds for the calling document.
 *
 * Called when the plugin page is left or reloaded: the pages belong to the
 * window, so nothing else takes them down. Scoped to one host and one page load,
 * so a late call from a page being replaced cannot close a page the page that
 * replaced it has already opened.
 */
export function pluginsBrowserCloseAll(host: string, document: string): Promise<void> {
  return invokeCommand("plugins_browser_close_all", { host, document });
}
