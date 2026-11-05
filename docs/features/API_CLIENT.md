# API Client

The **API 客户端** (API client) page is a Postman-like REST client: import an
OpenAPI 3.x or Swagger 2.0 document — or start from an empty workspace — then
browse the request tree, edit a request and send it. It sits in the sidebar
under **工作台**, and like the repository pages it is a picker plus one window
per workspace.

The split is deliberate: parsing, variable resolution and UI state are
TypeScript ([`src/lib/api-core`](../../src/lib/api-core)), while the files and the
sockets are Rust ([`src-tauri/api-core`](../../src-tauri/api-core)). The frontend
never holds a connection, and the engine never decides what a request means.

## Windows and routes

| Route | Renders |
| --- | --- |
| `/api-client` | The picker: workspaces, recent list, new workspace, import |
| `/api-client-window?id=…` | One workspace, frameless, 1280 × 800 (min 1024 × 640) |

The window label is `api-ws-` plus the FNV-1a 64-bit hash of the workspace id;
opening the same id again shows the existing window. The `api-ws-*` prefix must
be listed in [`capabilities/default.json`](../../src-tauri/capabilities/default.json).

A workspace window is three panes: the collection tree on the left, the request
editor in the middle (URL bar, method, tabs for params / headers / body / auth),
and the response viewer on the right (status, duration, size, headers, body,
raw JSON). The tree layout is per-workspace UI state and is kept in
`localStorage` under `api-client-layout:<id>` — not in the data directory.

## Sending a request

```
RequestPane → store.send()
  → resolveRequest(draft, environment)        src/lib/api-core/resolve-request.ts
       substitute {{vars}} and {{$dynamic}} in URL, params, headers, body, auth
       join a relative URL to the environment's baseUrl
  → api_send_request { requestId, request }
       cancel::register(requestId)
       send::send(request, token)             reqwest
  → HttpResponse { status, headers, bodyText | bodyBase64, sizeBytes, durationMs }
```

The store refuses to send before any network call when the URL reports a problem
(`empty`, `invalid`, `missingBase`, `baseInvalid`, `unresolved`) or when any
field still contains an unresolved `{{variable}}`. That check is the reason a
half-filled environment produces an inline error instead of a 404 from the
server.

## Importing a specification

```
file or URL → api_read_text_file | api_fetch_spec_url     (8 MiB cap, 30 s timeout)
  → parseOpenApiDocument(text)                            src/lib/api-core/openapi.ts
  → preview: folders, requests, warnings
  → api_import_apply(id, result, { namePrefix, baseUrl })
  → create or update the workspace, then open its window
```

What the parser does:

| Input | Result |
| --- | --- |
| `openapi: "3.x"` | One collection, one folder per first tag, one request per operation |
| `swagger: "2.0"` | Same, with `schemes[0]` + `host` + `basePath` as the base URL |
| 3.1 documents | Parsed as 3.0, with a warning |
| Untagged operations | Collected in a folder called `Default` |
| `get put post delete options head patch` | Imported — `trace` is not |
| Local `#/` `$ref` | Resolved, cycle-guarded |
| External or URL `$ref` | Skipped, with a warning |
| `allOf` | Flattened |
| `requestBody.content` | JSON preferred, then form-urlencoded, then multipart, then raw |
| `http` bearer/basic, `apiKey` in header | Mapped to the request's auth |
| `apiKey` in query or cookie, OAuth, callbacks, webhooks | Warned and left unset |

URLs default to `{{baseUrl}}/path` with path parameters rewritten to
`{{param}}`, so one environment switch re-points every imported request. When the
`useBaseUrlVariable` option is off the spec's own server URL is baked in instead.

## Commands

| Area | Commands |
| --- | --- |
| Workspaces | `api_workspaces_list`, `api_workspace_create`, `api_workspace_rename`, `api_workspace_delete`, `api_workspace_load`, `api_workspace_save` |
| Import | `api_read_text_file`, `api_fetch_spec_url`, `api_import_apply` |
| Send | `api_send_request`, `api_cancel_request` |
| Misc | `api_app_version` |

