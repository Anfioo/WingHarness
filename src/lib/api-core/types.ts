/**
 * Frozen domain model for the API client feature.
 *
 * These declarations mirror `src-tauri/api-core/src/models.rs` field-for-field:
 * camelCase names, and optional engine fields modelled as `T | null` (a value
 * that is absent on the wire is treated as `null`). Change them only together
 * with the Rust side — the model spec under `.dev/api/task/` is the contract.
 */

/** The verbs the method picker offers. Custom methods stay allowed via `string`. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** Ordered for method selectors; the index is meaningful to the UI. */
export const HTTP_METHODS: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

/** A single editable key/value row, used for params, headers, form fields and env vars. */
export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

/** Which editor the body tab shows. */
export type BodyKind = "none" | "json" | "form" | "multipart" | "raw";

/**
 * A request body. Only the fields relevant to `kind` are read:
 * `json`/`raw` use `text`, `form`/`multipart` use `rows`, and `multipart`
 * additionally looks up `filePaths` by field name.
 */
export interface RequestBody {
  kind: BodyKind;
  /** The payload for the `json` and `raw` kinds. */
  text: string;
  /** Rows for `form` (x-www-form-urlencoded) and `multipart`. */
  rows: KeyValue[];
  /** Local file path per multipart field name; only used by `multipart`. */
  filePaths: Record<string, string>;
  /** Content type for the `raw` kind; ignored by every other kind. */
  rawContentType: string;
}

/** Authentication schemes supported in v1. `apiKey` is sent as a request header. */
export type AuthKind = "none" | "bearer" | "basic" | "apiKey";

/**
 * Authentication settings. Values are stored in plain text inside the request
 * JSON — the UI must warn users about this.
 */
export interface Auth {
  kind: AuthKind;
  /** Bearer token. */
  token: string;
  /** Basic auth username. */
  username: string;
  /** Basic auth password. */
  password: string;
  /** Header name for the API key. */
  apiKeyName: string;
  /** Header value for the API key. */
  apiKeyValue: string;
}

/** A saved request. `method`, `url`, `params` and `headers` may contain `{{var}}` templates. */
export interface RequestDef {
  id: string;
  name: string;
  /** Upper-case HTTP verb, e.g. `"GET"`. */
  method: string;
  /** Target URL; may contain `{{var}}` templates. */
  url: string;
  /** Query parameters; both key and value may contain `{{var}}`. */
  params: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: Auth;
  /**
   * Request-private variables (path parameters, per-call overrides). They take
   * precedence over the active environment's variables when resolving
   * `{{var}}` templates.
   */
  variables: KeyValue[];
  /** Per-request timeout; `null` falls back to the engine default (30s). */
  timeoutMs: number | null;
  /** `null` follows the engine default (true). */
  followRedirects: boolean | null;
}

/** A collection or a nested folder. Top-level collections are plain nodes. */
export interface CollectionNode {
  id: string;
  name: string;
  /** Nested folders. */
  children: CollectionNode[];
  /** Requests attached directly to this node. */
  requests: RequestDef[];
}

/** Environment variables. Read-only in v1; editing arrives in a later phase. */
export interface Environment {
  id: string;
  name: string;
  variables: KeyValue[];
}

/** Lightweight workspace row for the workspace list. */
export interface WorkspaceMeta {
  id: string;
  name: string;
  collectionCount: number;
  requestCount: number;
  /** RFC 3339 timestamp. */
  updatedAt: string;
}

/** A full workspace document persisted as one JSON file. */
export interface WorkspaceTree {
  id: string;
  name: string;
  /** Optimistic-concurrency counter; incremented by the engine on every save. */
  revision: number;
  collections: CollectionNode[];
  environments: Environment[];
  /** RFC 3339 timestamp. */
  updatedAt: string;
}

/** The resolved payload handed to the engine; `{{var}}` is interpolated before sending. */
export interface SendRequest {
  requestId: string;
  method: string;
  /** The final URL after template interpolation; the engine does not resolve `{{}}`. */
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: Auth;
  timeoutMs: number | null;
  followRedirects: boolean | null;
}

/** The engine's response. Exactly one of `bodyText`/`bodyBase64` is non-null. */
export interface HttpResponse {
  status: number;
  statusText: string;
  /** Headers actually sent, including engine-added ones, for display. */
  requestHeaders: KeyValue[];
  headers: KeyValue[];
  finalUrl: string;
  /** Text response body; `null` for binary responses. */
  bodyText: string | null;
  /** Base64 response body; `null` for text responses. */
  bodyBase64: string | null;
  contentType: string;
  isBinary: boolean;
  /** Received byte count. */
  sizeBytes: number;
  durationMs: number;
  /** True when the body exceeded the 32 MB cap and was cut off. */
  truncated: boolean;
}

/** The parsed result of an OpenAPI import. */
export interface ImportResult {
  /** Parsed collections; usually one, named after the spec title. */
  collections: CollectionNode[];
  warnings: string[];
  /** Base URL inferred from the spec's `servers` / `host`, or `""` when absent. */
  baseUrl: string;
}

/** User options applied when importing. */
export interface ImportOptions {
  /** Prefix added to top-level collection names; empty means none. */
  namePrefix: string;
  /** Base URL written into the workspace's default environment; empty keeps it. */
  baseUrl?: string;
}

/** Result of applying an import to a workspace. */
export interface ImportApplied {
  revision: number;
  /** Number of requests added. */
  added: number;
}

/** A file read by the engine (from disk or a fetched URL). */
export interface TextFile {
  text: string;
  bytes: number;
}

/** Lifecycle of a request send, for the request panel's status indicator. */
export type RequestSendStatus = "idle" | "sending" | "done" | "error" | "cancelled";

/** UI state for one in-flight or completed send. */
export interface SendState {
  status: RequestSendStatus;
  /** Latest response, kept after completion so the panel can render it. */
  response: HttpResponse | null;
  /** Human-readable error message when `status` is `"error"`. */
  errorMessage: string | null;
  /** Epoch milliseconds when the send started; `null` while idle. */
  startedAt: number | null;
}
