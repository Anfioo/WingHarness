# Origin: moin-core

Adapted from [moin](https://github.com/exxvius/moin), an HTTP/HTTPS download
manager built with Tauri v2.

- Upstream version at import: **0.4.0**
- Upstream commit: **79e7587** (2026-07-25)
- License: MIT — Copyright (c) 2026 moin contributors. The full text is in
  `licenses/moin-LICENSE.txt`.
- Imported sources: `src-tauri/crates/moin-core/src/`, the download/category/
  settings frontend, and `extension/`.
- Local record date: **2026-11-11**.

## Status

The crate and frontend are maintained here as first-party code. They were
reworked for this app's single-process architecture, asynchronous storage,
typed command boundary, React conventions and i18n rather than copied as a
drop-in upstream crate. Ported source files retain short MIT attribution
headers. Copying a future upstream tree over this directory would discard those
changes.

The largest architectural difference is that upstream runs its engine in a
separate `moin-daemon` process reached through loopback HTTP. WingHarness
embeds the engine in the Tauri process: `MoinState` owns it, Tauri commands and
events replace the general daemon API, and only the browser extension's small
`/ping` and `/add` RPC surface remains.

## What came from where

| Local file or directory                                  | Upstream source                            | Notes                                                                                            |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/models.rs`                                          | `src/task.rs`, category/settings models    | Task, progress, settings, category and tool DTOs; torrent-only fields removed                    |
| `src/store.rs`                                           | `src/store.rs`                             | Task table and migration semantics rewritten from rusqlite to async sqlx                         |
| `src/settings.rs`                                        | `src/settings.rs`                          | HTTP/RPC settings, atomic JSON writes and corrupt-file backup                                    |
| `src/category.rs`                                        | `src/category.rs`                          | Four HTTP-relevant trigger types, source matching and priority; unknown legacy fields round-trip |
| `src/engine.rs`                                          | `src/engine.rs`                            | Queue, task lifecycle, restart recovery, categorization, file moves and backend selection        |
| `src/backend.rs`                                         | `src/backend.rs`                           | Kept as the abstraction between the engine and the two HTTP backends                             |
| `src/embedded.rs`                                        | `src/embedded.rs`                          | Built-in HTTP backend only; librqbit paths removed                                               |
| `src/http.rs`                                            | `src/http.rs`                              | Probe, single-stream transfer, resume, stall handling and finalization                           |
| `src/segmented.rs`                                       | `src/segmented.rs`                         | Parallel `Range` segments and `.part.meta` resume plans                                          |
| `src/aria2.rs`                                           | `src/aria2.rs`                             | HTTP-only aria2 JSON-RPC backend with on-demand process lifecycle                                |
| `src/aria2_tool.rs`                                      | `src/tool.rs`                              | Explicit path, environment and `PATH` probing only; installation code removed                    |
| `src/rpc.rs`                                             | `crates/moin-daemon/src/extension.rs`      | Handwritten tokio HTTP limited to `127.0.0.1`, `/ping` and `/add`                                |
| `src/state.rs`, `src/events.rs`, `src/commands.rs`       | Host adapter layers                        | New Tauri state, event batching, notifications and thin command forwarding                       |
| `src/fsattr.rs`                                          | `src/fsattr.rs`                            | Partial-file hidden attribute, with non-Windows no-op implementations                            |
| `src/pages/moin/`, `src/components/moin/`                | `src/views/`, `src/components/`            | Three views rewritten as one three-tab React 19 page with shadcn/ui and i18next                  |
| `src/commands/services/moin/`, `src/hooks/use-moin-*.ts` | `src/lib/api.ts`, `store.tsx`, `events.ts` | Typed Tauri wrappers and page-level event subscriptions                                          |
| `extension/`                                             | `extension/`                               | MV3 browser capture with WingHarness branding and the same RPC contract                          |

## Divergences from upstream

- **Single-process engine.** The general `moin-daemon` API, endpoint handshake,
  SSE hub, `/health` probe and daemon lifecycle were not carried over. Commands
  use `moin_` prefixes and progress is batched into `moin:task-progress` events.
- **Extension RPC is retained, not the daemon API.** `rpc.rs` implements only
  `GET /ping` and authenticated `POST /add`, with CORS, a 1 MiB body limit and a
  10 s read timeout. It binds only `127.0.0.1`; an empty token never authorizes.
- **Two HTTP backends.** `backend.rs` remains in use. The built-in reqwest engine
  is the default; aria2c is an optional preference with fallback to embedded.
  aria2c is probed but never downloaded by the app.
- **Asynchronous SQLite.** The store uses a single-connection sqlx pool and WAL.
  Task upserts preserve immutable URL/creation identity while allowing the
  destination and filename to change during moves.
- **No BitTorrent or media scraping.** `torrent.rs`, `scrape.rs`, torrent UI,
  torrent RPC options and media-site handlers are absent. The `Media` enum value
  remains only as a wire-model compatibility placeholder.
- **No self-update or old-data migration.** The app uses its existing updater,
  and this feature starts with a new `<data dir>/moin` store.
- **Categories preserve opaque legacy fields.** BT automation, watch folders,
  rename/layout rules and torrent limits are not interpreted. They survive in
  the flattened `legacy` map so reading and writing `categories.json` does not
  discard them.
- **Atomic JSON recovery.** Settings and categories use temporary-file writes,
  flush and rename. Corrupt files are moved to `.bak-<unix seconds>` before
  defaults are used.
- **Typed errors and localized UI.** String errors become
  `{ code, message, detail? }`. Rust messages stay English; the frontend maps
  codes to i18n keys. The upstream hardcoded English views were extracted into
  matching English and Chinese locale objects.
- **Browser extension changes.** The extension remains source-only and is not
  packed into NSIS. Branding becomes WingHarness, the default port is 47653,
  and `moin://` automatic launching is replaced by a prompt asking the user to
  start the app manually.

## Taking an upstream change

1. Diff the relevant local file against `src-tauri/crates/moin-core/src/` or
   `extension/` in the upstream checkout at or after `79e7587`.
2. Apply the change by hand on top of the local edits. Keep the embedded
   architecture, typed errors, path helpers, English-only logs/messages and
   en/zh i18n alignment.
3. Review both backend selection and the extension RPC contract when a change
   touches transfer options, request headers or task DTOs.
4. Run `cargo test -p moin-core`, `pnpm build`, the scoped ESLint/Prettier gates
   and the download-page smoke tests. Run the aria2c ignored tests only on a
   machine with a working local binary.
