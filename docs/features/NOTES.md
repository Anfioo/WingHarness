# Notes

The **笔记** (Notes) page is Markdown notes — one file per meeting, task or idea.
It sits in the sidebar under **Agent** and uses the same editor as the
[Project](./PROJECT.md) page; only the source of the files differs. Project edits
the working copy, notes edit a private folder in the data directory.

Notes are plain files on disk. Nothing is stored in a database, so any editor can
open them, and a backup is a folder copy.

## Where notes live

```
<data dir>/notes/
├── welcome.md
└── …            # any nesting the user creates
```

`<data dir>` is the configurable data directory (Settings → 数据目录);
moving it moves the notes. `notes_list` walks the folder recursively and returns
files with their contents and the list of directories, in `/`-rooted POSIX form.
Files that are not valid UTF-8 are skipped silently, and symlinks are ignored.

## How it works

```
codelet Workbench ── in-memory FileSystem ──▶ notes store (src/pages/notes/store.ts)
       ▲                                              │
       └── loadWorkspace: notes_list ─────────────────┘

fs.onDidChange ── debounce 500 ms ──▶ reconcileOnce(fs)
    notes_write for every file whose text differs
    notes_mkdir  for every new directory
    notes_delete for every file gone from memory
    notes_delete for directories, deepest first
```

The whole tree is reconciled on every pass rather than applying the individual
change, because a directory rename raises one event for two names and none at all
for the children that moved with it. A running/again latch serialises overlapping
passes, so a burst of edits still produces one write per file.

First run seeds `welcome.md` and writes it immediately, so the folder is never
empty.

| Command | Parameters | Returns |
| --- | --- | --- |
| `notes_list` | — | `{ files: [{ path, content }], directories: [] }` |
| `notes_write` | `path`, `content` | — |
| `notes_mkdir` | `path` | — |
| `notes_delete` | `path` | — (recursive for a directory) |
| `notes_rename` | `from`, `to` | — |

Every path goes through the same `safe_join` confinement the Project page uses.

`notes_rename` is exported but unused: the page renames in memory and lets the
reconciler delete and re-create. Wiring it back in would save a write per rename
but has to handle the children that move with the folder.

## What the page offers

The codelet workbench with search, the extensions view, the Markdown preview and
the file preview extension. A file tree on the left, tabs in the middle,
draggable panes. The first note opens by default.

### Reading a note

A `.md` file opens in codelet's text editor, so editing is unchanged. **Open
Preview** on the editor tab strip opens a second tab that renders the same
document, and **Open Source** returns to the text one.

The rendering is the [Markdown editor](./MD_EDITOR.md)'s own: `renderMarkdown`
(marked + DOMPurify + highlight.js) and `PreviewPane` (KaTeX, Mermaid, local
images), with the document outline beside it. All of it ships with the app, so
the preview needs no network. It replaces codelet's `markdownPreview`, which
fetched `md4x` and its wasm from `esm.sh` at runtime.

The preview follows the buffer while it is edited: the extension
(`src/lib/editor/markdown-preview-extension.ts`) writes each open document's text
into `useMarkdownPreviewDocs` on every change, and the tab
(`src/lib/editor/markdown-preview-tab.tsx`) renders it after a 150 ms pause. The
text travels through that store rather than through the tab's surface descriptor
so a keystroke does not rebuild the tab strip. Images resolve against
`<data dir>/notes`, and the icon in the preview's top-right corner shows or hides
the outline.

The workbench keeps open and active tabs in refs, so toggling the extensions view
or switching the UI language — both of which remount the shell — does not lose a
buffer. Editor preferences (font, theme, line numbers, extensions view) are shared
with the Project page and kept in the `editor-prefs` `localStorage` key.

## Limits

- **Last writer wins.** There is no etag and no merge. If a note is edited in
  another editor while the page holds a stale buffer, the page's next save
  overwrites it.
- **Disk changes are only seen at load.** There is no watcher, and a file that
  appears on disk after the page loaded is **deleted** by the next reconciliation,
  because from the store's point of view it does not exist.
- **Everything is read at startup.** `notes_list` returns full contents for every
  file, so a `notes` folder holding large files costs memory and load time.
- **No UI state is persisted.** Open tabs survive a remount, not a reload.
- Deleting a note or a folder is immediate — the tree UI's own confirmation is
  the only guard.

## Wiring this module into another app

1. Add `notes.rs` to the commands module and register the five commands through
   `invoke.rs`, `build.rs` and `capabilities/default.json`.
2. Copy `src/pages/notes` — it depends on `src/lib/editor`, the file preview
   extension and the Markdown preview extension, all of which the Project page
   needs as well.
3. Nothing else: the folder is created on demand under the data directory.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "笔记保存失败，请检查数据目录是否可写" | The data directory is read-only, or the folder was deleted while the app ran |
| A note written by another program disappears | The reconciler treats unknown files as deleted — reload first |
| A note is missing from the tree | It is not valid UTF-8, or it is a symlink |
| Edits in two windows overwrite each other | Both windows reconcile independently; last write wins |
| The editor is empty on first launch | `welcome.md` could not be written — check the data directory |
