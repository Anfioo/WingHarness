# Origin: space-preview-core

Adapted from [SpacePreview](https://github.com/likehao19/SpacePreview), a
standalone desktop previewer.

- Upstream version at import: **0.10.22**
- Upstream commit: **db531eb** (2026-11-09), see the `.dev/Projects/SpacePreview`
  checkout
- License: MIT — one-way compatible with this project's GPL-3.0-only.
- Imported subtree: `src-tauri/src/` (the Rust side only)

## Status

This crate is the baseline (A0) of a staged port. It currently holds the
frozen command surface, the DTOs, the in-memory path allowlist, the preferences
store and empty agent entry points. The file I/O, the Windows keyboard hook /
Shell COM agent, PowerPoint conversion, HTML resources and system icons land in
later lanes (B1/B2/B3).

The upstream crate was not copied byte-for-byte: the commands are renamed with
the `sp_` prefix, the data directory comes from this app's `config::dir()`, and
the wiring that belonged to the upstream app shell (updater, autostart, macOS,
QuickLook) is not carried over.

## What is kept

| Local file | Upstream file | Notes |
|------------|---------------|-------|
| `src/models.rs` | `src/lib.rs` | `PreviewFileInfo`, `WriteResult`, `AgentStatus`, `InitialPaths`, `PreviewPreferences` |
| `src/state.rs` | `src/lib.rs` (allowed-path state) | In-memory allowlist; `inspect` first, read second |
| `src/agent/` | `src/windows_agent.rs`, `src/everything.rs`, `src/shortcut.rs` | Entry points only; B2 ports the hook, Shell COM and Everything reader |

## What changes

| Local file | Notes |
|------------|-------|
| `src/error.rs` | `SpacePreviewError` with the kebab-case codes the frontend maps to i18n |
| `src/paths.rs` | Paths below `<data dir>/preview` instead of the upstream app's own layout |
| `src/prefs.rs` | `preview.json` written atomically; a corrupt file is moved aside |
| `src/commands/` | One module per domain, all names prefixed `sp_` |

## What is dropped

- The updater and autostart registration.
- The macOS implementation (`macos_*`), the QuickLook named pipe.
- DWG/CAD, 3D models, professional image long tail and design-thumbnail
  decoders; Graphviz (EPL-2.0) is not ported either.
