/**
 * Payload types for the API client commands.
 *
 * The domain shapes themselves live in `@/lib/api-core/types` and are re-used
 * here rather than forked, so the wire contract stays in one place. This file
 * only adds the two things the domain model does not cover: the save result and
 * the invoke argument objects the service functions hand to `invokeCommand`.
 */
import type { ImportOptions, ImportResult, SendRequest, WorkspaceTree } from "@/lib/api-core/types";

// Re-export the domain interfaces callers of the service need, so a consumer
// can pull both the function and its types from the same module.
export type {
  Auth,
  BodyKind,
  CollectionNode,
  Environment,
  HttpMethod,
  HttpResponse,
  ImportApplied,
  ImportOptions,
  ImportResult,
  KeyValue,
  RequestBody,
  RequestDef,
  RequestSendStatus,
  SendRequest,
  SendState,
  TextFile,
  WorkspaceMeta,
  WorkspaceTree,
} from "@/lib/api-core/types";

/** `api_workspace_save` returns the new revision, not the whole tree. */
export interface WorkspaceSaveResult {
  revision: number;
}

/** Arguments of `api_workspace_save`; `expectedRevision` is `null` for "first write". */
export interface WorkspaceSavePayload {
  id: string;
  tree: WorkspaceTree;
  expectedRevision: number | null;
}

/** Arguments carrying only a workspace id. */
export interface WorkspaceIdPayload {
  id: string;
}

/** Arguments of `api_workspace_create`. */
export interface WorkspaceCreatePayload {
  name: string;
}

/** Arguments of `api_workspace_rename`. */
export interface WorkspaceRenamePayload {
  id: string;
  name: string;
}

/** Arguments of `api_send_request`; `requestId` also keys the in-flight entry. */
export interface SendRequestPayload {
  requestId: string;
  request: SendRequest;
}

/** Arguments of `api_cancel_request`. */
export interface CancelRequestPayload {
  requestId: string;
}

/** Arguments of `api_read_text_file`. */
export interface ReadTextFilePayload {
  path: string;
}

/** Arguments of `api_fetch_spec_url`. */
export interface FetchSpecUrlPayload {
  url: string;
}

/** Arguments of `api_import_apply`. */
export interface ImportApplyPayload {
  id: string;
  importResult: ImportResult;
  options: ImportOptions;
}
