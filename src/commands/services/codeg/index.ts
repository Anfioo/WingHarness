import { invoke } from "@tauri-apps/api/core";
import { invokeCommand } from "../../base";
import type {
  CodegBounds,
  CodegInstall,
  CodegMode,
  CodegRelease,
  CodegServerStatus,
  CodegTheme,
  CodegView,
} from "./types";

/**
 * Codeg, embedded as a native webview rather than a plugin.
 *
 * Two groups of calls. The server ones start and stop the `codeg-server`
 * process the app owns; the page ones drive the child webview the Codeg page is
 * drawn in. The page is an OS-level view with no DOM the app can read, so it is
 * driven through commands like the plugin browser is — and with the same
 * `host`/`document`/`run` ownership, for the same two races (see
 * `src/commands/services/plugin-browser`).
 */

/**
 * Emitted with the server's state whenever it moves, so both windows that show
 * it follow a start, a stop or a crash that neither of them caused.
 */
export const CODEG_STATUS_EVENT = "codeg-status";

/** The configuration, the installed archive, the server's state, the token and
 * the server's output. */
export function codegState(): Promise<CodegView> {
  return invokeCommand("codeg_state", {});
}

/**
 * Starts the server for `mode` and waits until it answers on its port.
 *
 * A server already running the other mode is stopped first: one process serves
 * one export, and both modes share the port.
 */
export function codegStart(mode: CodegMode): Promise<CodegServerStatus> {
  return invokeCommand("codeg_start", { mode });
}

/** Stops the server and every process it started. */
export function codegStop(): Promise<CodegServerStatus> {
  return invokeCommand("codeg_stop", {});
}

/** Restarts the server for `mode`, so a changed path or port takes effect. */
export function codegRestart(mode: CodegMode): Promise<CodegServerStatus> {
  return invokeCommand("codeg_restart", { mode });
}

/**
 * Asks the published `server.json` what the newest `codeg-server` archive is.
 *
 * GitHub is tried first, then the Cloudflare mirror. The answer carries the
 * installed version and whether the manifest names something newer.
 */
export function codegReleaseCheck(): Promise<CodegRelease> {
  return invokeCommand("codeg_release_check", {});
}

/**
 * Verifies a downloaded archive against the manifest and hands its bytes back.
 *
 * The command takes a raw body, so the archive never passes through JSON: the
 * checksum is compared in the backend, which is the side that cares.
 */
export async function codegInstallReadArchive(
  path: string,
  sha256: string,
  size: number
): Promise<Uint8Array> {
  const body = await invoke<ArrayBuffer>("codeg_install_read_archive", { path, sha256, size });
  return new Uint8Array(body);
}

/** Empties the install folder before a new archive is written into it. */
export function codegInstallClear(): Promise<void> {
  return invokeCommand("codeg_install_clear", {});
}

/**
 * Writes one unpacked entry into the install folder.
 *
 * The command takes a raw body, so the bytes never pass through JSON:
 * `[name length: u32 LE][name: UTF-8][content]`.
 */
export async function codegInstallWriteFile(
  relativePath: string,
  bytes: Uint8Array
): Promise<void> {
  const name = new TextEncoder().encode(relativePath.replace(/\\/g, "/"));
  const payload = new Uint8Array(4 + name.length + bytes.length);
  new DataView(payload.buffer).setUint32(0, name.length, true);
  payload.set(name, 4);
  payload.set(bytes, 4 + name.length);
  await invoke("codeg_install_write_file", payload);
}

/** Records a finished install once both halves are on disk. */
export function codegInstallFinish(release: CodegRelease): Promise<CodegInstall> {
  return invokeCommand("codeg_install_finish", {
    version: release.version,
    tag: release.tag,
    sha256: release.sha256,
    size: release.size,
    endpoint: release.endpoint,
    url: release.url,
  });
}

/**
 * Points Codeg's own language at `language` (`en` or `zh_cn`).
 *
 * Codeg keeps its language in its database, not in the page, so this is the
 * only way the embedded copy can speak the app's language. The page reads it
 * once at boot; reloading it afterwards is the caller's business.
 */
export function codegSetLanguage(language: string): Promise<void> {
  return invokeCommand("codeg_set_language", { language });
}

/** Opens the page over `bounds`, on `route`. */
export function codegBrowserOpen(
  host: string,
  document: string,
  run: string,
  route: string,
  bounds: CodegBounds,
  theme: CodegTheme
): Promise<void> {
  return invokeCommand("codeg_browser_open", { host, document, run, route, bounds, theme });
}

/** Moves and resizes the page to match its placeholder. */
export function codegBrowserSetBounds(host: string, bounds: CodegBounds): Promise<void> {
  return invokeCommand("codeg_browser_set_bounds", { host, bounds });
}

/** Shows or hides the page; CSS cannot hide a native view. */
export function codegBrowserSetVisible(host: string, visible: boolean): Promise<void> {
  return invokeCommand("codeg_browser_set_visible", { host, visible });
}

/** Navigates to another route on the Codeg server. */
export function codegBrowserNavigate(host: string, route: string): Promise<void> {
  return invokeCommand("codeg_browser_navigate", { host, route });
}

/** Reloads the page. */
export function codegBrowserReload(host: string): Promise<void> {
  return invokeCommand("codeg_browser_reload", { host });
}

/** Repaints the page in a new appearance without reloading it. */
export function codegBrowserApplyTheme(host: string, theme: CodegTheme): Promise<void> {
  return invokeCommand("codeg_browser_apply_theme", { host, theme });
}

/**
 * The address the page is on right now.
 *
 * Polled rather than pushed: Codeg's client router changes the address without
 * telling the host, and that address is what the tab bar stands for.
 */
export function codegBrowserUrl(host: string): Promise<string> {
  return invokeCommand("codeg_browser_url", { host });
}

/** Opens the page's own inspector. */
export function codegBrowserDevtools(host: string): Promise<void> {
  return invokeCommand("codeg_browser_devtools", { host });
}

/** Closes the page, if the calling effect run still owns it. */
export function codegBrowserClose(host: string, document: string, run: string): Promise<void> {
  return invokeCommand("codeg_browser_close", { host, document, run });
}

/** Closes the page this document opened in `host`. */
export function codegBrowserCloseAll(host: string, document: string): Promise<void> {
  return invokeCommand("codeg_browser_close_all", { host, document });
}
