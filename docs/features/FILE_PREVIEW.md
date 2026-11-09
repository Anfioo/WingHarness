# File Preview

The **文件预览** (File preview) page previews the files in a project. It sits in
the sidebar right after **笔记**, and works on whichever project the page's
project picker selects — the same folder the **项目** page opens in a window,
confined by the backend. Text-like files can also be edited in place; everything
else is display only.

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
  [`src-tauri/file-preview-core`](../../src-tauri/file-preview-core), and exposes exactly two
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
| `preview_metadata` | `path`, `root` | `PreviewMeta` | `/`-rooted path; size, mime, `previewable`, `overCap` |
| `preview_bytes` | `path`, `root` | raw IPC bytes | Refused past the configured threshold and for anything outside the project root |

`path` is always root-relative and `/`-rooted, the form the file tree already
speaks. `root` comes from the caller: the page passes the project its picker
selected, the project window passes its own folder, and the notes page passes the
notes directory — so a preview always reads from the same place the file was
listed.

The size threshold is read from `config.json` on every call
(`filePreview.maxBytes`), so a change in **设置 → 文件预览设置** applies to the
next file opened without a restart. The default is 64 MiB; the settings page
offers 1 MiB–1 GiB and the backend clamps to the same range, which keeps a
hand-edited config from asking the webview to hold the whole disk.

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

## Settings

**设置 → 文件预览设置** (Settings → File preview) holds the two options this
page reads, both stored under `filePreview` in `config.json`:

- **文件大小阈值** — `maxBytes`, stored in bytes and shown in MB.
- **语法高亮** — `highlight`, which reaches the text preview and the editor,
  here and in the preview tabs of the **项目** and **笔记** pages.

The sections share `useConfigDraft`, which saves 400 ms after the last change and
then emits `config-changed`; `useFilePreviewConfig` listens for that event, so an
open preview window repaints with the new settings without a reload.

## Editing

The pencil in the toolbar opens the raw file in a lightweight editor. It is shown
only when the viewer treats the file as text — Markdown, JSON/YAML/XML/TOML,
source code, logs — or when the fallback decoded the bytes as text, and never for
a file past the threshold. Spreadsheets, documents and images stay read-only.

- **The editor is not codelet.** It is
  [`src/components/code-editor.tsx`](../../src/components/code-editor.tsx): a
  textarea with transparent text over a highlighted `<pre>`, the trick the Clash
  settings page introduced. The caret, selection, undo and IME stay native, and a
  deferred value keeps highlighting off the typing path (and off entirely past
  200 000 characters). The Clash page is another caller of the same component.
- **Raw text, not the preview.** The editor reads through `project_read`, so
  Markdown is edited as Markdown rather than as the rendered HTML, and JSON as
  the file has it rather than the indented copy the viewer prints.
- **Saves are compare-and-set.** `project_write` carries the etag from the read
  and refuses the write when the file changed on disk meanwhile; the error is
  shown as a toast and the text stays in the editor. CRLF files keep their line
  endings.
- **Ctrl/Cmd+S** saves without leaving the keyboard; **Tab** inserts two spaces.
  A dot in the toolbar marks unsaved changes, and picking another file or
  project — or **退出编辑** — asks before discarding them.
- **Highlighting follows the file name.** `languageOf` maps the path to a
  highlight.js grammar registered by
  [`src/lib/git-core/highlight.ts`](../../src/lib/git-core/highlight.ts); an
  unknown extension is plain text.

## In the editors

The same viewer is registered as a codelet extension
([`src/lib/editor/preview-extension.ts`](../../src/lib/editor/preview-extension.ts))
on both the **笔记** and **项目** pages, so a file the text editor cannot read —
a `.docx`, a `.png` — opens as a preview instead of the placeholder the transport
writes in place of bytes.

- Only the formats text editing is worse at are claimed. Extensions listed in
  `TEXT_EXTENSIONS` (Markdown, JSON, TOML, the common source extensions, `csv`,
  `tsv`, `svg`, HTML) keep their text tab; every other registry format is taken
  from the single generated `**/*.{…}` selector, so adding a renderer to
  `registry.ts` also claims it here.
- The panel itself draws nothing: the extension only forwards the opened path,
  and the host's [`PreviewTab`](../../src/components/file-preview/preview-tab.tsx)
  covers the workbench and loads the file exactly as this page does — same
  `PreviewPane`, same viewers. Its ✕ closes the tab, which is what goes back to
  the editor.
- codelet's own **View: Reopen Editor With…** is the way to force a claimed file
  back to the text editor for a one-off look.

## Limits

- **Text files are editable; everything else is not.** A viewer that renders a
  structured format (HTML, spreadsheets, documents, images, archives) has no
  editor, and a file past the threshold is not read at all.
- **Configurable cap, default 64 MiB.** Bigger files are listed but not read; the
  pane says so instead of loading them. The cap is enforced in the backend as
  well as advertised in the metadata, so a direct call cannot sidestep it.
- **Dark mode.** Viewer content keeps its light "paper" colors on purpose — a
  document should look like a document in either theme. The surrounding chrome
  follows the theme.

## Adding a format

1. Add a renderer under `src/lib/preview/viewers/` and a descriptor in
   `viewers/registry.ts` (extension → renderer).
2. Add the extensions to `PREVIEWABLE` in
   `src-tauri/file-preview-core/src/mime.rs` so the metadata's `previewable` flag and
   the MIME guess stay in step.
3. If the format needs a new dependency, add it to `package.json` and keep the
   renderer on a dynamic `import()` so it stays out of the first-load bundle.

The lifted files under `src/lib/preview/viewers` and `src/lib/preview/lib` keep
their upstream formatting and are listed in `.prettierignore`; host-owned files
in the same tree (`preview.css`, `types.ts`) are formatted as usual.