// API client command service.
//
// Thin, one-to-one wrappers over the `api-core` Rust commands so callers stay
// close to the engine's own shape. The engine args are snake_case on the Rust
// side (`expected_revision`, `request_id`, `import_result`); Tauri maps the
// camelCase keys sent here onto them.

import { invokeCommand } from "../../base";
import type {
  HttpResponse,
  ImportApplied,
  ImportResult,
  ImportOptions,
  SendRequest,
  TextFile,
  WorkspaceMeta,
  WorkspaceTree,
} from "@/lib/api-core/types";
import type {
  CancelRequestPayload,
  FetchSpecUrlPayload,
  ImportApplyPayload,
  ReadTextFilePayload,
  SendRequestPayload,
  WorkspaceCreatePayload,
  WorkspaceIdPayload,
  WorkspaceRenamePayload,
  WorkspaceSavePayload,
  WorkspaceSaveResult,
} from "./types";

/** App version, for the picker's diagnostics line. */
export function apiAppVersion(): Promise<string> {
  return invokeCommand<Record<string, never>, string>("api_app_version", {});
}

/** Every saved workspace, as lightweight rows for the list. */
export function apiWorkspacesList(): Promise<WorkspaceMeta[]> {
  return invokeCommand<Record<string, never>, WorkspaceMeta[]>("api_workspaces_list", {});
}

/** Create a workspace and return its row. */
export function apiWorkspaceCreate(name: string): Promise<WorkspaceMeta> {
  return invokeCommand<WorkspaceCreatePayload, WorkspaceMeta>("api_workspace_create", { name });
}

/** Rename a workspace and return its updated row. */
export function apiWorkspaceRename(id: string, name: string): Promise<WorkspaceMeta> {
  return invokeCommand<WorkspaceRenamePayload, WorkspaceMeta>("api_workspace_rename", {
    id,
    name,
  });
}

/** Delete a workspace and its stored tree. */
export function apiWorkspaceDelete(id: string): Promise<void> {
  return invokeCommand<WorkspaceIdPayload, void>("api_workspace_delete", { id });
}

/** Load a workspace's full tree. */
export function apiWorkspaceLoad(id: string): Promise<WorkspaceTree> {
  return invokeCommand<WorkspaceIdPayload, WorkspaceTree>("api_workspace_load", { id });
}

/**
 * Save a workspace tree. `expectedRevision` is the revision the caller believes
 * it holds; the engine rejects a mismatch with a conflict error and returns the
 * new revision on success.
 */
export function apiWorkspaceSave(
  id: string,
  tree: WorkspaceTree,
  expectedRevision: number | null
): Promise<WorkspaceSaveResult> {
  return invokeCommand<WorkspaceSavePayload, WorkspaceSaveResult>("api_workspace_save", {
    id,
    tree,
    expectedRevision,
  });
}

/** Send a request; `requestId` is the ticket `apiCancelRequest` takes. */
export function apiSendRequest(requestId: string, request: SendRequest): Promise<HttpResponse> {
  return invokeCommand<SendRequestPayload, HttpResponse>("api_send_request", {
    requestId,
    request,
  });
}

/** Cancel an in-flight send; resolves true when the id was in flight. */
export function apiCancelRequest(requestId: string): Promise<boolean> {
  return invokeCommand<CancelRequestPayload, boolean>("api_cancel_request", { requestId });
}

/** Read a local text file (an OpenAPI spec from disk). */
export function apiReadTextFile(path: string): Promise<TextFile> {
  return invokeCommand<ReadTextFilePayload, TextFile>("api_read_text_file", { path });
}

/** Fetch a text document over HTTP (an OpenAPI spec from a URL). */
export function apiFetchSpecUrl(url: string): Promise<TextFile> {
  return invokeCommand<FetchSpecUrlPayload, TextFile>("api_fetch_spec_url", { url });
}

/** Merge a parsed import into a workspace, returning the new revision and count. */
export function apiImportApply(
  id: string,
  importResult: ImportResult,
  options: ImportOptions
): Promise<ImportApplied> {
  return invokeCommand<ImportApplyPayload, ImportApplied>("api_import_apply", {
    id,
    importResult,
    options,
  });
}
