import { open as openDirectory } from "@tauri-apps/plugin-dialog";
import {
  readGitignore,
  svnInfo,
  svnLocalRevision,
  svnStatus,
  svnWorkspaceRemember,
} from "@/commands";
import i18n from "@/i18n";
import {
  cacheSvnInfoMetadata,
  cacheWorkspaceSnapshot,
  filterByGitignore,
  getCachedSvnInfoMetadata,
  getWorkspaceSnapshot,
  invalidateWorkspaceSnapshot,
  parseGitignore,
  type SvnInfo,
  type SvnInfoMetadata,
} from "@/lib/svn-core";
import { readSvnSettings } from "./settings";
import { useSvnWorkspaceStore } from "./store";

/**
 * Load and refresh orchestration for one working copy, ported from the
 * reference's `composables/useWorkspace.ts`.
 *
 * The reference imported `filterByGitignoreAsync` from a web worker; this
 * project has no worker infrastructure, so the synchronous `filterByGitignore`
 * runs on the main thread instead. Everything else — the request-generation
 * guard, showing `currentPath` before the status call, the snapshot fallback,
 * `svnStatus` → immediate display → `svnInfo` + `svnLocalRevision` → gitignore
 * filtering, and the de-duplication of concurrent requests — is kept.
 */

let workspaceRequestGeneration = 0;
let pendingRequest: {
  path: string;
  generation: number;
  force: boolean;
  promise: Promise<boolean>;
} | null = null;
let lastRefresh: { path: string; generation: number; timestamp: number } | null = null;

function trackRequest(
  path: string,
  operation: () => Promise<boolean>,
  force = false
): Promise<boolean> {
  const promise = operation();
  const request = { path, generation: workspaceRequestGeneration, force, promise };
  pendingRequest = request;
  request.promise = promise
    .then((success) => {
      if (success && request.generation === workspaceRequestGeneration) {
        lastRefresh = { path, generation: request.generation, timestamp: Date.now() };
      }
      return success;
    })
    .finally(() => {
      if (pendingRequest === request) pendingRequest = null;
    });
  return request.promise;
}

async function loadGitignoreIfNeeded(path: string, isCurrent: () => boolean): Promise<void> {
  const { gitignoreEnabled } = readSvnSettings();
  if (!gitignoreEnabled) {
    if (!isCurrent()) return;
    const store = useSvnWorkspaceStore.getState();
    store.setGitignorePatterns([]);
    store.setGitignoreMtime(null);
    store.setGitignoreWorkspacePath(null);
    return;
  }

  try {
    const data = await readGitignore(path);
    if (!isCurrent()) return;
    if (!data) {
      const store = useSvnWorkspaceStore.getState();
      store.setGitignorePatterns([]);
      store.setGitignoreMtime(null);
      store.setGitignoreWorkspacePath(path);
      return;
    }

    const current = useSvnWorkspaceStore.getState();
    if (path === current.gitignoreWorkspacePath && data.mtime === current.gitignoreMtime) return;

    const patterns = parseGitignore(data.content);
    if (!isCurrent()) return;
    const store = useSvnWorkspaceStore.getState();
    store.setGitignorePatterns(patterns);
    store.setGitignoreMtime(data.mtime);
    store.setGitignoreWorkspacePath(path);
  } catch {
    if (!isCurrent()) return;
    const store = useSvnWorkspaceStore.getState();
    store.setGitignorePatterns([]);
    store.setGitignoreMtime(null);
    store.setGitignoreWorkspacePath(null);
  }
}

function toSvnInfoMetadata(info: SvnInfo): SvnInfoMetadata {
  const { revision: _revision, ...metadata } = info;
  return metadata;
}

async function loadWorkspaceInfo(path: string, isCurrent: () => boolean): Promise<SvnInfo | null> {
  const cachedMetadata = getCachedSvnInfoMetadata(path);
  const freshMetadataRequest = cachedMetadata ? null : svnInfo(path);
  const [revision, freshInfo] = await Promise.all([
    svnLocalRevision(path),
    freshMetadataRequest || Promise.resolve(null),
  ]);

  if (!isCurrent()) return null;

  const metadata = cachedMetadata || (freshInfo ? toSvnInfoMetadata(freshInfo) : null);
  if (!metadata) throw new Error("Could not read the SVN working copy metadata.");
  if (!cachedMetadata && freshInfo) cacheSvnInfoMetadata(path, metadata);

  return { ...metadata, revision };
}

