# Origin: agent-chat-core

Adapted from
[desktop-cc-gui](https://github.com/zhukunpenglinyutong/desktop-cc-gui)
(`ccgui-next`).

- Upstream version at import: **1.2.2**
- Upstream commit: **1c2888f** (2026-11-02)
- License: MIT — Copyright (c) 2026 zhukunpenglinyutong（朱昆鹏）. The full text is
  in `licenses/desktop-cc-gui-LICENSE.txt`.
- Imported portions: the engine transport layer, the Claude, Codex app-server
  and ACP adapters, the batched event sink, and the Claude/Codex native session
  scanners.

## Status

Trimmed port plus rewrite, not a wholesale copy. Files that carry upstream logic
start with an attribution header naming desktop-cc-gui and the MIT licence.
`history/scanner.rs` and `history/reader.rs` were rewritten against this
repository's constraints; the front-end is a rewrite against the local component
system.

## Module map

| Upstream | Here | Treatment |
| --- | --- | --- |
| `src-tauri/src/engine/mod.rs` | `src/engine/mod.rs` | Trimmed port: `Engine` trait, transport split, `SendRequest`, `BuiltCommand` and the send pipeline. Provider, memory, computer-use, plan, fork, plugin and mission code dropped. |
| `src-tauri/src/engine/events.rs` | `src/engine/events.rs` | Trimmed port of the normalized-event vocabulary frozen in plan §6.2. |
| `src-tauri/src/engine/reader.rs` | `src/engine/reader.rs` | Trimmed port: `TurnState`, dispatch, EOF settling and stdout parsing. Follow-up, plan, MCP and generation-metrics paths dropped. |
| `src-tauri/src/engine/registry.rs` | `src/engine/registry.rs` | Trimmed port: run/session dual keys, kill, `live_run_ids`, stdin writes and parked questions. |
| `src-tauri/src/engine/resolve.rs` | `src/engine/resolve.rs` | Rewritten with `std`: `PATH`/`PATHEXT`, npm global prefix and `.cmd`/`.ps1` wrappers. `which` and `dirs` are not used. |
| `src-tauri/src/engine/claude.rs` | `src/engine/claude.rs` | Trimmed port: stream-json projection, tool rows, control requests, permission denial. Plan and memory paths dropped. |
| `src-tauri/src/engine/codex.rs` | `src/engine/codex.rs` | Trimmed port of the app-server command construction; `codex exec` was not carried over. |
| `src-tauri/src/engine/codex_app.rs` | `src/engine/codex_app.rs` | Trimmed port: spawn → `initialize` → `thread/new` or `thread/resume` → `turn/start` → notification projection → question answers. |
| `src-tauri/src/engine/qoder.rs` | `src/engine/qoder.rs` | Direct port with attribution header. Only the Global distribution is registered. |
| `src-tauri/src/engine/qoder_session.rs` | `src/engine/acp.rs` | Trimmed port under a new name: JSON-RPC framing, handshake, model/config selection, prompt and `session/update` projection. |
| `src-tauri/src/history/mod.rs` | `src/history/mod.rs` | Trimmed port: `Message`, a reduced `SessionMeta`, and the shared text/date helpers. |
| `src-tauri/src/history/discovery.rs` | `src/history/discovery.rs` | Only the Claude and Codex discovery paths were carried over. |
| `src-tauri/src/history/extract.rs` | `src/history/extract.rs` | Only `extract_claude_line`, `extract_codex_line`, `fold_rows`, `scan_summary_file` and their helpers. |
| `src-tauri/src/history/scanner.rs` | `src/history/scanner.rs` | **Rewritten**: no SQLite. Enumerate → head/tail summary → in-process cache keyed by `(path, size, mtime)`. |
| `src-tauri/src/history/reader.rs` | `src/history/reader.rs` | **Rewritten**: pure-file paging only. Archive, remote, delete, rename and sub-agent folding were dropped. |
| `src-tauri/src/history/codex_titles.rs` | `src/history/codex_titles.rs` | Direct port. |
| `src-tauri/src/event_sink.rs` | `src/engine/sink.rs` | Direct port of the 16 ms / 64 KiB batched `agent:event` output. |

Dropped entirely:

- The other ten engine adapters (codebuddy, pi family, agy, opencode, grok,
  kimi, minimax, omp-acp, dsh, …) — scope was cut to three engines.
- Plan review, provider management, memory, computer-use, fork and plugin
  modules.
- Image input, WSL transport, the model catalogue and the application-level
  SQLite store (`src-tauri/src/db.rs`).
- Front-end split view, stream-reveal animation, the conversation footer and
  run status strip, attachments and the message queue.

## Divergences at import

- **React 19 + shadcn/ui.** Upstream is React 18 with react-aria and its own
  component layer. Every component here was rewritten; behaviour follows the
  upstream, markup does not.
- **No SQLite.** Session discovery and paging read the CLIs' JSONL files
  directly, with an in-process cache. There is no index database to migrate.
- **No plan review** and no provider/memory/computer-use surface.
- **No WSL transport**; engines are spawned as local processes.
- **Three engines only**: Claude Code, Codex and Qoder. Qoder's CN
  distribution shares the ACP driver but is not registered.
- **Read-only history.** Clone, fork, rename, delete and archive are not
  available here; the existing Claude pages keep their own clone/fork support.
- **Codex runs on the app-server transport only**; `codex exec --json` was not
  carried over.
- **Markdown** renders through `streamdown` rather than upstream's
  react-markdown.

## Taking an upstream change

1. Diff the upstream module against the table above to find the local
   counterpart.
2. Apply the change by hand on top of the local edits; keep the attribution
   header.
3. `cargo test -p agent-chat-core` and `pnpm build`; then smoke-test one Claude
   turn and one Codex turn from the page.
