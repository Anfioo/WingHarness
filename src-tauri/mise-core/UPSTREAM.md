# Origin: mise-core

Adapted from [mise_gui](https://github.com/likaia/mise_gui).

- Upstream version at import: **1.0.8**
- Upstream commit: **db111d7** (2026-11-22)
- License: MIT — Copyright (c) 2026 likai. The full text is in
  `licenses/mise_gui-LICENSE.txt`.
- Imported portions: the mise process and executable probe, the CLI queries,
  the tool/version model and comparisons, the action runner and its lockfile
  cleanup, configuration parsing and diffing, the project scan and scan-root
  store, the action history, and the overview / tools / projects / config UI
  behaviour.

## Status

Rewritten rather than copied — no file is byte-identical to an upstream file.
The upstream implementation is Dart (Flutter services and pages); this crate and
its React page are first-party code maintained here. Every source file keeps a
short attribution header.

## What came from where

| This crate | mise_gui |
| --- | --- |
| `src/process.rs` | `lib/services/mise_process_service.dart` (executable probe, argv execution, timeout/cancel, output decoding) |
| `src/runtime.rs` | The runtime and shim parts of `mise_process_service.dart` |
| `src/tools.rs` | `lib/services/mise_query_service.dart` and the tool orchestration in `lib/services/mise_cli_service.dart` (list, detail, remote candidates, version comparison) |
| `src/actions.rs` | `lib/services/mise_action_service.dart` (script validation, streaming progress, lockfile cleanup) |
| `src/config.rs` | `lib/services/config_service.dart` (section parsing, next content, unified diff) |
| `src/projects.rs` | `lib/services/project_scan_service.dart` and `lib/services/scan_directory_service.dart` |
| `src/history.rs` | `lib/services/history_service.dart` |
| `src/dashboard.rs` | The dashboard repository and the signals / system information it assembled |
| `src/models.rs`, `src/error.rs` | `lib/models/app_models.dart`, re-expressed as DTOs and stable error codes |
| `src/pages/mise/*`, `src/components/mise/*`, `src/hooks/use-mise-*.ts` | `lib/features/{dashboard,tools,projects,config}/presentation/*.dart` and the shared dialogs/panels; behaviour only, rebuilt on this app's components |
| `src/lib/mise/*`, `src/commands/services/mise/*` | No direct counterpart; added for this app |

## Divergences at import

- **Flutter UI rewritten as React.** The page uses this app's `AppShell`,
  routing, hooks, Tailwind and shadcn/ui. No Flutter widget, Riverpod provider
  or upstream theme is carried over; only the information hierarchy and
  interaction model were read from the upstream pages.
- **Service layer rewritten as Rust.** There is no Dart code left. The queries,
  scanning and configuration work run in `mise-core` behind sixteen Tauri
  commands, so the webview never assembles a shell command or writes a file
  itself.
- **No GUI self-update or app update.** mise_gui shipped its own updater, a
  browser launcher and desktop window service. The app already owns its updater
  and windows; all three were dropped, together with mise's self-update.
- **No window chrome, tray or mock services.** mise_gui carried its own shell,
  theme, destination and dependency wiring plus mock services for the Dart
  tests. This app supplies the shell; the mocks and Dart tests were not ported.
- **No configuration watching.** mise_gui watched configuration files and
  refreshed in place. Here a tab re-reads its data when it is entered or the
  page is refreshed; there is no file watcher and no polling.
- **No login-shell probing.** The upstream process service discovered an
  interactive shell on macOS and Linux to inherit its environment. This crate
  starts mise directly with argv and the app's environment.
- **No data migration.** The scan roots and history under mise_gui's
  `%APPDATA%` are not read. The page starts with an empty store.
- **Argv, not a shell.** Upstream built command strings for its action runner.
  Here every line is parsed to an argv array, and shell operators are rejected
  before a process starts.
- **Stable error codes.** Upstream returned Dart exceptions and localized
  strings. This crate returns `{ code, message, detail }` with a kebab-case code;
  the frontend localizes by code and never matches English text.
- **A stricter write path.** The upstream configuration service wrote the
  generated content directly. This crate splits preview and save, restricts
  saves to a whitelist (the global config, or eleven known file names below an
  opened project/scan root at most three levels down), caps documents at 1 MiB,
  backs up the old file and writes atomically.
- **One action at a time.** The upstream page could start overlapping actions.
  This crate has an app-wide gate and returns `busy` for a second attempt.
- **History is a file, not webview state.** `<data dir>/mise/history.json`, at
  most 100 entries, each stream capped at 16 KiB, corrupt documents moved aside.
- **Python remote versions.** The upstream behaviour is kept: `mise outdated`
  is preferred for Python, `ls-remote` is the general path, and a failed remote
  lookup degrades to the outdated entry plus a notice.

## Taking an upstream change

1. Diff the relevant Dart service or page against this crate and its React page.
2. Apply the behaviour by hand on top of the local edits; keep every mise
   invocation behind `process::run_command` and every write behind the preview /
   whitelist / backup path.
3. `cargo test -p mise-core`; the real-mise tests are `#[ignore]`d and run with
   `--ignored` on a machine with mise installed. Open the environment page and
   walk the four tabs.
