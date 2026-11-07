# Project

The **项目** (Projects) page is the app's start page and its project picker. It
lists the projects that have been opened before and lets you open another one;
opening a project gives it a window of its own. There is no single global project
any more — several projects can be open at once, each window working on its own
folder.

A project window is a readable and writable file explorer and editor, built on
[codelet](https://www.npmjs.com/package/codelet), a code editor that is a
dependency rather than a framework: the window hosts a `Workbench` and supplies
it a transport. Tabs, the editor and search are codelet's; the Markdown preview
is the app's own (see [Reading a Markdown file](#reading-a-markdown-file)).

## How it works

```
picker page (`/`)                     project window (/project-window?path=…)
  project_recent_list                    setActiveProject(path)
  project_remember(path)                     │
  project_forget(path)                       ▼
  project_set_active(path)             codelet Workbench
  openProjectWindow(path) ──focus──▶     remote extension ──▶ Transport
                                            (src/lib/editor/project-transport.ts)
                                            info / tree / read / write / mkdir /
                                            move / delete / source
                                              └─ invoke ─▶ project_fs commands
                                                           (root, path), safe_join()
```

### The picker page

`src/pages/project/index.tsx` is the `/` route and never shows a project itself.
It offers a path box with a **Browse** button (the dialog plugin's directory
picker), and the recent list below it: name, path, relative time, a search box,
a **Missing** mark for a folder that has since been deleted, and an **Open**
badge for a project with a window already on screen.

Opening a project calls `project_remember(path)` and then `openProjectWindow(path)`.
`project_remember` puts the entry at the top of the recent list and makes it the
active project; the window itself does the actual work. A window that is already
open is focused instead of recreated, so clicking the same project twice is
idempotent.

Nothing announces a project window closing — it is a plain window, not a plugin
host — so the page re-scans the open window labels on mount and on focus.

### The project window

`src/lib/project-windows.ts` creates the window with a label derived from the
normalized path (`hashedWindowLabel("project-", …)`), which is what makes the
same folder map to the same window. The path travels in the query string because
the label is a hash; `main.tsx` routes on the pathname only, so
`/project-window` reads `?path=` itself.

The window draws its own frame (`WindowFrame` + `TitleBar`). The title is the
folder name, and the back button goes back to the picker: it emits
`project-show-home`, which `useProjectHome` (mounted in `app-shell.tsx`) turns
into a navigation to `/`, and brings the main window to the front.

`project-*` must stay in the `windows` list of
`src-tauri/capabilities/default.json`; a prefix the capability does not grant
makes every command in the window fail.

### The root reaches the commands

Each webview has its own JavaScript context, so the root can live in one module
variable per window: `src/commands/project-context.ts` holds the window's active
project, set when the workbench mounts. The command wrappers in
`commands/services/project-fs`, `file-preview`, `shaic` and `database` read it,
so call sites keep their signatures.

The workbench sets it on mount and clears it on unmount — leaving it behind
would send another project's commands to a folder the window no longer shows.

## Commands

| Command | Parameters | Returns |
| --- | --- | --- |
| `project_info` | `root` | `{ name, version, readonly: false, maxFileSize, features }` |
| `project_tree` | `root`, `path?`, `depth?`, `content?` | one `RemoteEntry` (default `/`, depth 1) |
| `project_read` | `root`, `path` | `{ text, etag }` |
| `project_write` | `root`, `path`, `body`, `etag?` | `{ mtime, size, etag }` |
| `project_mkdir` | `root`, `path` | — |
| `project_move` | `root`, `from`, `to` | — |
| `project_delete` | `root`, `path` | — |

The recent list has its own commands, backed by
`src-tauri/src/projects/mod.rs` and `src-tauri/src/commands/projects.rs`:

| Command | Effect |
| --- | --- |
| `project_recent_list` | the recent list, most recently opened first |
| `project_active` | the active project path, or `null` |
| `project_remember(path)` | add to the recent list and make it active |
| `project_forget(path)` | remove from the recent list |
| `project_set_active(path)` | change the active project only |

They are stored in `<data dir>/projects.json` — the same directory as the rest
of the app's runtime state, never the project folder. Paths are compared with
separators normalized and case folded, so `E:\Work` and `e:/work/` are one
entry. The list holds at most 50 projects.

## The rules the transport enforces

**The root is the window's.** `project_root(root)` in `project_fs.rs` checks that
it is a non-empty absolute path and an existing directory. Nothing falls back to
a global setting: a window without a root is a window without a project.

**Every path is confined.** `safe_join` strips one leading `/`, rejects empty,
`.` and `..` segments, backslashes, NUL and `:`, and asserts the result still
starts with the root. `.git` is refused at any depth, and so is the root `.wh`.

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
return. Text extensions keep their text tab. The preview tab is given this
window's root.

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
a document's images resolve against the window's project root.

### The database panel

A **Database** button in the activity bar opens a data-source panel over the file
tree, the same way the commit button covers it — clicking it again closes it, and
the two are mutually exclusive because they occupy the same space. Every data
source in it belongs to the project: its definition lives in
`<project root>/.wh/db/data-sources.toml`, its query files in
`<project root>/.wh/db/query`, and the query history and row limits beside them.
Expanding a source connects to it; the connection is kept when the group is
collapsed, and disconnecting is a deliberate act.

**Passwords never enter the project directory.** A password typed in the panel
goes to the app-wide `<data dir>/db/secrets.json`, under the source's `whp-`
prefixed id — the prefix is also what routes every command to the project's own
engine. Saved passwords therefore survive a checkout, `.wh` does not carry them.

The backend keeps one project engine per root (`DbState.projects`, a map keyed
by the normalized root), so two windows on two projects have separate sources,
queries and connections, and both are live at the same time.

SQL is edited in the main editor area: a query file of that source (named
`<source name> <n>.sql`, written back 800 ms after typing stops) or any `.sql`
file of the project, which the [`sqlEditor`](../../src/features/database/project/sql-extension.ts)
extension claims for the database editor rather than codelet's text editor.
Double-clicking a table opens it as a table tab there. Results do **not** take an
editor tab: they land in a bottom dock with Output, Result N and Plan tabs, which
the Run button opens.

The panel shares its widgets with the [database page](./DATABASE.md) —
`SourceDialog`, `ObjectTree`, `TableEditor`, `ResultTabsView`, `ConsoleEditor` —
and none of its storage: `/database` never lists a project source, and this panel
never lists an app-wide one. `.wh` is excluded from the file tree, so the two
views cannot fight over the same files.

## Projects on other pages

Three pages work on a project without having one of their own. Each puts a
`ProjectPicker` at the top: a dropdown over the recent list, plus a **Manage**
button that goes to the projects page.

- [File preview](./FILE_PREVIEW.md) — which project's tree to browse.
- [AI config sync](./AI_CONFIG.md) — which project's agent files the dashboard
  reads and writes.
- [Database](./DATABASE.md) — the project a *relative* SQLite path resolves
  against, and the project a project data source belongs to.

Choosing in the picker sets the page's module-level active project and records
it with `project_set_active`, so the next of these pages starts where the last
one left off. Their data sources, files and agent state are re-read for the new
project.

A page without a picker that still needs a directory — the Claude chat page —
takes it from `project_active()` and falls back to the process's own working
directory when no project has ever been opened.

## Limits

- **No default project.** A fresh install has an empty recent list, so the picker
  shows its empty state until a folder is opened.
- **4 MiB per file.** Bigger files are visible in the tree and cannot be opened.
- **No watcher, no autosave, no conflict merge.**
- **Tabs are not persisted** across a reload — database tabs included; the
  database connections themselves stay open while the app runs.
- `.git` and the root `.wh` are invisible by design; use the Git repository page
  for the former and the database panel for the latter.
- **One window per folder.** Opening a folder that is already open focuses its
  window rather than opening a second one on the same tree.

## Wiring this module into another app

1. Add `project_fs.rs`, `fs_guard.rs`, `projects/` and `commands/projects.rs`, and
   register the twelve commands through `invoke.rs`, `build.rs`,
   `capabilities/default.json` and `permissions/autogenerated/`. Grant the
   `project-*` window prefix in the capability too.
2. Copy `src/commands/project-context.ts`, `src/commands/services/projects`, and
   `src/lib/project-{routes,windows}.ts`, plus `src/hooks/use-project-home.ts`.
   Mount `useProjectHome` in the app shell.
3. Copy `src/lib/editor/` (transport, tab store, preview extension, Markdown
   preview extension) and `src/pages/project`.
4. Pass the root explicitly to `preview_metadata` / `preview_bytes` from the
   preview tab, so a preview agrees with the editor that requested it.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "No project opened" | The window was opened without `?path=`, or the recent list is empty |
| A project window opens but every command is refused | `project-*` is missing from the capability's `windows` |
| Opening the same folder twice opens two windows | The paths normalize differently (separators or case); check the label hash |
| A directory shows as empty until expanded twice | The level request failed; the error is in the toast |
| A file opens as a binary placeholder | The extension is on the binary list, or the content is not UTF-8 |
| "changed on disk, reopen and edit again" | The etag moved — another process wrote the file |
| Saving rewrites the whole file | The file had no CRLF to preserve, or the editor normalised it |
| `.git` is missing from the tree | Refused by design |
| The root `.wh` folder is missing from the tree | Refused by design; the database panel owns it |
| A `.sql` file opens with a data-source picker instead of the text editor | Every `.sql` file is claimed by the database editor |
| A project data source is not listed on the databases page | The two scopes are separate; the panel lists only the project's |
| Edits from outside the app do not appear | There is no watcher; refresh the tree |
| A project window's commands hit another project | The active root was not reset when the window unmounted; check `clearActiveProject` |
