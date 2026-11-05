import { emit } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { GIT_HOME_EVENT, GIT_REPO_WINDOW_PATH } from "@/lib/git-routes";
import { createWindow, showWindow } from "@/lib/window";

/**
 * One window per repository: the label is derived from the repository path so
 * clicking the same repository twice focuses the window that is already open
 * instead of stacking duplicates. A window label may only contain
 * alphanumerics and `-`, `/`, `:`, `_` (see `@/lib/plugin-label`), so the path
 * is hashed rather than embedded.
 */
const GIT_REPO_PREFIX = "git-repo-";

/**
 * FNV-1a over the normalized path, printed as 16 hex chars. Chosen over the
 * usual 32-bit string hash because a collision here would silently focus the
 * wrong repository's window.
 */
function hashRepoPath(path: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let i = 0; i < path.length; i += 1) {
    hash ^= BigInt(path.charCodeAt(i));
    hash = (hash * prime) & mask;
  }

  return hash.toString(16).padStart(16, "0");
}

/**
 * Paths that differ only by separator, trailing slash or case are the same
 * repository on Windows, and must therefore produce the same window label.
 */
export function normalizeRepoPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function gitRepoWindowLabel(repoPath: string) {
  return GIT_REPO_PREFIX + hashRepoPath(normalizeRepoPath(repoPath));
}

/**
 * Show `repoPath` in a window of its own, creating it if this is the first
 * time. A window with that label already on screen is focused instead, which is
 * what makes opening the same repository twice idempotent.
 *
 * The repository path travels in the query string, not the label, because the
 * label is a hash. `main.tsx` routes on `pathname` only, so the query is
 * ignored there and the window's page reads it itself.
 */
export async function openGitRepoWindow(repoPath: string) {
  const path = repoPath.trim();
  const label = gitRepoWindowLabel(path);

  await createWindow(label, {
    title: repoTitle(path),
    url: `${GIT_REPO_WINDOW_PATH}?path=${encodeURIComponent(path)}`,
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
 * The labels of the repository windows that are already open. Callers compare
 * them against `gitRepoWindowLabel(path)` to mark a repository as open. There
 * is no backend event for a git window closing — it is a plain window, not a
 * plugin host — so callers re-scan on mount and on focus instead of subscribing.
 */
export async function openGitRepoWindowLabels() {
  try {
    const windows = await getAllWebviewWindows();
    return windows
      .map((window) => window.label)
      .filter((label) => label.startsWith(GIT_REPO_PREFIX));
  } catch (error) {
    console.error("Failed to list open repository windows:", error);
    return [];
  }
}

/**
 * Ask the main window — which owns the picker route — to show it, and bring it
 * to the front. Called from a repository window, whose own page has no picker.
 */
export async function showGitHome() {
  await emit(GIT_HOME_EVENT);
  await showWindow("main");
}

/** Last path segment, used as the window title until the repo reports its own. */
function repoTitle(path: string) {
  const parts = normalizeRepoPath(path).split("/");
  return parts[parts.length - 1] || path;
}