type InfoRequestResult = { ok: true; info: SvnInfo | null } | { ok: false; error: unknown };

function requestWorkspaceInfo(path: string, isCurrent: () => boolean): Promise<InfoRequestResult> {
  return loadWorkspaceInfo(path, isCurrent).then(
    (info) => ({ ok: true, info }),
    (error) => ({ ok: false, error })
  );
}

async function performLoadWorkspace(path: string): Promise<boolean> {
  const generation = ++workspaceRequestGeneration;
  const store = useSvnWorkspaceStore.getState();
  const previousPath = store.workspacePath;
  const previousStatusList = store.statusList;
  const previousSvnInfo = store.svnInfo;
  const previousStatusIsStale = store.statusIsStale;
  const { gitignoreEnabled } = readSvnSettings();
  const snapshot = getWorkspaceSnapshot(path, gitignoreEnabled);
  const isCurrentGeneration = () => generation === workspaceRequestGeneration;
  const isCurrent = () =>
    isCurrentGeneration() && useSvnWorkspaceStore.getState().workspacePath === path;

  store.setLoading(true);
  store.setError(null);

  // Set the path first so views that depend on it switch as early as possible.
  store.setCurrentPath(path);
  store.setStatusList(snapshot?.statusList || []);
  store.setSvnInfo(snapshot?.svnInfo || null);
  store.setStatusIsStale(Boolean(snapshot));

  const statusRequest = svnStatus(path);
  // Turn the eager metadata request into an always-fulfilled result so a status
  // failure cannot leave a second rejected promise unobserved.
  const infoRequest = requestWorkspaceInfo(path, isCurrent);
  const gitignoreRequest = loadGitignoreIfNeeded(path, isCurrent);

  try {
    // The change list does not depend on repository metadata: show it as soon
    // as `svn status` returns.
    const status = await statusRequest;
    if (!isCurrent()) return false;
    useSvnWorkspaceStore.getState().setStatusList(status);

    const [infoResult] = await Promise.all([infoRequest, gitignoreRequest]);
    if (!infoResult.ok) throw infoResult.error;
    const info = infoResult.info;
    if (!isCurrent() || !info) return false;
    const filteredStatus = filterByGitignore(
      status,
      useSvnWorkspaceStore.getState().gitignorePatterns
    );
    if (!isCurrent()) return false;
    const current = useSvnWorkspaceStore.getState();
    current.setStatusList(filteredStatus);
    current.setSvnInfo(info);
    current.setStatusIsStale(false);
    cacheWorkspaceSnapshot(path, filteredStatus, info, gitignoreEnabled);
    // Record the open in the engine's data directory (the reference wrote its
    // recent list to localStorage). Best effort: a failed write must not fail
    // an otherwise successful load.
    void svnWorkspaceRemember(path).catch((error: unknown) => {
      console.error("Failed to remember the working copy:", error);
    });
    return true;
  } catch (err) {
    if (!isCurrent()) return false;

    if (snapshot) {
      const current = useSvnWorkspaceStore.getState();
      current.setStatusList(snapshot.statusList);
      current.setSvnInfo(snapshot.svnInfo);
      current.setStatusIsStale(true);
      current.setError(String(err));
      return false;
    }
    const current = useSvnWorkspaceStore.getState();
    if (previousPath) current.setCurrentPath(previousPath);
    else current.clearWorkspace();
    current.setStatusList(previousStatusList);
    current.setSvnInfo(previousSvnInfo);
    current.setStatusIsStale(previousStatusIsStale);
    current.setError(String(err));
    return false;
  } finally {
    if (isCurrentGeneration()) useSvnWorkspaceStore.getState().setLoading(false);
  }
}

