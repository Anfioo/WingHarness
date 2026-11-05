import { create } from "zustand";
import {
  apiCancelRequest,
  apiSendRequest,
  apiWorkspaceCreate,
  apiWorkspaceDelete,
  apiWorkspaceLoad,
  apiWorkspaceRename,
  apiWorkspacesList,
  apiWorkspaceSave,
} from "@/commands";
import i18n from "@/i18n";
import {
  BASE_URL_VARIABLE,
  createEmptyCollection,
  URL_PROBLEM_KEYS,
} from "@/lib/api-core/request-model";
import { resolveRequest } from "@/lib/api-core/resolve-request";
import type {
  CollectionNode,
  Environment,
  RequestDef,
  SendRequest,
  SendState,
  WorkspaceMeta,
  WorkspaceTree,
} from "@/lib/api-core/types";
import type { UrlProblem } from "@/lib/api-core/url";

/** The idle send state; a fresh object each time so selectors re-render. */
function idleSend(): SendState {
  return { status: "idle", response: null, errorMessage: null, startedAt: null };
}

/** The environment variables resolve against: the active one, else the first. */
export function pickEnvironment(
  tree: WorkspaceTree | null,
  activeId: string | null
): Environment | null {
  if (!tree) return null;
  return tree.environments.find((env) => env.id === activeId) ?? tree.environments[0] ?? null;
}

/** The message shown for a request that cannot be resolved before sending. */
function resolveErrorMessage(problem: UrlProblem | null, missing: string[]): string {
  if (problem) return i18n.t(URL_PROBLEM_KEYS[problem]);
  return i18n.t("apiClient.request.errors.missingVariables", { names: missing.join(", ") });
}

/** Best-effort message from a thrown Tauri command error (usually a string). */
function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/** Deep-copy the pieces of a request the editor mutates, so edits never alias
 *  the object a loaded tree still references. */
function cloneRequest(request: RequestDef): RequestDef {
  return {
    ...request,
    params: request.params.map((row) => ({ ...row })),
    headers: request.headers.map((row) => ({ ...row })),
    body: {
      ...request.body,
      rows: request.body.rows.map((row) => ({ ...row })),
      filePaths: { ...request.body.filePaths },
    },
    auth: { ...request.auth },
    variables: request.variables.map((row) => ({ ...row })),
  };
}

/** Find a request by id anywhere in a node's subtree, or `null`. */
function findRequest(node: CollectionNode, requestId: string): RequestDef | null {
  for (const request of node.requests) {
    if (request.id === requestId) return request;
  }
  for (const child of node.children) {
    const found = findRequest(child, requestId);
    if (found) return found;
  }
  return null;
}

/** Find a request by id anywhere in a workspace, or `null`. */
export function findRequestInTree(tree: WorkspaceTree, requestId: string): RequestDef | null {
  for (const collection of tree.collections) {
    const found = findRequest(collection, requestId);
    if (found) return found;
  }
  return null;
}

/** Return a new node with `requestId` replaced by `next`, or the same node when
 *  the id is not in this subtree (so callers can skip unchanged branches). */
function replaceRequest(node: CollectionNode, requestId: string, next: RequestDef): CollectionNode {
  let nodeChanged = false;
  const requests = node.requests.map((request) => {
    if (request.id === requestId) {
      nodeChanged = true;
      return next;
    }
    return request;
  });

  let childChanged = false;
  const children = node.children.map((child) => {
    const updated = replaceRequest(child, requestId, next);
    if (updated !== child) childChanged = true;
    return updated;
  });

  if (!nodeChanged && !childChanged) return node;
  return {
    ...node,
    requests: nodeChanged ? requests : node.requests,
    children: childChanged ? children : node.children,
  };
}

/** Immutably transform the node with `id` in a subtree; returns the same node
 *  (and so skips re-rendering that branch) when the id is not in it. */
