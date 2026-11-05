# Markdown Editor

## Overview

The Markdown editor is a single page at `/md-editor`. It opens Markdown documents
in place — the files stay wherever they are on disk — and provides multi-tab
editing, a live preview, an outline, and HTML / long-image / PDF export.

- Page: `src/pages/md-editor/` (React 19 + Zustand, one module-level store)
- Editor: CodeMirror 6 (`src/features/md-editor/editor/`)
- Engine: `src-tauri/md-editor-core` (Rust), a `tauri::command` surface of 13
  commands registered in `src-tauri/src/invoke.rs`
- Frontend command wrappers: `src/commands/services/md-editor/`

## Data Directory

Everything the editor persists lives under `<data dir>/md-editor/`, so the whole
feature moves with the data directory. Nothing is written to `localStorage`.

| File | Contents |
|------|----------|
| `settings.json` | Typography, editor behaviour, default view and export defaults. |
| `session.json` | Open tabs, carets, scroll offsets and view modes of the last run. Untitled tabs are never stored; at most 50 tabs. |
| `recent.json` | Recently opened documents, newest first, at most 30 entries. Missing files are flagged on read. |

The directory is resolved once at startup (`md-editor-core/src/paths.rs`).

## Views

Three view modes per tab, switchable in the tab bar:

- **Read** — preview only. The source editor is hidden and mounted read-only.
- **Source** — editor only.
- **Split** — editor and preview side by side, separated by a draggable divider.
  The ratio is persisted in `settings.view.splitRatio`.

The outline panel is an optional left column (`settings.view.outlineVisible`,
width `settings.view.outlineWidth`). Clicking a heading moves the caret to that
line and scrolls the preview to it.

### Scroll Sync

In split mode the two panes follow each other. The preview renderer stamps every
outermost block with a 0-based `data-source-line`; those pairs form the
interpolation samples. A 120 ms window suppresses echo — the pane that just
moved ignores the scroll event it caused on the other side. Samples are rebuilt
when the rendered HTML changes, when local images finish loading, and on resize.

## Editing

### Shortcuts

| Keys | Action |
|------|--------|
| `Ctrl+N` | New untitled tab |
| `Ctrl+O` | Open file |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save as |
| `Ctrl+W` | Close tab |
| `Ctrl+B` / `Ctrl+I` | Bold / italic (toggles: a second press unwraps) |
| `Ctrl+K` | Insert link |
| `Ctrl+1` … `Ctrl+6` | Set heading level |
| `Ctrl+F` | Find / replace panel |

`Ctrl` is `Cmd` on macOS.

### Toolbar and Context Menus

The toolbar exposes inline formatting, headings, lists, block inserts and the
export menu. Actions are defined once in `src/features/md-editor/toolbar/actions.ts`
and shared by the toolbar and the editor's right-click menu.

Right-clicking the editor moves the caret to the pointer unless the click landed
inside the selection, so every menu item acts on what was clicked. The preview's
context menu is clipboard-only (copy, copy as HTML, select all) plus export; it
never edits the document.

All editing entries disable themselves while the editor state is read-only
(read mode), and the toolbar polls for that state so a view switch is reflected
immediately.

## Preview

The pipeline is `marked` → heading ids → `data-source-line` markers →
highlight.js → DOMPurify (`renderMarkdown` in `preview/render.ts`).

- Headings get slug ids; duplicates are disambiguated with `-2`, `-3`, …
- Highlighting is budgeted: a whole-document cap and a per-block cap keep large
  code blocks from stalling the render.
- Local images are read through `md_editor_read_asset` and inlined as data URLs
  (LRU cache of 64 entries, cleared when a tab closes). Unreadable or oversized
  images render a placeholder instead of a broken icon. Remote sources
  (`http`, `https`, `data`, `file`) are left to the webview.
- Preview is paused above **500 KB or 10 000 lines**; the pane says so instead of
  rendering. Editing and saving are unaffected.
- Links open through the opener plugin; only `http` / `https` are allowed.

## Export

Three targets, all offered from the toolbar menu and both context menus:

