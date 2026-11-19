# Origin: argus-core

Adapted from [Argus](https://github.com/Ray-lea/Argus).

- Upstream version at import: **0.3.4**
- Upstream commit: **709b26d3** (2026-10-26)
- License: AGPL-3.0-or-later. Argus and this project are both AGPL; the
  project's own [LICENSE](../../LICENSE) is the AGPL-3.0 text, so no separate
  copy is kept. The project as a whole is AGPL-3.0-only.
- Purpose here: the sampling and process-control engine behind the task manager
  page (`/task-manager`).

## Status

Ported, then trimmed. Sampling, process actions, details and hardware telemetry
are carried over with local edits; the history store, rules, service catalogue,
startup items, connections, file-lock and handle queries, theme and every
sensor module were not ported. Every ported source file keeps a short
attribution header. Files written for this project are marked as such below.

## What came from where

| This crate | Argus `crates/argus-core/src/` |
| --- | --- |
| `src/process.rs` | `process.rs` (the `WebViewInfo` / `WebViewRole` / `GpuEngineUsage` view types moved in from `webview.rs` and `gpu_process.rs`) |
| `src/system.rs` | `system.rs` |
| `src/cpu.rs` | `cpu.rs` |
| `src/collector.rs` | `collector.rs` (history and rules hooks removed) |
| `src/app_windows.rs`, `src/webview.rs`, `src/meta.rs` | the same files |
| `src/details.rs`, `src/actions.rs`, `src/privilege.rs` | the same files |
| `src/image_paths.rs` | `paths.rs`, renamed to leave `paths.rs` for the data directory |
| `src/nt.rs`, `src/util.rs`, `src/pdh.rs` | the same files |
| `src/gpu_process.rs`, `src/net_process.rs`, `src/disk_process.rs` | the same files |
| `src/diagnostics.rs` | `diagnostics.rs`, with the i18n layer removed |
| `src/hardware/*` | `hardware/*`, minus `sensors` and `kernel_sensors` (battery is included) |
| `src/lib.rs` | `lib.rs` |
| `src/error.rs`, `src/models.rs`, `src/paths.rs`, `src/store.rs` | No direct counterpart; written for this app |

The host glue is not in this crate: `src-tauri/src/commands/argus.rs` and
`src-tauri/src/argus/` are a rewrite of upstream's
`src-tauri/src/{sampler,commands,settings}.rs` for the thirteen-command surface
this app needs.

## Divergences at import

- **Windows only.** The crate is `#![cfg(windows)]`; upstream also was, but
  every public type here is reachable only on Windows.
- **No history.** `history.rs`, the binary history store, its retention policy
  and the history page hooks are gone. The performance tab keeps a 60-second
  window in React state instead; nothing is written to disk.
- **No rules.** `rules.rs` and the automation hooks in the collector are gone;
  only manual priority and efficiency changes remain.
- **No service catalogue, startup items, connections, file locks or handles.**
  `services.rs`, `startup*`, `connections.rs`, `filelock.rs` and `handles.rs`
  were not ported, and the NT structures only they used were removed from
  `nt.rs`.
- **No sensors.** `hardware/{sensors,kernel_sensors}.rs` were dropped, and with
  them `Hardware.cpuIdle` / `CpuIdle`. `Hardware.cpuMhz` stays `None` and
  `coreMhz` stays empty because their only producer was `sensors.rs`; the page
  renders both as unavailable. A real frequency source would need a new PDH
  collector. `hardware/battery.rs` stays: the performance page's device list
  shows one entry per battery.
- **No i18n.** `i18n.rs` and the `tr!` macro are gone. Rust returns English
  strings only; the frontend translates by error code.
- **Typed errors.** `error.rs` (`ArgusError` / `ArgusErrorCode`, serialized as
  `{ code, message, detail? }`) is first-party. Upstream's action errors and
  localized text are mapped onto it at the command boundary.
- **Settings store.** `<data dir>/argus/settings.json` (`store.rs`) is
  first-party: atomic staged write, corrupt-file backup and interval clamping.
  Upstream kept its settings in the host crate.
- **`Collector::new(meta)` takes the shared `Arc<MetaStore>`.** Upstream did the
  same; the host creates the store so `argus_icon` can serve the cached PNGs to
  the page after the sampler has gone. `Collector` has no history or rules
  parameters.
- **No `list_lineage`.** The copy in `process.rs` was unused (the tree walk in
  `actions.rs` is the one callers use) and was deleted.
- **`ProcessRow` deliberately has no `user` field.** Reading each process's
  token owner on every tick was judged too expensive; the page shows `—`.
- **Trimmed helpers.** `registry::reg_dword`, the NT handle structures,
  `handle_entries`, `pdh::value` and `pdh::array` were removed with their last
  callers.
- **Tests.** Upstream tests that need a real process or live counters are kept
  and marked `#[ignore]`; run them with `cargo test -p argus-core -- --ignored`
  on a real Windows machine.

## Taking an upstream change

1. Diff the relevant upstream module against this crate, not the whole tree.
2. Apply the change by hand on top of the local edits. Keep it Windows-only,
   keep it free of history, rules, sensors and localized strings, and route
   anything user-visible through the existing `ArgusError` codes.
3. `cargo check -p argus-core` and `cargo test -p argus-core`; then open the
   page with `pnpm tauri dev` and check the process and performance tabs.
4. If a new public field is added to `Snapshot` or `ProcessRow`, update
   `src/commands/services/task-manager/types.ts` in the same change.