function updateNode(
  node: CollectionNode,
  id: string,
  update: (node: CollectionNode) => CollectionNode
): CollectionNode {
  if (node.id === id) return update(node);
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateNode(child, id, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/** Immutably transform the collection/folder with `id` anywhere in a forest. */
function updateForest(
  forest: CollectionNode[],
  id: string,
  update: (node: CollectionNode) => CollectionNode
): CollectionNode[] {
  let changed = false;
  const next = forest.map((node) => {
    const updated = updateNode(node, id, update);
    if (updated !== node) changed = true;
    return updated;
  });
  return changed ? next : forest;
}

/** Rename the collection/folder or request with `id` anywhere in a subtree. */
function renameInNode(node: CollectionNode, id: string, name: string): CollectionNode {
  if (node.id === id) return { ...node, name };
  let requestChanged = false;
  const requests = node.requests.map((request) => {
    if (request.id !== id) return request;
    requestChanged = true;
    return { ...request, name };
  });
  let childChanged = false;
  const children = node.children.map((child) => {
    const next = renameInNode(child, id, name);
    if (next !== child) childChanged = true;
    return next;
  });
  if (!requestChanged && !childChanged) return node;
  return {
    ...node,
    requests: requestChanged ? requests : node.requests,
    children: childChanged ? children : node.children,
  };
}

/** Remove the collection/folder with `id`, pruning the branch it lives in. */
function removeNode(
  node: CollectionNode,
  id: string
): { node: CollectionNode | null; removed: boolean } {
  if (node.id === id) return { node: null, removed: true };
  let removed = false;
  const children: CollectionNode[] = [];
  for (const child of node.children) {
    const result = removeNode(child, id);
    if (result.removed) removed = true;
    if (result.node) children.push(result.node);
  }
  if (!removed) return { node, removed: false };
  return { node: { ...node, children }, removed: true };
}

/** Remove the collection/folder with `id` from a top-level forest. */
function removeNodeFromForest(
  forest: CollectionNode[],
  id: string
): { forest: CollectionNode[]; removed: boolean } {
  let removed = false;
  const next: CollectionNode[] = [];
  for (const node of forest) {
    const result = removeNode(node, id);
    if (result.removed) removed = true;
    if (result.node) next.push(result.node);
  }
  return { forest: removed ? next : forest, removed };
}

/** Remove the request with `id` from a subtree, leaving every node in place. */
function removeRequestInNode(node: CollectionNode, id: string): CollectionNode {
  let requestChanged = false;
  const requests = node.requests.filter((request) => {
    if (request.id !== id) return true;
    requestChanged = true;
    return false;
  });
  let childChanged = false;
  const children = node.children.map((child) => {
    const next = removeRequestInNode(child, id);
    if (next !== child) childChanged = true;
    return next;
  });
  if (!requestChanged && !childChanged) return node;
  return {
    ...node,
    requests: requestChanged ? requests : node.requests,
    children: childChanged ? children : node.children,
  };
}

/** Whether a request id still exists anywhere in a forest. */
function forestHasRequest(forest: CollectionNode[], requestId: string): boolean {
  for (const node of forest) {
    if (findRequest(node, requestId)) return true;
  }
  return false;
}

interface ApiClientState {
  /** Lightweight workspace rows for the picker. */
  workspaces: WorkspaceMeta[];
  listLoading: boolean;
  listError: string | null;

  /** The workspace open in this window, its last-known server revision and
   *  whether the tree holds edits not yet persisted. */
  tree: WorkspaceTree | null;
  revision: number;
  dirty: boolean;
  openLoading: boolean;
  saveLoading: boolean;

  /** The request selected in the collection tree, plus its working copy. */
  selectedRequestId: string | null;
  draft: RequestDef | null;

  /** The environment variables resolve against; `null` means the first one. */
  activeEnvironmentId: string | null;

  /** Lifecycle of the current send, and the id of the request that is in flight. */
  sendState: SendState;
  activeRequestId: string | null;

  loadWorkspaces: () => Promise<void>;
  createWorkspace: (name: string) => Promise<WorkspaceMeta>;
  renameWorkspace: (id: string, name: string) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  openWorkspace: (id: string) => Promise<void>;
  closeWorkspace: () => void;
  saveWorkspace: () => Promise<void>;
  selectRequest: (id: string | null) => void;
  updateRequest: (patch: Partial<RequestDef>) => void;
  /** Append a request to the collection/folder with `parentId`. */
  addRequest: (parentId: string, request: RequestDef) => void;
  /** Append a folder/collection named `name`; `parentId` of `""` adds a
   *  top-level collection. Returns the new node's id. */
  addFolder: (parentId: string, name: string) => string;
  /** Rename the collection/folder or request with `id`. Blank names are ignored. */
  renameNode: (id: string, name: string) => void;
  /** Delete the collection/folder with `id` and everything beneath it. */
  deleteNode: (id: string) => void;
  /** Delete the request with `id`. */
  deleteRequest: (id: string) => void;
  /** Switch the environment later sends resolve their variables against. */
  setActiveEnvironment: (id: string | null) => void;
  /** Insert or replace an environment; marks the workspace dirty. */
  saveEnvironment: (environment: Environment) => void;
  /** Delete an environment; the active one falls back to the first remaining. */
  removeEnvironment: (id: string) => void;
  /** Set the active environment's `baseUrl` variable, adding the row when absent. */
  setBaseUrl: (value: string) => void;
  send: () => Promise<void>;
  cancel: () => Promise<void>;
}

/**
 * Frontend state for the API client. Business data — workspaces, trees,
 * requests — is owned by the Rust commands and never persisted here; this store
 * only mirrors what the current window is showing. Nothing is persisted at all,
 * so the view-only layout preference lives with the panels (`useDefaultLayout`)
 * rather than here.
 */
export const useApiClient = create<ApiClientState>((set, get) => ({
  workspaces: [],
  listLoading: false,
  listError: null,

  tree: null,
  revision: 0,
  dirty: false,
  openLoading: false,
  saveLoading: false,

  selectedRequestId: null,
  draft: null,
  activeEnvironmentId: null,

  sendState: idleSend(),
  activeRequestId: null,

  loadWorkspaces: async () => {
    set({ listLoading: true, listError: null });
    try {
      const workspaces = await apiWorkspacesList();
      set({ workspaces, listLoading: false });
    } catch (error) {
      set({ listLoading: false, listError: messageOf(error) });
      throw error;
    }
  },

  createWorkspace: async (name) => {
    const meta = await apiWorkspaceCreate(name);
    await get().loadWorkspaces();
    return meta;
  },

  renameWorkspace: async (id, name) => {
    const meta = await apiWorkspaceRename(id, name);
    await get().loadWorkspaces();
    // Keep the open window's title in step when it is the renamed workspace.
    set((state) =>
      state.tree && state.tree.id === id ? { tree: { ...state.tree, name: meta.name } } : {}
    );
  },

  deleteWorkspace: async (id) => {
    await apiWorkspaceDelete(id);
    // Drop the tree when the deleted workspace is the one open here.
    if (get().tree?.id === id) {
      set({
        tree: null,
        revision: 0,
        dirty: false,
        selectedRequestId: null,
        draft: null,
        activeEnvironmentId: null,
        sendState: idleSend(),
        activeRequestId: null,
      });
    }
    await get().loadWorkspaces();
  },

  openWorkspace: async (id) => {
    set({ openLoading: true, listError: null });
    try {
      const tree = await apiWorkspaceLoad(id);
      set({
        tree,
        revision: tree.revision,
        dirty: false,
        openLoading: false,
        selectedRequestId: null,
        draft: null,
        activeEnvironmentId: tree.environments[0]?.id ?? null,
        sendState: idleSend(),
        activeRequestId: null,
      });
    } catch (error) {
      set({ openLoading: false, listError: messageOf(error) });
      throw error;
    }
  },

  closeWorkspace: () => {
    set({
      tree: null,
      revision: 0,
      dirty: false,
      selectedRequestId: null,
      draft: null,
      activeEnvironmentId: null,
      sendState: idleSend(),
      activeRequestId: null,
    });
  },

  saveWorkspace: async () => {
    const { tree, revision } = get();
    if (!tree) return;
    set({ saveLoading: true });
    try {
      const { revision: saved } = await apiWorkspaceSave(tree.id, tree, revision);
      set((state) => ({
        revision: saved,
        dirty: false,
        saveLoading: false,
        tree: state.tree ? { ...state.tree, revision: saved } : state.tree,
      }));
      await get().loadWorkspaces();
    } catch (error) {
      set({ saveLoading: false, listError: messageOf(error) });
      throw error;
    }
  },

  selectRequest: (id) => {
    const { tree } = get();
    if (!tree || id === null) {
      set({ selectedRequestId: null, draft: null });
      return;
    }
    const request = findRequestInTree(tree, id);
    set({ selectedRequestId: id, draft: request ? cloneRequest(request) : null });
  },

  updateRequest: (patch) => {
    const { tree, draft } = get();
    if (!tree || !draft) return;
    const next: RequestDef = { ...draft, ...patch };
    set((state) => ({
      draft: next,
      dirty: true,
      tree: state.tree
        ? {
            ...state.tree,
            collections: state.tree.collections.map((collection) =>
              replaceRequest(collection, next.id, next)
            ),
          }
        : state.tree,
    }));
  },

  addRequest: (parentId, request) => {
    set((state) => {
      if (!state.tree) return {};
      const collections = updateForest(state.tree.collections, parentId, (node) => ({
        ...node,
        requests: [...node.requests, request],
      }));
      return { tree: { ...state.tree, collections }, dirty: true };
    });
  },

  addFolder: (parentId, name) => {
    const folder = createEmptyCollection(name.trim());
    set((state) => {
      if (!state.tree) return {};
      const collections =
        parentId === ""
          ? [...state.tree.collections, folder]
          : updateForest(state.tree.collections, parentId, (node) => ({
              ...node,
              children: [...node.children, folder],
            }));
      return { tree: { ...state.tree, collections }, dirty: true };
    });
    return folder.id;
  },

  renameNode: (id, name) => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    set((state) => {
      if (!state.tree) return {};
      return {
        tree: {
          ...state.tree,
          collections: state.tree.collections.map((node) => renameInNode(node, id, trimmed)),
        },
        dirty: true,
        draft:
          state.draft && state.draft.id === id ? { ...state.draft, name: trimmed } : state.draft,
      };
    });
  },

  deleteNode: (id) => {
    set((state) => {
      if (!state.tree) return {};
      const { forest } = removeNodeFromForest(state.tree.collections, id);
      // Drop the selection when the removed subtree held the selected request.
      const stillSelected =
        state.selectedRequestId === null || forestHasRequest(forest, state.selectedRequestId);
      return {
        tree: { ...state.tree, collections: forest },
        dirty: true,
        ...(stillSelected ? {} : { selectedRequestId: null, draft: null }),
      };
    });
  },

  deleteRequest: (id) => {
    set((state) => {
      if (!state.tree) return {};
      const collections = state.tree.collections.map((node) => removeRequestInNode(node, id));
      return {
        tree: { ...state.tree, collections },
        dirty: true,
        ...(state.selectedRequestId === id ? { selectedRequestId: null, draft: null } : {}),
      };
    });
  },

  setActiveEnvironment: (id) => {
    set({ activeEnvironmentId: id });
  },

  saveEnvironment: (environment) => {
    set((state) => {
      if (!state.tree) return {};
      const exists = state.tree.environments.some((env) => env.id === environment.id);
      const environments = exists
        ? state.tree.environments.map((env) => (env.id === environment.id ? environment : env))
        : [...state.tree.environments, environment];
      return {
        tree: { ...state.tree, environments },
        dirty: true,
        activeEnvironmentId: state.activeEnvironmentId ?? environment.id,
      };
    });
  },

  removeEnvironment: (id) => {
    set((state) => {
      if (!state.tree) return {};
      const environments = state.tree.environments.filter((env) => env.id !== id);
      return {
        tree: { ...state.tree, environments },
        dirty: true,
        activeEnvironmentId:
          state.activeEnvironmentId === id
            ? (environments[0]?.id ?? null)
            : state.activeEnvironmentId,
      };
    });
  },

  setBaseUrl: (value) => {
    const { tree, activeEnvironmentId, saveEnvironment } = get();
    const environment = pickEnvironment(tree, activeEnvironmentId);
    if (!environment) return;
    const hasRow = environment.variables.some((row) => row.key === BASE_URL_VARIABLE);
    const variables = hasRow
      ? environment.variables.map((row) =>
          row.key === BASE_URL_VARIABLE ? { ...row, value, enabled: true } : row
        )
      : [...environment.variables, { key: BASE_URL_VARIABLE, value, enabled: true }];
    saveEnvironment({ ...environment, variables });
  },

  send: async () => {
    const { draft, sendState, tree, activeEnvironmentId } = get();
    if (!draft || sendState.status === "sending") return;

    // Resolve first: templates and a relative URL are only meaningful with the
    // active environment's variables, and a half-resolved URL must never reach
    // the engine (it would percent-encode the leftover braces).
    const resolved = resolveRequest(draft, pickEnvironment(tree, activeEnvironmentId));
    const startedAt = Date.now();
    if (resolved.problem || resolved.missing.length > 0) {
      set({
        activeRequestId: null,
        sendState: {
          status: "error",
          response: null,
          errorMessage: resolveErrorMessage(resolved.problem, resolved.missing),
          startedAt,
        },
      });
      return;
    }

    const requestId = crypto.randomUUID();
    const request: SendRequest = { ...resolved.payload, requestId };
    set({
      activeRequestId: requestId,
      sendState: { status: "sending", response: null, errorMessage: null, startedAt },
    });
    try {
      const response = await apiSendRequest(requestId, request);
      if (get().activeRequestId !== requestId) return; // cancelled meanwhile
      set({
        activeRequestId: null,
        sendState: { status: "done", response, errorMessage: null, startedAt },
      });
    } catch (error) {
      if (get().activeRequestId !== requestId) return; // cancelled meanwhile
      set({
        activeRequestId: null,
        sendState: { status: "error", response: null, errorMessage: messageOf(error), startedAt },
      });
    }
  },

  cancel: async () => {
    const requestId = get().activeRequestId;
    if (!requestId) return;
    try {
      await apiCancelRequest(requestId);
    } finally {
      set((state) => ({
        activeRequestId: null,
        sendState: { ...state.sendState, status: "cancelled" },
      }));
    }
  },
}));
