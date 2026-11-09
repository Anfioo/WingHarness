# Origin: space-preview-core

Adapted from [SpacePreview](https://github.com/likehao19/SpacePreview), a
standalone desktop previewer.

- Upstream version at import: **0.10.22**
- Upstream commit: **db531eb** (2026-11-09), see the `.dev/Projects/SpacePreview`
  checkout
- License: MIT — see
  [licenses/SpacePreview-LICENSE.txt](../../licenses/SpacePreview-LICENSE.txt).
  MIT is one-way compatible with this project's GPL-3.0-only.
- Imported subtree: `src-tauri/src/` (the Rust side only)

## Status

This crate is a complete port of the upstream Rust side. It owns the command
surface, the DTOs, the in-memory path allowlist, the file I/O, the text
read/write with encodings, the HTML resource reader, PowerPoint probing and
conversion, system file icons, the preferences store and the Windows space
agent (low-level keyboard hook, Shell COM selection, Everything results).

The upstream crate was not copied byte-for-byte: the commands are renamed with
the `sp_` prefix, the data directory comes from this app's `config::dir()`, the
window label is `preview` instead of the upstream's single window, and the
wiring that belonged to the upstream app shell (updater, autostart, macOS,
QuickLook) is not carried over.

## What is kept

| Local file | Upstream file | Notes |
|------------|---------------|-------|
| `src/io.rs` | `src/lib.rs` (inspect, read prefix, read range) | `MAX_READ` is 32 MiB per call |
| `src/text.rs` | `src/lib.rs` (read/write text) | `encoding_rs` encoding, etag compare-and-set, CRLF preserved |
| `src/html.rs` | `src/lib.rs` (HTML relative resources) | Reads only inside the HTML file's own directory |
| `src/presentation.rs`, `src/presentation.ps1` | `src/windows_presentation.rs`, `src/presentation.ps1` | PowerPoint COM → PDF, cached under `<data dir>/preview/presentations` |
| `src/icons.rs` | `src/windows_icons.rs` | `SHGetFileInfo` → PNG, `png` at this repo's version |
| `src/agent/windows_agent.rs` | `src/windows_agent.rs` | `WH_KEYBOARD_LL` hook, Shell COM selection on its own STA thread |
| `src/agent/everything.rs` | `src/everything.rs` | Everything result list |
| `src/agent/shortcut.rs` | `src/shortcut.rs` | Only the parsing the hook needs |
| `src/agent/mod.rs` | `src/lib.rs` (app-level show/hide) | `start`, `stop`, `set_enabled`, `show_preview_files`, `hide_preview`, `navigate`, `cancel_navigation`, `initial_paths` |
| `src/models.rs` | `src/lib.rs` | `PreviewFileInfo`, `WriteResult`, `AgentStatus`, `InitialPaths`, `PreviewPreferences` |
| `src/state.rs` | `src/lib.rs` (allowed-path state) | In-memory allowlist; `inspect` first, read second |

## What changes

| Local file | Notes |
|------------|-------|
| `src/error.rs` | `SpacePreviewError` with the kebab-case codes the frontend maps to i18n |
| `src/paths.rs` | Paths below `<data dir>/preview` instead of the upstream app's own layout |
| `src/prefs.rs` | `preview.json` written atomically; a corrupt file is moved aside |
| `src/commands/` | One module per domain, all names prefixed `sp_`; the command functions only adapt the wire arguments and forward |
| `src/agent/mod.rs` | Shows the `preview` window this app declares, not the upstream's single window |
| `src/lib.rs` (crate root) | Module list only; the root crate injects `paths::CONFIG_DIR` and manages `state::PreviewState` |

## Tests

`cargo test -p space-preview-core` covers the pure parts: path admission and
canonicalisation, read limits, text round-trips in every supported encoding,
etag mismatch, the HTML resource boundaries and the preferences store
(defaults, round-trip, corrupt recovery, no `.tmp` left behind). The real hook,
Shell COM and PowerPoint conversion cannot run unattended and are marked
`#[ignore]`; they are checked by hand with the acceptance list.

## What is dropped

- The updater and autostart registration.
- The macOS implementation (`macos_*`), the QuickLook named pipe.
- `dwg.rs` and the rest of the CAD long tail; 3D models, professional image
  long tail and design-thumbnail decoders; Graphviz (EPL-2.0) is not ported.
- The upstream diagnostics recorder beyond what the hook logs itself.

## Later upstream changes

The crate is first-party code edited here. A later upstream change has to be
re-read against these tables rather than merged: the hook and Everything reader
stay close to upstream, the command wrappers, error type, paths and preferences
do not.