async function performRefreshStatus(force = false): Promise<boolean> {
  const path = useSvnWorkspaceStore.getState().workspacePath;
  if (!path) return false;

  const generation = ++workspaceRequestGeneration;
  const isCurrent = () =>
    generation === workspaceRequestGeneration &&
    useSvnWorkspaceStore.getState().workspacePath === path;

  const store = useSvnWorkspaceStore.getState();
  store.setLoading(true);
  store.setError(null);
  try {
    const statusRequest = svnStatus(path, force);
    const infoRequest = requestWorkspaceInfo(path, isCurrent);
    const gitignoreRequest = loadGitignoreIfNeeded(path, isCurrent);
    const status = await statusRequest;
    if (!isCurrent()) return false;
    useSvnWorkspaceStore.getState().setStatusList(status);
    const [infoResult] = await Promise.all([infoRequest, gitignoreRequest]);
    if (!infoResult.ok) throw infoResult.error;
    const info = infoResult.info;
    if (!isCurrent() || !info) return false;
    const filteredStatus = filterByGitignore(
      status,
      useSvnWorkspaceStore.getState().gitignorePatterns
    );
    if (!isCurrent()) return false;
    const current = useSvnWorkspaceStore.getState();
    current.setStatusList(filteredStatus);
    current.setSvnInfo(info);
    current.setStatusIsStale(false);
    cacheWorkspaceSnapshot(path, filteredStatus, info, readSvnSettings().gitignoreEnabled);
    return true;
  } catch (err) {
    if (!isCurrent()) return false;
    useSvnWorkspaceStore.getState().setError(String(err));
    return false;
  } finally {
    if (isCurrent()) useSvnWorkspaceStore.getState().setLoading(false);
  }
}

function loadWorkspace(path: string): Promise<boolean> {
  if (pendingRequest?.path === path && pendingRequest.generation === workspaceRequestGeneration) {
    return pendingRequest.promise;
  }
  return trackRequest(path, () => performLoadWorkspace(path));
}

async function openWorkspaceDialog(): Promise<boolean> {
  const selected = await openDirectory({
    directory: true,
    multiple: false,
    title: i18n.t("svnWorkspace.welcome.openCard.dialogTitle"),
  });

  if (!selected) return false;

  const path = Array.isArray(selected) ? selected[0] : selected;
  return loadWorkspace(path);
}

function refreshStatus(): Promise<boolean> {
  const path = useSvnWorkspaceStore.getState().workspacePath;
  if (!path) return Promise.resolve(false);
  if (
    pendingRequest?.path === path &&
    pendingRequest.force &&
    pendingRequest.generation === workspaceRequestGeneration
  ) {
    return pendingRequest.promise;
  }
  return trackRequest(path, () => performRefreshStatus(true), true);
}

// A mutation or setting change requires a scan started after that change; an
// older background scan must not satisfy this request.
function refreshStatusAfterMutation(): Promise<boolean> {
  const path = useSvnWorkspaceStore.getState().workspacePath;
  if (path) {
    invalidateWorkspaceSnapshot(path);
    useSvnWorkspaceStore.getState().setStatusIsStale(true);
  }
  return path ? trackRequest(path, () => performRefreshStatus(true), true) : Promise.resolve(false);
}

function refreshStatusIfStale(maxAgeMs: number): Promise<boolean> {
  const path = useSvnWorkspaceStore.getState().workspacePath;
  if (!path) return Promise.resolve(false);
  if (pendingRequest?.path === path && pendingRequest.generation === workspaceRequestGeneration) {
    return pendingRequest.promise;
  }
  if (
    lastRefresh?.path === path &&
    lastRefresh.generation === workspaceRequestGeneration &&
    Date.now() - lastRefresh.timestamp < maxAgeMs
  ) {
    return Promise.resolve(true);
  }
  return trackRequest(path, () => performRefreshStatus(false));
}

export function useSvnWorkspace(): {
  loadWorkspace: (path: string) => Promise<boolean>;
  openWorkspaceDialog: () => Promise<boolean>;
  refreshStatus: () => Promise<boolean>;
  refreshStatusAfterMutation: () => Promise<boolean>;
  refreshStatusIfStale: (maxAgeMs: number) => Promise<boolean>;
} {
  return {
    loadWorkspace,
    openWorkspaceDialog,
    refreshStatus,
    refreshStatusAfterMutation,
    refreshStatusIfStale,
  };
}
