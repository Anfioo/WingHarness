# MCP Hub

The **MCP Hub** page aggregates local MCP servers behind a single local endpoint.
It sits in the sidebar under **Agent** and runs in the main window.

The point is that a client — Claude Desktop, Cursor, Windsurf, anything that
speaks MCP — connects once and sees every server the hub manages, with one list
to switch servers and tools on and off, one log, and one place for tokens. The
implementation is adapted from [McpHub](https://github.com/Soflutionltd/McpHub)
(MIT); the upstream HTML dashboard is replaced by Tauri commands, and the server
runs in-process rather than as a separate binary.

## The endpoint

| Property | Value |
| --- | --- |
| Address | `127.0.0.1:24680` |
| Transport | **SSE only** — `GET /sse` to open, `POST /message?sessionId=…` to send |
| Endpoint frame | first SSE event is `endpoint` → `/message?sessionId=<id>` |
| Keepalive | comment every 15 s |
| Idle sessions | reaped after 300 s (checked every 60 s) |
| Everything else | 404 — there is no `/`, no `/api/*`, no static files |
| `OPTIONS` | 204 with permissive CORS |

There is no streamable-HTTP (`/mcp`) transport; `mcphub_endpoint_info` reports
`stdioAvailable: false` to say so. Binding retries five times 200 ms apart before
reporting failure, which covers a port still in `TIME_WAIT`.

A client is configured with type "SSE" and the URL `http://127.0.0.1:24680/sse`.

## Authentication

Tokens live in `<data dir>/.mcphub/tokens.json`:

```json
{ "tokens": { "mcphub_<uuid>": { "name": "laptop", "allowed_servers": [], "created_at": 0 } } }
```

- **A fresh install with no tokens is open.** The moment one token exists, every
  request needs `Authorization: Bearer mcphub_<uuid>` and an unauthenticated
  client gets 401.
- A legacy single token at `.mcphub/auth-token` is still honoured and is created
  automatically with mode 600 on Unix.
- `allowed_servers` is stored and shown but **not enforced** — a token can call
  any server.

## How a tool call travels

```
client ── POST /message ──▶ ProxyServer::handle_request
            → tools/call
               reject disabled server → reject disabled tool
               → execute cache (60 s)
               → ChildManager::call_tool
                    lazily start the server's pool, round-robin instances
                    retry once on a transport error
               → metrics, cache, JSON-RPC result
```

There are two exposure modes:

| Mode | Behaviour |
| --- | --- |
| `discover` (default) | Two meta-tools only: `discover(query, server?, top_k?)` and `execute(server, tool, arguments)`. A BM25 index (k1 1.2, b 0.75) ranks tools; top_k defaults to 10, maximum 50 |
| `passthrough` | Every tool exposed directly, named `server__tool` |

Tool names are namespaced with a double underscore, which is also how collisions
are resolved. A server or tool name that itself contains `__` therefore
misroutes — that is the one naming rule an operator has to respect.

## Child servers

A server entry is a stdio command:

```json
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "env": {}, "pool": 2, "disabled": false, "requestTimeoutSecs": 180 }
```

- Started with piped stdin/stdout/stderr, the parent's environment plus `env`,
  and `cmd /C` on Windows when the command is a `.cmd` shim.
- **No working directory can be set.** A child that resolves relative paths gets
  the app's working directory.
- `pool` runs that many instances, round-robined; it is omitted when 1.
- Handshake: `initialize` (protocol `2024-11-05`) → `notifications/initialized`
  → `tools/list`, retried three times with 500/1000/2000 ms backoff.
- Killed with `taskkill /PID … /T /F` on Windows.

Health monitoring pings every 30 s with a 5 s timeout, restarts up to three times
with 2/4/8 s backoff, and can be turned off in settings. Note that the "healthy"
flag for a server means *no errors recorded since start*, not "the process is
running" — `running` is a separate field.

| Timeout | Value |
| --- | --- |
| Request (global default) | 120 s, overridable per server or by `MCPHUB_REQUEST_TIMEOUT_SECS` |
| Bootstrap (`initialize`, `tools/list`) | 60 s |
| Health ping | 5 s |
| Execute cache / discover cache | 60 s / 30 s |

## Configuration

```
<data dir>/.mcphub/
├── config.json          # { mcpServers, settings, toolEnabled }
├── tokens.json
├── schema-cache.json    # last known tool list per server
├── auth-token           # legacy single token
└── logs/mcphub.log
```

If `config.json` does not exist the hub imports servers from the MCP
configuration files it can find on the machine — `~/.cursor/mcp.json`,
`~/.codeium/windsurf/mcp_config.json`, `~/.vscode/mcp.json`, and on macOS
Claude Desktop's config. Entries whose name looks like the hub itself are
skipped so a hub cannot recruit itself.

## Logs and metrics

Child stderr and MCP `notifications/message` go to an in-memory ring of 1 000
entries and to `logs/mcphub.log` as JSON lines. **Rotation is truncation**: when
the file passes 5 MiB it is deleted and started again, so there is no numbered
history to go back through.

Metrics are in memory and reset with the gateway: total requests, active
sessions, uptime, and per server requests, errors, average latency and last call
time. The UI polls; the hub emits no events.

## Commands

| Group | Commands |
| --- | --- |
| Lifecycle | `mcphub_start`, `mcphub_stop`, `mcphub_status`, `mcphub_endpoint_info` |
| Servers | `mcphub_list_servers`, `mcphub_add_server`, `mcphub_update_server`, `mcphub_remove_server`, `mcphub_set_server_enabled`, `mcphub_import_servers` |
| Tools | `mcphub_list_tools`, `mcphub_set_tool_enabled`, `mcphub_regenerate_cache` |
| Settings | `mcphub_get_settings`, `mcphub_update_settings`, `mcphub_set_mode` |
| Tokens | `mcphub_list_tokens`, `mcphub_create_token`, `mcphub_revoke_token` |
| Observability | `mcphub_recent_logs`, `mcphub_metrics` |

The gateway is **not** started automatically; starting it is what makes the
endpoint live, and the app-exit hook stops it.

## Limits

- SSE only, one endpoint, one port. A second instance on the same machine cannot
  bind 24680.
- No `cwd` per server, no shell environment introspection, no per-server tags.
- `allowed_servers` is not enforced.
- Logs are a single truncated file, no archive.
- Metrics do not survive a restart.

## Wiring this module into another app

1. Add `src-tauri/src/mcphub` and expose its commands from `invoke.rs`,
   `build.rs` and `capabilities/default.json`.
2. Copy `src/pages/mcp-hub` — it polls, so it needs no event wiring.
3. The data directory is resolved through `config::dir()`; the hub creates
   `.mcphub` itself.
4. If Claude chat is ported too, it can pass the hub's enabled servers as
   `--mcp-config`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Failed to bind 127.0.0.1:24680" | Another process — often an old instance — owns the port |
| The client gets 401 | A token exists and the client sent none or a wrong one |
| `discover` returns loading placeholders | The index is cold; the child is still starting or failed after three attempts |
| `-32602 Invalid tool name format` | Passthrough name has no `__`, or the server or tool name contains one |
| A server shows as disabled although it was enabled | `disabled: true` is still in the entry |
| Tools listed after editing `config.json` do not appear | The cache was not regenerated |
| A child cannot find a relative file | There is no `cwd` option; it inherited the app's directory |
| Logs vanish | The 5 MiB truncation deleted the file |
