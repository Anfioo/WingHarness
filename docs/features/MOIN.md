# Downloads

The **Downloads** page (`/moin`) is WingHarness's HTTP/HTTPS download manager. It
appears in the sidebar under **其他** (Other) and contains three tabs: Downloads,
Categories and Settings. The engine is embedded in the Tauri process; there is no
separate download daemon to install or manage.

This port deliberately covers direct HTTP/HTTPS downloads only. BitTorrent,
media-site scraping, `moin://` deep links, old moin data migration and in-app
aria2c installation are out of scope.

## Feature overview

| Area            | Behaviour                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Downloads       | Add a URL with an optional filename, category and request headers; inspect status, progress, speed, ETA, engine and errors; use virtual scrolling, search, filters and up to three sort levels. |
| Task actions    | Pause, resume, retry, cancel, archive, delete files, forget records, reveal completed files, copy URLs and move tasks to another category, individually or in batches where supported.          |
| Categories      | Create, edit, delete and drag-sort categories; configure colours, icons, source filters, priorities, final folders and incomplete folders.                                                      |
| Settings        | Configure the queue, connections, split size, timeouts, partial-file visibility, notifications, download engine and browser integration.                                                        |
| Browser capture | Send links from the companion extension over authenticated loopback RPC. See [MOIN_EXTENSION.md](./MOIN_EXTENSION.md).                                                                          |

## Download lifecycle

1. Add an `http://` or `https://` URL. The page can suggest a category from the
   URL and optional filename. Cookie, Referer, User-Agent and other headers are
   optional and are kept for retries and resumes.
2. The engine selects the preferred usable backend, probes the server and uses
   multiple `Range` connections when supported. Otherwise it falls back to one
   stream. New segmented downloads write a `.part.meta` plan next to the
   `.part` file.
3. Data is written to `<destination>.part` until complete. Pause, cancel, retry
   and application shutdown retain the partial files so a later attempt can
   resume. Restarting the app demotes unfinished Connecting, Downloading and
   Moving tasks to Paused; it never resumes them automatically.
4. If the category has an incomplete folder, the partial file lives there and
   the completed file is moved to the final folder. Cross-volume moves use copy
   plus delete and report Moving progress.
5. Completion removes the partial suffix, updates the SQLite record and can show
   a system notification. Closing the main window only hides it to the tray, so
   downloads continue. Quitting from the tray stops the app and leaves `.part`
   files for the next run.

The three record-removal actions are intentionally different:

| Action | Record                                                      | Files                                                      |
| ------ | ----------------------------------------------------------- | ---------------------------------------------------------- |
| Remove | Kept and marked archived; visible under the Archived filter | Kept                                                       |
| Delete | Kept and marked archived                                    | Completed file and known partial/control files are deleted |
| Forget | Deleted from the list and database                          | Kept                                                       |

## Categories and trigger rules

A category can accept manual links, browser captures or both. An empty source
list accepts either source. Every trigger in a category must pass; the matching
category with the lowest numeric `order` wins. An empty trigger list therefore
acts as a catch-all.

| Trigger          | Semantics                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Extension        | Case-insensitive extension matching; a leading dot is optional.                                     |
| Size             | Optional inclusive minimum and maximum in bytes. A task whose total size is unknown does not match. |
| URL pattern      | Case-insensitive glob against the URL.                                                              |
| Filename pattern | Case-insensitive glob against the filename.                                                         |

Globs support `*` and `?`. A pattern without either wildcard is a substring
match. Categories can hide their tasks from the All filter, and can use separate
final and incomplete folders. Deleting a category only clears the category tag
on its tasks; it does not move or delete files. Moving a task to another
category relocates its partial or completed files when the folder changes.

Fresh data directories are seeded with Documents, Videos and Archives. Their
stored English names remain stable while the UI localizes the three known ids.
Unknown BitTorrent-era category fields are preserved verbatim when the JSON is
read and written, but have no UI or runtime effect in this port.

## Built-in and aria2 engines

The default `embedded` engine uses reqwest and supports single-stream and
multi-connection downloads. The optional `aria2` engine uses a local `aria2c`
executable and its loopback JSON-RPC interface. WingHarness probes, in order:

1. the explicit path chosen in Settings;
2. the `WINGHARNESS_ARIA2` environment variable;
3. `PATH`.

It never downloads aria2c. Selecting aria2 expresses a preference, not a hard
requirement: if the executable is missing or unusable, new tasks fall back to
the built-in engine and the Settings page exposes the detection state. The
aria2 process starts on demand and is shut down with the app.

## Settings

| Setting                           | Effect                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Default download folder           | Used by uncategorized tasks; empty means the system Downloads folder.                                 |
| Concurrent downloads              | Maximum running tasks; `0` means unlimited.                                                           |
| Connections / minimum split size  | Controls when and how the built-in engine splits a file; aria2 receives clamped compatible values.    |
| Connection / stall timeout        | Connection establishment limit and no-data limit; a stall timeout of `0` disables stall detection.    |
| Hide partial downloads            | Applies the platform's hidden attribute to `.part` files where supported.                             |
| Add downloads paused              | New tasks wait in Paused instead of starting immediately.                                             |
| Progress update rate              | Batches progress events; the effective interval is clamped to 100–5000 ms.                            |
| Completion notifications          | Enables a system notification when a task completes.                                                  |
| Browser integration switch / port | Applied when the app starts; restart after changing either one. The default port is `47653`.          |
| Access token                      | Read for every RPC request, so regeneration is immediate. Update the extension after regenerating it. |

