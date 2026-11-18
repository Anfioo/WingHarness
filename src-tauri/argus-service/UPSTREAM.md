# Origin: argus-service

Adapted from [Argus](https://github.com/Ray-lea/Argus).

- Upstream version at import: **0.3.4**
- Upstream commit: **709b26d3** (2026-10-26)
- License: AGPL-3.0-or-later. Argus and this project are both AGPL; the
  project's own [LICENSE](../../LICENSE) is the AGPL-3.0 text, so no separate
  copy is kept. The project as a whole is AGPL-3.0-only.
- Purpose here: the optional LocalSystem service behind the task manager page —
  actions on protected processes, per-process network traffic and per-process
  disk counters.

## Status

Ported and cut down to a fixed six-operation protocol. The PawnIO driver,
sensor service, Task Manager replacement, admin helpers, handle queries and the
upstream binaries were not ported. Every ported source file keeps a short
attribution header.

## What came from where

| This crate | Argus `crates/argus-service/src/` |
| --- | --- |
| `src/server.rs` | `server.rs` |
| `src/pipe.rs` | `pipe.rs` |
| `src/protocol.rs` | `protocol.rs`, cut to the six operations below |
| `src/security.rs` | `security.rs`, minus the admin-only helpers |
| `src/install.rs` | `install.rs`, minus the driver and Task Manager calls |
| `src/network.rs` | `network.rs` (ETW session) |
| `src/disk.rs` | `disk.rs` |
| `src/background.rs` | `background.rs`, keeping only the host-side `NetworkClient` |
| `src/diagnostics.rs` | `diagnostics.rs`, in English and under a WingHarness report directory |
| `src/util.rs` | `util.rs`, in English |
| `src/lib.rs` | `lib.rs`, rebuilt around `run_mode`, `status`, `manage` and `route` |

Not ported: `driver/`, `sensors/`, `taskmgr/`, `admin/`, `handles.rs`, `bin/`.

## Divergences at import

- **Its own identity.** The service is `WingHarnessPrivileged`
  (`WingHarnessPrivilegedDev` in a development build), installed under
  `%ProgramFiles%\WingHarness Privileged[ Dev]`, listening on
  `\\.\pipe\WingHarness.Privileged.v1` (`.Dev.v1`). The ETW session, display
  name, setup helper arguments and diagnostic report directory are renamed the
  same way, so an installed Argus never collides with this service.
- **Six operations.** `Ping`, `NetworkSnapshot`, `DiskSnapshot`, `Terminate`,
  `Priority` and `Efficiency`. The driver, sensor, service-control, connection,
  handle and Task Manager operations of upstream's protocol are gone, and the
  enum plus `deny_unknown_fields` is the whitelist: an unknown operation or
  field is rejected before anything runs.
- **Protocol version 2, pipe name `.v1`.** A `Ping` is always sent in the
  version-1 envelope so the host can discover an older service; the operation
  set therefore cannot also be version 1 or the two would be
  indistinguishable. The pipe name keeps `.v1` so the name stays stable.
- **Routing lives here.** `Operation`, `Reply`, `Routed` and `route()` are
  added for the host: `route` is blocking, returns `Absent` when no service is
  installed and `Outdated` when the running service speaks another version, and
  never falls back to a local action. The host tries locally first and calls
  `route` only after `access-denied`.
- **`Terminate` carries `force`.** Upstream's terminate had no confirmation
  flag; here it is part of the frozen routing signature, defaults to `false`,
  and the host sets it only after the user explicitly confirmed a critical
  process. `validate` still requires a positive PID and creation time and
  refuses the System process, Idle and the service itself.
- **Trimmed install.** The installer no longer touches the PawnIO driver or the
  Task Manager replacement. It copies the payload, records `owner.sid`,
  restricts the directory to Administrators/SYSTEM, creates and starts the
  service, and rolls back on failure. Uninstall stops and deletes the service,
  removes its binary, owner and lock files, and removes the directory only when
  it is empty; it never deletes recursively.
- **Trimmed security.** `account_sid` and `inspect_registry_key` (used only by
  the admin and driver modules) were removed; SID validation, the pipe ACL,
  token checks, directory protection and the owner check remain.
- **Trimmed background.** Only `NetworkClient` is kept. `RuleRunner` and the
  automation loop were not ported. `NetworkClient` and `DiskClient` gained
  `enrich(&mut Snapshot, Duration)` so the host sampler can fold service frames
  into a snapshot, and `DiskClient::new_failure()` reports a one-shot English
  failure reason for the sampler's log.
- **No binaries.** Upstream shipped small launcher binaries in `bin/`. Here the
  host executable re-dispatches on its own arguments: `run_mode()` handles
  `--wingharness-service`, `--wingharness-service-manage`,
  `--wingharness-service-remove` and `--wingharness-service-refresh` before
  Tauri initialises, and the installer can call the refresh mode after
  replacing the host binary so an app upgrade reuses one UAC prompt.
- **English only.** Service diagnostics and error strings are English; the
  page maps error codes to localized text.
- **Tests.** Tests that need administrator rights or a clean VM are kept and
  marked `#[ignore]`.

## Taking an upstream change

1. Diff the relevant upstream module against this crate.
2. Apply the change by hand. Anything that adds an operation must update
   `protocol.rs`, the host's route table in `src-tauri/src/commands/argus.rs`,
   and the service documentation in one change; anything that changes the
   operation set must bump `PROTOCOL`.
3. `cargo check -p argus-service` and `cargo test -p argus-service`; then, on a
   machine where you can approve UAC, install the service from the page and
   check the network column and a system-process action.