Collections, requests and environments have no commands of their own: they are
fields of the `WorkspaceTree` that `api_workspace_save` writes whole. Saving is
manual and takes an `expectedRevision`; a stale revision is rejected with code
`conflict` instead of overwriting a window that saved first.

Errors serialise as `{ code, message }` with `http`, `io`, `not_found`, `json`,
`url`, `conflict`, `cancelled` or `other`.

## Data layout

```
<data dir>/.api-client/
├── workspaces.json      # index of { id, name, … }
└── <id>.json            # one WorkspaceTree: collections, environments, revision
```

Workspace ids are at most 64 characters of `[A-Za-z0-9_-]`, and names are
sanitised (100 characters, no Windows-illegal characters, no reserved device
names, no trailing dot or space). Both files are written through a
`*.json.<nanos>.json.tmp` + rename, so a crash cannot leave a half-written
workspace.

The spec cap is **8 MiB** (`MAX_TEXT_BYTES` in `api-core/src/commands.rs`),
enforced both on a local file (by metadata) and on a URL (by `Content-Length`
and by the bytes actually read). The fetch gives up after 30 s.

## Transport rules

The engine uses `reqwest` with rustls, gzip/brotli/deflate and multipart.

| Rule | Value |
| --- | --- |
| Schemes | `http` and `https` only |
| Timeout | 30 000 ms by default, overridable per request |
| Redirects | Followed up to 10, or not at all when `followRedirects` is off |
| TLS | System roots — a self-signed certificate fails, and there is no insecure toggle |
| Proxy / custom CA | Not supported |
| Response body | Streamed; capped at 32 MiB, then `truncated: true` |
| Text or binary | Decided by `Content-Type`; absent or non-text means binary |
| Binary body | Returned as `bodyBase64` |
| Cancellation | One `watch` token per request id, raced against connect and every chunk |

Regex body, form rows and multipart rows all go through the same variable
substitution as the URL. A multipart row can point at a file on disk; the engine
reads it on a blocking thread so a large upload cannot stall the async runtime.

## Limits

- **No request history, no cookies, no auth vault.** Auth values are stored in
  clear text inside the workspace JSON — treat the data directory as sensitive.
- **The active environment is in memory only.** Reloading the window falls back
  to the first environment.
- **No streaming UI.** A response is rendered when it finishes, not as it
  arrives.
- **Save is manual** and one window wins; `api_import_apply` does not pass an
  expected revision, so an import can bump the revision under an open window,
  which then fails to save until it is reloaded.
- Display encoding and wire encoding can differ: the URL bar uses
  `encodeURIComponent` (space becomes `%20`) while `reqwest` encodes a form space
  as `+`.

## Wiring this module into another app

1. Add `api-core` to `src-tauri/Cargo.toml` and expose its commands from
   `invoke.rs`.
2. Add every `api_*` command to `build.rs` `COMMANDS` and grant `allow-api-*`;
   add `api-ws-*` to the capability's window list.
3. Set `api_core::store::CONFIG_DIR` in setup.
4. Copy `src/lib/api-core`, `src/features/api-client`,
   `src/pages/api-client` and `src/lib/api-windows.ts`.
5. `yaml` is required at runtime for YAML specifications; nothing else is
   imported dynamically.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "not allowed by ACL" on any `api_*` call | Missing from `build.rs` or `capabilities/default.json` |
| `conflict`: "changed elsewhere; reload it and try again" | Another window saved first — the revision is stale |
| Send is blocked before any network call | An unresolved `{{var}}`, or a URL problem such as a missing `baseUrl` |
| "unsupported URL scheme" | A leftover `{{baseUrl}}` or a non-HTTP URL |
| The request fails instantly with a certificate error | Self-signed or untrusted TLS; there is no bypass |
| The body shows a binary notice | The response has no text `Content-Type` |
| `sizeBytes` sits at 32 MiB with a truncation badge | The body cap was hit |
| "the document is N bytes; the limit is 8 MiB" | The specification is too large |
| "the api client data directory has not been initialised" | `CONFIG_DIR` was never set during setup |
| The import preview is empty | No supported operations, or every `$ref` was external — the warnings explain which |
| Cancel does nothing | The send already finished, or the request id does not match |