Other queue, network, engine and notification settings apply to subsequent work
without an application restart.

## Browser integration

The RPC listener binds only to `127.0.0.1`. `GET /ping` is unauthenticated and
returns the app name and version. `POST /add` requires
`Authorization: Bearer <token>` and accepts only HTTP/HTTPS links. An empty or
incorrect token is always rejected. The listener starts once during setup; a
port conflict is logged without crashing the app.

The extension is source-only and is not included in the NSIS installer. It
cannot launch WingHarness through a deep link. Pairing, browser loading,
permissions and privacy are documented in
[MOIN_EXTENSION.md](./MOIN_EXTENSION.md).

## Data layout and sensitive data

All feature state lives below the configured app data directory:

```
<data dir>/moin/
├── downloads.db                 # Task records and request headers
├── settings.json                # Queue, engine and RPC settings, including rpc_token
├── categories.json              # Category definitions and preserved legacy fields
└── aria2/                       # aria2 session.txt and per-task session notes
```

Partial downloads and their `.part.meta` plans live beside the destination or
under a category's incomplete folder, not in this state directory. JSON writes
use a full-name temporary file, flush and rename. A corrupt JSON document is
moved to `<name>.bak-<unix seconds>` before defaults are used.

**Treat the whole data directory as sensitive.** `settings.json` contains the
plaintext RPC token, and `downloads.db` can contain Cookie, Authorization,
Referer and other request headers needed for authenticated downloads. Anyone
who can read these values can call the local `/add` endpoint while browser
integration is running, and may be able to reuse the captured credentials
elsewhere. Do not commit, publicly sync or casually share this directory. The
extension also stores the token in its browser-local extension storage.

## Commands and events

All commands are prefixed `moin_` and registered in `invoke.rs`, `build.rs`,
`capabilities/default.json` and `permissions/autogenerated/`.

| Group      | Commands                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tasks      | `moin_list_downloads`, `moin_add_download`, `moin_pause_download`, `moin_resume_download`, `moin_cancel_download`, `moin_remove_download`, `moin_delete_download`, `moin_remove_downloads`, `moin_delete_downloads`, `moin_retry_download`, `moin_forget_download` |
| Settings   | `moin_get_settings`, `moin_set_settings`, `moin_patch_settings`                                                                                                                                                                                                    |
| Engines    | `moin_list_backends`, `moin_tool_status`, `moin_set_tool_path`                                                                                                                                                                                                     |
| RPC        | `moin_rpc_status`, `moin_regenerate_rpc_token`                                                                                                                                                                                                                     |
| Categories | `moin_list_categories`, `moin_suggest_category`, `moin_create_category`, `moin_update_category`, `moin_delete_category`, `moin_reorder_categories`, `moin_move_to_category`                                                                                        |
| Paths      | `moin_default_download_dir`, `moin_category_folder`                                                                                                                                                                                                                |
| App        | `moin_app_info`                                                                                                                                                                                                                                                    |

Backend events are `moin:task-added`, `moin:task-updated`,
`moin:task-removed`, `moin:task-progress`, `moin:task-completed`,
`moin:settings-changed` and `moin:categories-changed`. Progress payloads are
always batches. Errors use `{ code, message, detail? }`; the UI localizes the
stable code and keeps the English message as a fallback.

## Development checks

Run the feature gates from the repository root:

```bash
cargo check --manifest-path src-tauri/Cargo.toml -p moin-core
cargo test --manifest-path src-tauri/Cargo.toml -p moin-core
pnpm build
pnpm exec eslint src/pages/moin src/components/moin src/hooks/use-moin-tasks.ts src/hooks/use-moin-settings.ts src/hooks/use-moin-categories.ts src/commands/services/moin src/lib/moin
pnpm exec prettier --check src/pages/moin src/components/moin src/lib/moin src/commands/services/moin src/i18n/locales/moin
```

Tests that require a real aria2c binary are marked `#[ignore]`. The loopback RPC
socket test is also ignored by default and can be selected explicitly with its
full test name and `--ignored`.

## Troubleshooting

| Symptom                                                | Likely cause and action                                                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| A URL fails immediately with Failed                    | Check the URL, HTTP status and request headers. A 404 is a permanent task failure until retried with a corrected URL or task.          |
| A task becomes Stalled                                 | No data arrived within the stall timeout, or the connection was interrupted. The `.part` file remains; restore connectivity and retry. |
| A task is Paused after an app restart                  | This is intentional crash recovery. Resume it manually; received bytes and partial files are retained.                                 |
| aria2 is unavailable                                   | Install or select a working `aria2c`, then detect again. Leaving the preference unavailable falls back to the built-in engine.         |
| The RPC status is Not listening                        | Enable browser integration, check for a port conflict and restart after changing the switch or port.                                   |
| The extension returns 401                              | Copy the current token from Settings → Browser integration. Token regeneration invalidates the old token immediately.                  |
| No progress events arrive too frequently or too slowly | Adjust Progress update rate. Values are effectively clamped to 100–5000 ms.                                                            |
| An orphan `.part` remains                              | Files without a task record are never deleted automatically. Inspect the destination and remove only files you no longer need.         |
