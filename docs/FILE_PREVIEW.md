# File Preview

The **文件预览** (File preview) page is a read-only viewer for the files in the
configured project root. It sits in the sidebar right after **笔记**, and
reuses the same root the **项目** page opens — the path from
Settings → Project, resolved and confined by the backend.

It is built on the viewer subsystem of the
[Office-Viewer reference implementation](../.dev/Office-Viewer), lifted into this
repository with the heavy, rarely-used paths removed (HEIC, `.class`
decompilation, Parquet, PNG export).

## How it works

```
┌─ page ──────────────────────────────────────────────────────────────┐
│  FileTree (project_tree, one level per expand)                      │
│  PreviewPane ── preview_metadata / preview_bytes ──▶ bytes          │
│                └─ loadPreview(metadata, url, signal) ──▶ LoadState  │
│                      └─ registry → dynamic import(...renderer) ──▶ Preview │
└─────────────────────────────────────────────────────────────────────┘
```

- **The backend only reads bytes.** Every viewer parses in the webview (pdf.js,
  exceljs, mammoth, pptxviewjs, 7z-wasm, …). The Rust side is a separate crate,
  [`src-tauri/file-preview`](../src-tauri/file-preview), and exposes exactly two
  commands.
- **The file tree is lazy.** `project_tree` returns one directory level at a
  time, so a project holding `node_modules` and build output costs
  only what is on screen. `.git` is never served.
- **Renderers are code-split.** Each format is an `await import('./xxxRenderer')`,
  so a window that never previews a spreadsheet never loads exceljs.
- **The UI is the host's.** The page, tree and toolbar are shadcn/ui + Tailwind.
  The viewer's own CSS is scoped under `.ov-preview` so its bare `button` styles
  cannot reach the rest of the app.

## Commands

| Command | Parameters | Returns | Notes |
|---------|------------|---------|-------|
| `preview_metadata` | `path` | `PreviewMeta` | `/`-rooted path; size, mime, `previewable`, `overCap` |
| `preview_bytes` | `path` | raw IPC bytes | Refused past the 64 MiB cap and for anything outside the project root |

`path` is always root-relative and `/`-rooted, the form the file tree already
speaks. Both commands resolve the root through a provider the app installs at
startup, so a change in Settings → Project takes effect on the next read.

## Supported formats

| Group | Extensions |
|-------|------------|
| Word | `docx docm dotx dotm odt ott fodt rtf` |
| Spreadsheet | `xls xlsx xlsm xltx xltm csv tsv ods ots fods` |
| Presentation | `pptx pptm ppsx ppsm potx potm odp otp fodp` |
| PDF | `pdf` |
| Image | `png jpg jpeg pjp pjpeg gif webp bmp ico avif apng cur tif tiff icns` |
| Vector / font | `svg svgz ttf otf woff woff2` |
| Archive | `zip crx jar vsix apk tar tgz tar.gz 7z rar` |
| Book | `epub fb2 cbz` |
| Visual | `xmind psd` |
| Email | `eml` |
| Audio / video | `mp3 wav ogg oga opus flac m4a aac` / `mp4 m4v webm ogv mov` |
| Text / code / markup | `md markdown html htm xhtml json yaml yml xml toml txt log` + common source extensions |

Anything else falls back to text detection, and shows "不支持预览此文件" when the
bytes are not text.

## In the editors

The same viewer is registered as a codelet extension
([`src/lib/editor/preview-extension.ts`](../src/lib/editor/preview-extension.ts))
on both the **笔记** and **项目** pages, so a file the text editor cannot read —
a `.docx`, a `.png` — opens as a preview instead of the placeholder the transport
writes in place of bytes.

- Only the formats text editing is worse at are claimed. Extensions listed in
  `TEXT_EXTENSIONS` (Markdown, JSON, TOML, the common source extensions, `csv`,
  `tsv`, `svg`, HTML) keep their text tab; every other registry format is taken
  from the single generated `**/*.{…}` selector, so adding a renderer to
  `registry.ts` also claims it here.
- The panel itself draws nothing: the extension only forwards the opened path,
  and the host's [`PreviewOverlay`](../src/components/file-preview/preview-overlay.tsx)
  covers the workbench and loads the file exactly as this page does — same
  `PreviewPane`, same viewers. Its ✕ closes the tab, which is what goes back to
  the editor.
- codelet's own **View: Reopen Editor With…** is the way to force a claimed file
  back to the text editor for a one-off look.

## Limits

- **Read-only.** Nothing on this page writes to disk; use **项目** to edit.
- **64 MiB cap.** Bigger files are listed but not read; the pane says so instead
  of loading them. The cap is enforced in the backend as well as advertised in
  the metadata, so a direct call cannot sidestep it.
- **Dark mode.** Viewer content keeps its light "paper" colors on purpose — a
  document should look like a document in either theme. The surrounding chrome
  follows the theme.

## Adding a format

1. Add a renderer under `src/lib/preview/viewers/` and a descriptor in
   `viewers/registry.ts` (extension → renderer).
2. Add the extensions to `PREVIEWABLE` in
   `src-tauri/file-preview/src/mime.rs` so the metadata's `previewable` flag and
   the MIME guess stay in step.
3. If the format needs a new dependency, add it to `package.json` and keep the
   renderer on a dynamic `import()` so it stays out of the first-load bundle.

The lifted files under `src/lib/preview/viewers` and `src/lib/preview/lib` keep
their upstream formatting and are listed in `.prettierignore`; host-owned files
in the same tree (`preview.css`, `types.ts`) are formatted as usual.