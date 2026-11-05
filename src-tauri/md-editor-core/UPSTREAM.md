# Origin: md-editor-core

Ported from [TizuMark](https://github.com/tizuio/TizuMark-Markdown-Editor), a
Markdown editor with native PDF export.

- Upstream version at import: **1.2.5**
- Upstream commit: **e39ce47** (2026-11-03)
- License: GPL-3.0-only — Copyright (c) the TizuMark contributors. The full
  text is this repository's `LICENSE`.
- Imported portions: the native PDF export (WebView2 `PrintToPdf`, built on
  `webview2-com` / `windows`), outline extraction and the export approach.

## Status

The port is substantial but no file was byte-identical: the editor is a rewrite
for React 19 and CodeMirror 6 rather than a copy of TizuMark's implementation.
The crate is maintained here.

## Divergences at import

- Document I/O adds an encoding fallback for legacy Chinese files that are not
  valid UTF-8.
- Settings, recent files and session state live in this app's config directory.
- Only the PDF export and outline path follow TizuMark closely; the editing UI
  is first-party.

## Taking an upstream change

1. Locate the corresponding TizuMark module (PDF export, outline extraction).
2. Reimplement the idea here rather than copying the file.
3. `cargo test -p md-editor-core` and smoke-test the Markdown editor.
