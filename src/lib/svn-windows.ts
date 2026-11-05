import { emit } from "@tauri-apps/api/event";
import { getAllWebviewWindows, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { SVN_DIFF_WINDOW_PATH, SVN_HOME_EVENT, SVN_WINDOW_PATH } from "@/lib/svn-routes";
import { createWindow, showWindow } from "@/lib/window";
import type { SvnDiffTarget } from "@/features/svn-workspace/store";

/**
 * One window per working copy: the label is derived from the working copy path
 * so opening the same copy twice focuses the window that is already open
 * instead of stacking duplicates. A window label may only contain
 * alphanumerics and `-`, `/`, `:`, `_` (see `@/lib/plugin-label`), so the path
 * is hashed rather than embedded. The prefix must stay `svn-wc-`: the Tauri
 * capability grants the window pattern `svn-wc-*`, and any other prefix makes
 * the window fail to open at runtime.
 */
const SVN_WC_PREFIX = "svn-wc-";

/**
 * One diff window per changed file at one revision range. The prefix must stay
 * `svn-diff-`: the Tauri capability grants the window patterns `svn-diff-*`
 * (and `svn-wc-*`), and any other prefix makes the window fail to open at
 * runtime.
 */
const SVN_DIFF_PREFIX = "svn-diff-";

/**
 * FNV-1a over a window key, printed as 16 hex chars. Chosen over the usual
 * 32-bit string hash because a collision here would silently focus the wrong
 * window — another working copy's, or another file's.
 */
function hashWindowKey(key: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < key.length; i += 1) {
    hash ^= BigInt(key.charCodeAt(i));
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, "0");
}

/**
 * Paths that differ only by separator, trailing slash or case are the same
 * working copy on Windows, and must therefore produce the same window label.
 */
export function normalizeSvnPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function svnWorkspaceWindowLabel(workspacePath: string) {
  return SVN_WC_PREFIX + hashWindowKey(normalizeSvnPath(workspacePath));
}

/**
 * Show `workspacePath` in a window of its own, creating it if this is the first
 * time. A window with that label already on screen is focused instead, which is
 * what makes opening the same working copy twice idempotent.
 *
 * The working copy path travels in the query string, not the label, because the
 * label is a hash. `main.tsx` routes on `pathname` only, so the query is
 * ignored there and the window's page reads it itself.
 */
export async function openSvnWorkspaceWindow(workspacePath: string) {
  const path = workspacePath.trim();
  const label = svnWorkspaceWindowLabel(path);

  await createWindow(label, {
    title: workspaceTitle(path),
    url: `${SVN_WINDOW_PATH}?path=${encodeURIComponent(path)}`,
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    resizable: true,
    maximizable: true,
    minimizable: true,
    // Every window of this app draws its own frame (`WindowFrame` + `TitleBar`),
    // so the native one has to stay off or the bars would stack.
    decorations: false,
    transparent: true,
    shadow: false,
  });

  return label;
}

/**
 * Show one changed file's diff in a window of its own, creating it if this is
 * the first time. The label covers the working copy, the target path and the
 * revision range, so opening another file — or the same file at another range —
 * opens another window rather than reusing one that still shows the old diff,
 * and re-opening the same one focuses it. Several diffs can thus be compared at
 * once, as the review window's file diffs already are.
 *
 * The working copy and the diff target travel in the query, not the label,
 * because the label is a hash; the window's page reads them itself.
 */
export async function openSvnDiffWindow(workspacePath: string, target: SvnDiffTarget) {
  const path = workspacePath.trim();
  const key = [
    normalizeSvnPath(path),
    target.path,
    target.oldRevision ?? "",
    target.newRevision ?? "",
  ].join("|");
  const label = SVN_DIFF_PREFIX + hashWindowKey(key);

  const query = new URLSearchParams({ path, target: target.path });
  if (target.oldRevision != null) query.set("old", String(target.oldRevision));
  if (target.newRevision != null) query.set("new", String(target.newRevision));

  await createWindow(label, {
    title: diffTitle(target),
    url: `${SVN_DIFF_WINDOW_PATH}?${query.toString()}`,
    width: 1000,
    height: 720,
    minWidth: 640,
    minHeight: 400,
    resizable: true,
    maximizable: true,
    minimizable: true,
    // Every window of this app draws its own frame (`WindowFrame` + `TitleBar`),
    // so the native one has to stay off or the bars would stack.
    decorations: false,
    transparent: true,
    shadow: false,
    // Centering only — `createWindow` drops the parent before creating, so this
    // window is not owned by the log it came from and does not stay on top of it.
    parent: getCurrentWebviewWindow().label,
  });

  return label;
}

/**
 * The labels of the working-copy windows that are already open. Callers compare
 * them against `svnWorkspaceWindowLabel(path)` to mark a working copy as open.
 * There is no backend event for an SVN window closing — it is a plain window,
 * not a plugin host — so callers re-scan on mount and on focus instead of
 * subscribing.
 */
export async function openSvnWorkspaceWindowLabels() {
  try {
    const windows = await getAllWebviewWindows();
    return windows.map((window) => window.label).filter((label) => label.startsWith(SVN_WC_PREFIX));
  } catch (error) {
    console.error("Failed to list open working-copy windows:", error);
    return [];
  }
}

/**
 * Ask the main window — which owns the picker route — to show it, and bring it
 * to the front. Called from a working-copy window, whose own page has no picker.
 */
export async function showSvnHome() {
  await emit(SVN_HOME_EVENT);
  await showWindow("main");
}

/** Last path segment, used as the window title until the copy reports its own. */
function workspaceTitle(path: string) {
  const parts = normalizeSvnPath(path).split("/");
  return parts[parts.length - 1] || path;
}

/** The changed file's name, without the peg revision `svn` pinned it to. */
function diffTitle(target: SvnDiffTarget) {
  const parts = target.path.replace(/@\d+$/, "").replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || target.path;
}