| Target | Engine | Notes |
|--------|--------|-------|
| HTML | Frontend clone of the preview | Optional inlined styles and document title. |
| Long image (PNG) | SVG `foreignObject` → canvas | Optional outline. Scale shrinks by 0.25 steps down to 0.5× when the bitmap would exceed 32 767 px a side or 268 M pixels. |
| PDF | `md_editor_export_pdf` → WebView2 `PrintToPdf` | Page size A4 or Letter, uniform margin. Rendering happens in an isolated print DOM that is removed afterwards. Outside Windows, or on a WebView2 runtime without the printing interface, the export degrades to the system print dialog. |

Every export writes to a path chosen in the save dialog; nothing is uploaded.

## Settings

Settings are read and written in one shot through `mdEditorSettingsGet` /
`mdEditorSettingsSet`. The Rust side clamps every value, so a hand-edited
`settings.json` cannot put the UI into an unusable state.

### Appearance

| Key | Default | Meaning |
|-----|---------|---------|
| `fontFamily` | `""` | Empty uses the application's editor font. |
| `fontSize` | `14` | Editor and preview body size in px. |
| `lineHeight` | `1.7` | Editor and preview line height. |
| `contentWidth` | `860` | Max preview content width in px; also the long-image width. |
| `codeFontFamily` | `""` | Empty uses the application's code font. |

### Behaviour

| Key | Default | Meaning |
|-----|---------|---------|
| `lineWrap` | `true` | Soft-wrap the source editor. |
| `lineNumbers` | `true` | Show the gutter. |
| `tabSize` | `2` | Tab width. |
| `autoSave` | `false` | Periodically save dirty tabs that already have a path. |
| `autoSaveIntervalSec` | `30` | Auto-save period; values below 5 are raised to 5. |

### View

| Key | Default | Meaning |
|-----|---------|---------|
| `defaultMode` | `split` | Mode new and restored tabs open in. |
| `splitRatio` | `0.5` | Editor share of the split. |
| `outlineVisible` | `true` | Show the outline column. |
| `outlineWidth` | `240` | Outline column width in px. |

### Export

| Key | Default | Meaning |
|-----|---------|---------|
| `htmlInlineStyles` | `true` | Inline the preview stylesheet into the HTML file. |
| `htmlIncludeTitle` | `true` | Use the document name as the HTML title. |
| `imageScale` | `2.0` | Long-image pixel density. |
| `imageIncludeOutline` | `false` | Render the outline beside the long image. |
| `pdfPage` | `a4` | `a4` or `letter`. Other values fall back to `a4`. |
| `pdfMarginMm` | `15` | Uniform page margin in millimetres. |

## Backend Commands

| Command | Purpose |
|---------|---------|
| `md_editor_open_file` | Read a document, detect encoding and EOL. |
| `md_editor_save_file` | Write a document, optionally guarded by the mtime seen on open. |
| `md_editor_file_meta` | Existence and timestamps of a path without reading it. |
| `md_editor_read_asset` | Read an image referenced by a document as a data URL. |
| `md_editor_save_binary` | Write a binary payload (long-image PNG). |
| `md_editor_export_pdf` | Render the print DOM to PDF through WebView2. |
| `md_editor_settings_get` / `_set` | Load / store `settings.json`. |
| `md_editor_recent_list` / `_add` / `_remove` | Maintain `recent.json`. |
| `md_editor_session_get` / `_set` | Load / store `session.json`. |

### Limits

| Limit | Value |
|-------|-------|
| Text file size | 64 MB |
| Binary payload | 64 MB |
| Image asset | 8 MB |
| Preview | 500 KB / 10 000 lines |
| Session tabs | 50 |
| Recent entries | 30 |

### Error Codes

`not-found`, `invalid-input`, `conflict-external-change`, `binary-file`,
`encoding-failed`, `too-large`, `unsupported`, `io`, `internal`.

Failures arrive as `{ code, message, detail }`. The UI translates the code; the
message is a fallback for codes it does not know.

## Unsaved Changes

A tab is dirty while its content differs from what was last written. Closing a
dirty tab prompts Save / Discard / Cancel, and a failed or cancelled save keeps
the tab open. Closing the window runs the same prompt for every dirty tab.

Saves carry the mtime observed on open. If the file changed on disk in the
meantime, the save is refused with `conflict-external-change` and the user
chooses Overwrite, Save as, or Cancel — no silent data loss in either direction.

Text is always held as `\n` in memory; the original EOL and encoding are stored
per tab and reapplied on write.

## Licensing

The Markdown editor is a port of TizuMark; see `THIRD_PARTY_NOTICES.md`.
