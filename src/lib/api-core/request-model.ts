/**
 * Factories and small validators for the API client model. Everything is
 * initialised to the frozen spec defaults so a freshly created object is always
 * valid to send or persist.
 */
import { dynamicValue } from "@/lib/api-core/template";
import type {
  Auth,
  BodyKind,
  CollectionNode,
  Environment,
  KeyValue,
  RequestBody,
  RequestDef,
  WorkspaceTree,
} from "@/lib/api-core/types";
import { resolveUrl, type UrlProblem } from "@/lib/api-core/url";

/** Message keys the request editor can pass to i18n; kept here so callers never
 * hard-code user-facing text. */
export const REQUEST_MESSAGE_KEYS = {
  methodRequired: "apiClient.common.validation.methodRequired",
  urlRequired: "apiClient.common.validation.urlRequired",
  urlInvalid: "apiClient.common.validation.urlInvalid",
  urlUnresolved: "apiClient.common.validation.urlUnresolved",
  urlNeedsBase: "apiClient.common.validation.urlNeedsBase",
  baseUrlInvalid: "apiClient.common.validation.baseUrlInvalid",
} as const;

/** The environment variable the request URLs are resolved against. */
export const BASE_URL_VARIABLE = "baseUrl";

/** The user-facing message for each {@link UrlProblem}. */
export const URL_PROBLEM_KEYS: Record<UrlProblem, string> = {
  empty: REQUEST_MESSAGE_KEYS.urlRequired,
  invalid: REQUEST_MESSAGE_KEYS.urlInvalid,
  unresolved: REQUEST_MESSAGE_KEYS.urlUnresolved,
  missingBase: REQUEST_MESSAGE_KEYS.urlNeedsBase,
  baseInvalid: REQUEST_MESSAGE_KEYS.baseUrlInvalid,
};

/** A fresh string id (RFC 4122 UUID) for any model entity. */
export function newId(): string {
  return dynamicValue("$uuid");
}

/** An empty, disabled-by-default key/value row. */
export function createEmptyKeyValue(): KeyValue {
  return { key: "", value: "", enabled: true };
}

/** A body set to the `none` kind with every field at its default. */
export function createEmptyBody(): RequestBody {
  return {
    kind: "none",
    text: "",
    rows: [],
    filePaths: {},
    rawContentType: "text/plain",
  };
}

/** Auth set to the `none` kind. */
export function createEmptyAuth(): Auth {
  return {
    kind: "none",
    token: "",
    username: "",
    password: "",
    apiKeyName: "",
    apiKeyValue: "",
  };
}

/** A new request with method `GET`, no URL, and engine-default timeout/redirects. */
export function createEmptyRequest(name: string): RequestDef {
  return {
    id: newId(),
    name,
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: createEmptyBody(),
    auth: createEmptyAuth(),
    variables: [],
    timeoutMs: null,
    followRedirects: null,
  };
}

/** A new, empty folder/collection node. */
export function createEmptyCollection(name: string): CollectionNode {
  return { id: newId(), name, children: [], requests: [] };
}

/** A new, empty environment. */
export function createEmptyEnvironment(name: string): Environment {
  return { id: newId(), name, variables: [] };
}

/** A new workspace at revision 0 with no collections or environments. */
export function createEmptyWorkspace(name: string): WorkspaceTree {
  return {
    id: newId(),
    name,
    revision: 0,
    collections: [],
    environments: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Kinds whose body is edited as key/value rows rather than free text. */
function usesRows(kind: BodyKind): boolean {
  return kind === "form" || kind === "multipart";
}

/**
 * Switch a body's kind while keeping the values that still apply: free text is
 * preserved between `json` and `raw`, rows are preserved between `form` and
 * `multipart`, and a single blank row is seeded when a row-based kind is picked
 * with no rows yet. Switching to `none` keeps the payload so it can be restored.
 */
export function withBodyKind(body: RequestBody, kind: BodyKind): RequestBody {
  const next: RequestBody = { ...body, kind };
  if (usesRows(kind) && next.rows.length === 0) {
    next.rows = [createEmptyKeyValue()];
  }
  if (kind === "raw" && next.rawContentType.trim() === "") {
    next.rawContentType = "text/plain";
  }
  return next;
}

/** Return a blank message key when the method is usable, otherwise the reason. */
export function validateMethod(method: string): string | null {
  if (method.trim() === "") return REQUEST_MESSAGE_KEYS.methodRequired;
  return null;
}

/**
 * Validate a request URL after it has been resolved against the active base
 * URL. A relative URL is accepted when `baseUrl` is usable; leftover `{{var}}`
 * placeholders are reported rather than sent verbatim.
 */
export function validateUrl(url: string, baseUrl = ""): string | null {
  const result = resolveUrl(url, baseUrl);
  return result.ok ? null : URL_PROBLEM_KEYS[result.problem];
}

/** Total requests in a node and all of its descendants. */
export function countRequests(node: CollectionNode): number {
  let total = node.requests.length;
  for (const child of node.children) total += countRequests(child);
  return total;
}

/** Collection/folder and request totals for a workspace, matching `WorkspaceMeta`. */
export function workspaceCounts(tree: WorkspaceTree): {
  collectionCount: number;
  requestCount: number;
} {
  let collectionCount = 0;
  let requestCount = 0;
  for (const collection of tree.collections) {
    collectionCount += 1 + countDescendants(collection);
    requestCount += countRequests(collection);
  }
  return { collectionCount, requestCount };
}

/** Number of nested folders beneath a node (excluding the node itself). */
function countDescendants(node: CollectionNode): number {
  let total = node.children.length;
  for (const child of node.children) total += countDescendants(child);
  return total;
}

/** Depth-first list of every request in a workspace, with its owning node id. */
export function flattenRequests(node: CollectionNode): { nodeId: string; request: RequestDef }[] {
  const out: { nodeId: string; request: RequestDef }[] = [];
  for (const request of node.requests) out.push({ nodeId: node.id, request });
  for (const child of node.children) out.push(...flattenRequests(child));
  return out;
}
