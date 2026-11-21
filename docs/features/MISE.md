# Environment Management

The **环境** (Environment) page reads the local `mise` installation, lists the
tools and versions it manages, scans projects for version overrides, and edits
the global and per-project mise configuration. It sits in the sidebar under
**其他** (Other) and is a single page — it opens no window of its own.

The engine is [`src-tauri/mise-core`](../../src-tauri/mise-core) (crate
`mise-core`, library `mise_core`). It is adapted from
[mise_gui](https://github.com/likaia/mise_gui) (MIT);
[mise-core/UPSTREAM.md](../../src-tauri/mise-core/UPSTREAM.md) records what came
across and what did not.

mise itself is **not bundled**. The page uses the CLI already installed on the
machine; without one it shows an install command instead of failing.

## Routes and files

| Route | Renders |
| --- | --- |
| `/mise` | The page: runtime badge, four tabs (Overview, Tools, Projects, Config) |

| Path | Responsibility |
| --- | --- |
| `src/pages/mise/index.tsx` | Page shell: runtime probe, header, tab strip, install guide |
| `src/pages/mise/{overview,tools,projects,config}-tab.tsx` | The four tabs |
| `src/hooks/use-mise-page.ts` | Runtime state, selected tab and the refresh nonce |
| `src/hooks/use-mise-{overview,tools,projects,config}.ts` | One hook per tab; each owns its data |
| `src/components/mise/` | Metric cards, status badges, notices, dialogs, lists and panels |
| `src/commands/services/mise/` | Typed wrappers over the sixteen `mise_*` commands and the DTOs |
| `src/lib/mise/` | Error-key mapping, formatting helpers and the pure action-script builders |
| `src-tauri/mise-core/src/` | Process, runtime probe, history, configuration, tools, actions, projects and dashboard |
| `src-tauri/src/invoke.rs` | Registers the sixteen `mise_*` commands in `all_commands!` |

There is no `standalonePaths` entry and no window record. The sidebar group
`mise` is deliberately absent from `GROUP_ORDER` in
`src/lib/sidebar-config.ts`, so the entry falls into **其他**.

## Runtime probe

`mise_runtime_info` resolves the executable in this order:

1. `MISE_EXECUTABLE`
2. each `PATH` entry (`mise`, then `mise.exe` on Windows)
3. the app's own Scoop shims: `<data dir>/ScoopCurrent/shims/mise.exe`
4. per-user installs: `~/.local/bin`, `~/scoop/shims`,
   `%LOCALAPPDATA%\Programs\mise\bin`

The probe reports `available`, the executable path, the version (`mise
--version`, 15 s), the source (`path`, `scoop`, `direct`, `unknown`) and the
shim status. On Windows the shim check asks whether the executable's directory
is on `PATH`; it is `missing`, `present` or `unsupported` (non-Windows).

A missing executable is a supported state, not an error: the page shows the
platform install command (`winget install jdx.mise`, `brew install mise` or
`curl https://mise.run | sh`) with a copy button and a retry. A version probe
that fails leaves mise installed and usable and only leaves the version blank.

## Tabs

- **Overview** — one `mise_dashboard` payload: four metrics (system, installed
  tools, scanned projects, mise version), environment signals, the three newest
  history entries, and system information. It loads once on mount and does not
  poll; the header's refresh re-probes the runtime and remounts the current tab.
  Every block degrades on its own — a missing mise still produces zero counts
  and a notice instead of a failed command.
- **Tools** — `mise_tools_list` reads `mise ls --json` (30 s). Selecting a tool
  calls `mise_tool_detail`, which re-reads that tool's installed versions and
  then asks the registry: Python uses `mise outdated`, every other backend uses
  `mise ls-remote --json` with a 90-second budget and a cancellation token.
  Cancel calls `mise_tool_detail_cancel`, so the backend stops instead of the
  frontend merely dropping the response. A failed remote lookup degrades to the
  `outdated` entry or the local versions plus a `remote-unavailable` notice.
- **Projects** — `mise_projects_scan` scans the open project windows and the
  enabled custom roots. See *Project coverage* below.
- **Config** — `mise_config_workspace` returns the global document, the selected
  project document and the structured sections the page edits. See
  *Configuration editing* below.

## Project coverage

The scan scope is exactly two sources, never a "recent projects" list:

- every window whose label starts with `project-`, read from its URL by Rust;
- every **enabled** custom scan root in `<data dir>/mise/scan_dirs.json`.

One root is walked breadth-first to depth 3, visiting at most 240 directories
and collecting at most 80 projects. Dot directories and the usual build output
(`.git`, `.dart_tool`, `.idea`, `.vscode`, `build`, `dist`, `node_modules`) are
skipped.

A project's configuration files are read in priority order: `mise.toml`,
`.mise.local.toml`, `mise.local.toml`, `.tool-versions`, then the single-version
files (`.node-version`, `.nvmrc`, `.python-version`, `.ruby-version`,
`.java-version`, `.go-version`, `.terraform-version`). Tool names are normalized
(`nodejs` → `node`, `golang` → `go`) and a leading `v` is stripped.

Each declared tool becomes a binding that compares the project's version with
the global configuration. Its source is `project`, `project-file`, `global`,
`inherited` or `resolved` (mise resolved it itself). A project's note is
`overrides`, `project-only`, `consistent` or `none`, and `scan_issue` carries
`not-trusted` or `unavailable` when mise could not be asked about it. A
per-project `mise ls` call has a 30-second budget; on failure the row falls back
to the versions the files declare.

Scan roots are normalized, deduplicated and folded under an enabled ancestor. A
disabled ancestor keeps an enabled child. At most 50 roots may be added; adding
one below an enabled root folds it, adding one anywhere else is stored as is.

## Actions and safety

Every tool action is assembled in `src/lib/mise/commands.ts` before its preview
dialog opens, so the command shown is the command that runs. The page offers
install, switch (`mise use`), upgrade (install + use) and uninstall (one
version, or the tool from the global configuration plus every installed
version).

The backend then applies these guardrails:

- A script is validated line by line before the first process starts. Blank
  lines and `#` comments are skipped, every other line must start with `mise `,
  and no shell operator may appear in its arguments.
- Each line runs as an argv array with no shell, so quoting cannot turn into
  command injection. A command has a six-minute budget; the first non-zero exit
  stops the rest of the script.
- Only one action may run at a time. A second attempt returns `busy` instead of
  starting another process.
- Output streams through the `mise:action-progress` event. The progress dialog
  keeps at most 200 log lines.
- When an action fails, the lockfiles mise left behind are swept. Only paths
  found under a lockfile directory are removed; anything else is reported but
  left alone.
- Every run is recorded in the history store; cancelling a preview records a
  `canceled` entry.

Uninstalling one version deletes only the local install, never a configuration
line. Removing a whole tool is the explicit two-line action that also removes it
from the global configuration.

## Configuration editing

The workspace exposes the global configuration
(`MISE_GLOBAL_CONFIG_FILE`, otherwise `<home>/.config/mise/config.toml`) and, when
a project is selected, that project's TOML file. Four edit kinds are supported:

| Kind | Writes |
| --- | --- |
| `document` | The whole file, as typed |
| `settings` | Keys under `[settings]`: `http_timeout`, `fetch_remote_versions_timeout`, `http_retries`, `offline`, `terminal_progress` |
| `proxy` | Keys under `[env]`: `http_proxy`, `https_proxy`, `all_proxy`, `no_proxy`, each written in lower and upper case |
| `aliases` | The `[tool_alias.java.versions]` map |

Nothing reaches disk directly. `mise_config_preview_edit` builds the next
content and a unified diff; the user reviews it and `mise_config_save` writes
**only the previewed content**. A stale or hand-written `nextContent` is still
checked against the whitelist.

**Whitelist.** A save target is accepted only when it is the global
configuration file, or one of eleven known configuration file names below an
opened project root or an enabled scan root, at most three levels down. Anything
else — including a path outside those roots — is refused with `invalid-input`
and the file is untouched. A document over 1 MiB or not valid UTF-8 is refused
the same way.

**Writing.** The existing file is first copied to `<name>.bak-<unix seconds>`,
then the new bytes are written to `<name>.tmp`, flushed, and renamed over the
target. A failed write removes the temporary file; a successful one leaves no
`.tmp` behind. Other sections and comments are preserved because the builders
edit only the lines they own.

## History

Action history is `<data dir>/mise/history.json`, `{ "version": 1, "entries":
[…] }`, newest first.

- At most 100 entries; appending past the cap drops the oldest.
- Each stream (`stdout`, `stderr`) is capped at 16 KiB, cut on a character
  boundary, and the list view shows the first three lines of the trimmed output
  as a snippet.
- Writes are atomic and serialized, so two appends cannot drop each other's
  entry.
- An unreadable document is moved aside as `history.json.bak-<unix seconds>` and
  the list starts empty instead of failing.

The overview shows the three newest entries; the Tools tab has "view all" with
the full output. History survives a restart because it is a file, not webview
state.

## Data files

| Path | Contents |
| --- | --- |
| `<data dir>/mise/history.json` | The action history described above |
| `<data dir>/mise/scan_dirs.json` | `{ version: 1, directories: [{ path, enabled }] }`, normalized, at most 50 |
| `<home>/.config/mise/config.toml` | mise's own global configuration, read and written through the whitelist |
| `%LOCALAPPDATA%\mise\installs` | mise's install directory, shown as affected by install/uninstall actions |

mise's own files are not moved or duplicated. The page only edits the global
configuration (and a project's configuration when one is selected).

## Error codes

Every rejected command returns `{ code, message, detail }`; `message` is English
for logs and the frontend localizes by `code`.

| Code | Meaning |
| --- | --- |
| `mise-not-found` | No mise executable could be resolved or started |
| `not-found` | The requested tool, project or file does not exist |
| `invalid-input` | A path, document or setting failed validation (including the whitelist) |
| `unsafe-command` | A script line is not a `mise` invocation or contains a shell operator |
| `busy` | Another action is already running |
| `timeout` | A mise call exceeded its budget |
| `io` | A file could not be read, backed up or written |
| `cancelled` | The request was cancelled by the user |
| `not-implemented` | A placeholder command was called |
| `internal` | mise failed or its output could not be interpreted (`detail` carries the exit code and stderr) |

## Commands

| Command | Purpose |
| --- | --- |
| `mise_runtime_info` | Probe the executable, version and shims |
| `mise_dashboard` | The overview payload |
| `mise_tools_list` | Installed tools from `mise ls --json` |
| `mise_tool_detail` / `mise_tool_detail_cancel` | One tool's versions and remote candidates; cancel that request |
| `mise_action_run` | Validate and run an action script, streaming progress |
| `mise_projects_scan` | Scan the open projects and custom roots |
| `mise_scan_dirs_list` / `_add` / `_remove` / `_set_enabled` | Manage the custom scan roots |
| `mise_config_workspace` | The global and project documents and editable sections |
| `mise_config_preview_edit` | Build the next content and diff without writing |
| `mise_config_save` | Write exactly the previewed content, with a backup |
| `mise_history_list` / `mise_history_record_canceled` | Read the history; record a cancelled action |

All sixteen are registered in `src-tauri/src/invoke.rs`, `build.rs`,
`capabilities/default.json` and `permissions/autogenerated/mise_*.toml`.

## Permissions

The ACL grants the `mise_*` commands only to the app's own windows listed in
`capabilities/default.json`. Plugin webviews use `plugin-view-*` labels, which
are deliberately absent from that list, so a plugin cannot call any `mise_*`
command — the denial is the ACL default, not a frontend check.

## Development

```bash
cd src-tauri
cargo check -p mise-core
cargo test -p mise-core
cargo check
cd ..
pnpm build
pnpm exec eslint src/pages/mise src/components/mise src/hooks/use-mise-*.ts \
  src/commands/services/mise src/lib/mise
pnpm exec prettier --check src/pages/mise src/components/mise \
  src/hooks/use-mise-*.ts src/commands/services/mise src/lib/mise \
  src/i18n/locales/mise
```

The tests that need a real machine are `#[ignore]`d. Run them with `--ignored`
and, where noted, an environment variable:

| Test | Needs |
| --- | --- |
| `runtime::tests::real_runtime_probe_reports_the_executable` | a local mise |
| `process::tests::real_mise_*` | a local mise |
| `tools::tests::real_mise_lists_installed_tools` | a local mise |
| `tools::tests::real_mise_loads_remote_versions_for_a_tool` | a local mise and network access |
| `projects::tests::discovers_a_real_directory` | `MISE_PROJECT_SCAN_ROOT` set to a directory with a mise project |

Set `MISE_EXECUTABLE` when mise is installed outside `PATH`.
