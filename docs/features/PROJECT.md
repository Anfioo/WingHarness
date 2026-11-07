# Project

The **项目** (Project) page is a readable and writable file explorer and editor
over the project root configured in **Settings → 项目**. It is the home page and
sits in the sidebar next to the notes page, and it is the same editor as that
page — the difference is where the files come from.

It is built on [codelet](https://www.npmjs.com/package/codelet), a code editor
that is a dependency rather than a framework: the page hosts a `Workbench` and
supplies it a transport. Tabs, the editor and search are codelet's; the Markdown
preview is the app's own (see [Reading a Markdown file](#reading-a-markdown-file)).

## How it works

```
codelet Workbench ──remote extension──▶ Transport (src/lib/editor/project-transport.ts)
   info / tree / read / write / mkdir / move / delete / source
        └─ invoke ─▶ project_fs commands (src-tauri/src/commands/project_fs.rs)
                        repo_root() = Settings → 项目 → projectRoot
                        safe_join() per path
```

The transport is the only app-specific part. Its interface is
`info()`, `tree(path, { depth, content })`, `read(path)`, `source(path)`,
`write(path, body, etag?)`, `mkdir`, `move`, `delete` and `watch`. The page
passes codelet a factory `(url) => Transport`; the `tauri://project` URL in the
call is a placeholder and is not used.

| Command | Parameters | Returns |
| --- | --- | --- |
| `project_info` | — | `{ name, version, readonly: false, maxFileSize, features }` |
| `project_tree` | `path?`, `depth?`, `content?` | one `RemoteEntry` (default `/`, depth 1) |
| `project_read` | `path` | `{ text, etag }` |
| `project_write` | `path`, `body`, `etag?` | `{ mtime, size, etag }` |
| `project_mkdir` | `path` | — |
| `project_move` | `from`, `to` | — |
| `project_delete` | `path` | — |

## The rules the transport enforces

**The root comes from settings.** `repo_root()` reads `projectRoot` from
`Settings → 项目`. When it is blank the page says so and every call fails with a
message rather than falling back to a default directory.

**Every path is confined.** `safe_join` strips one leading `/`, rejects empty,
`.` and `..` segments, backslashes, NUL and `:`, and asserts the result still
starts with the root. `.git` is refused at any depth.

**The tree is lazy.** `project_tree` returns one level at a time: a directory
entry simply has no `children` field until it is descended into, which is what
makes the client ask for that level when the node is expanded. Directories come
before files, alphabetically.

**Binary files are classified, not read.** A name-based test covers images,
archives, executables, fonts, PDFs and similar. Anything over **4 MiB** is listed
with `binary: true, truncated: true` and never read. `project_read` also rejects
content that is not valid UTF-8.

**Line endings survive a save.** Reads normalise CRLF to LF; a write re-applies
CRLF when the file on disk used it, so saving a file does not rewrite every line.

**Concurrent edits are detected, not merged.** The etag is `"{size}-{mtime}"`.
A write whose etag no longer matches is refused with "changed on disk, reopen and
edit again" instead of overwriting the other change.

**Nothing refreshes by itself.** There is no file watcher: `watch` is not
implemented and the toolbar's refresh re-reads the tree. That is a deliberate
choice — a watcher on a project tree that a build is writing to produces more
noise than signal.

## What else is in the window

The workbench carries a Git activity view (decorations, status, the commit pane)
and diff, compare and history tabs, all as real codelet tabs. Diffs are drawn by
codelet inside an iframe and covered by React when the app needs to paint over
them; tab state lives in `src/lib/editor/editor-tabs.ts`. Because the tabs belong
to codelet, the dirty dot and `Ctrl/Cmd+S` are codelet's — the page never installs
its own `save` handler, so saves are explicit.

The file preview from the [file preview](./FILE_PREVIEW.md) module is registered
as a codelet extension here as well
([`preview-extension.ts`](../../src/lib/editor/preview-extension.ts)): a `.docx` or
a `.png` opens as a preview tab instead of the placeholder the transport would
return. Text extensions keep their text tab.

### Reading a Markdown file

A `.md` file still opens in codelet's text editor, so editing is unchanged. The
editor tab strip's **Open Preview** opens a second tab that renders the document
with the [Markdown editor](./MD_EDITOR.md)'s own pipeline — `renderMarkdown` +
`PreviewPane` + `OutlinePanel`, all shipped with the app, so nothing is fetched
from a CDN and no wasm is downloaded. **Open Source** returns to the text tab,
and the icon in the preview's top-right corner shows or hides the outline.

The extension is
[`markdown-preview-extension.ts`](../../src/lib/editor/markdown-preview-extension.ts),
shared with the [Notes](./NOTES.md) page; it replaces codelet's network-backed
`markdownPreview`. The text reaches the tab through `useMarkdownPreviewDocs`, and
a document's images resolve against the configured `projectRoot`.

## Limits

- **No default root.** A fresh install has `projectRoot` empty, so the page shows
  its empty state until a directory is configured under `Settings → 项目`.
- **4 MiB per file.** Bigger files are visible in the tree and cannot be opened.
- **No watcher, no autosave, no conflict merge.**
- **Tabs are not persisted** across a reload.
- `.git` is invisible by design; use the Git repository page for it.

## Wiring this module into another app

1. Add `project_fs.rs` (and `fs_guard.rs`) to the commands module, register the
   seven commands through `invoke.rs`, `build.rs` and `capabilities/default.json`.
2. Make sure `config::load().project_root()` resolves; it is the single setting
   the page, the file preview and the AI config sync share.
3. Copy `src/lib/editor/` (transport, tab store, preview extension, Markdown
   preview extension) and `src/pages/project`.
4. Point the file-preview provider at the same root at startup, so
   `preview_metadata` / `preview_bytes` agree with the editor.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "未配置项目根目录" | `Settings → 项目` is empty |
| A directory shows as empty until expanded twice | The level request failed; the error is in the toast |
| A file opens as a binary placeholder | The extension is on the binary list, or the content is not UTF-8 |
| "changed on disk, reopen and edit again" | The etag moved — another process wrote the file |
| Saving rewrites the whole file | The file had no CRLF to preserve, or the editor normalised it |
| `.git` is missing from the tree | Refused by design |
| Edits from outside the app do not appear | There is no watcher; refresh the tree |
