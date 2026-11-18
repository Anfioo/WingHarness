# Task Manager

The **任务管理器** (Task Manager) page shows what this machine is doing: the
process table with three views, a detail panel and process actions, and a
performance tab with CPU, memory, disk, network and GPU curves. An optional
Windows service adds actions on protected system processes and per-process
network and disk traffic; without it the page still monitors everything that
needs only the account's own rights.

It sits in the sidebar under **其他** (Other) and is a single page — it opens no
window of its own. Sampling runs only while the page is mounted.

The engines are [`src-tauri/argus-core`](../../src-tauri/argus-core) (crate
`argus-core`, library `argus_core`) and
[`src-tauri/argus-service`](../../src-tauri/argus-service) (crate
`argus-service`, library `argus_service`). Both are adapted from
[Argus](https://github.com/Ray-lea/Argus) 0.3.4 (AGPL-3.0-or-later);
[argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) and
[argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md) record
what came across and what did not.

## Routes and files

| Route | Renders |
| --- | --- |
| `/task-manager` | The page: header, service summary, tab strip, the process and performance tabs, the settings dialog |

| Path | Responsibility |
| --- | --- |
| `src/pages/task-manager/index.tsx` | Page shell inside `AppShell` |
| `src/pages/task-manager/task-manager-app.tsx` | Header (title, service badge, refresh, settings), tab strip, both tab panels |
| `src/pages/task-manager/tabs/processes.tsx` | Process tab: toolbar, table, detail sheet, confirmation dialogs |
| `src/pages/task-manager/tabs/performance.tsx` | Performance tab: summary cards, five panels, the 60-second window |
| `src/components/task-manager/` | Table, toolbar, row, detail, context menu, the five performance panels, summary, service panel and badge, settings dialog, `format.ts` |
| `src/hooks/use-task-manager.ts` | One shared store: channel, settings, service status, actions |
| `src/commands/services/task-manager/` | Typed wrappers over the thirteen `argus_*` commands and their DTOs |
| `src/lib/task-manager/` | Pure logic: `process-search`, `process-sections`, `process-identity`, `chart-history`, `chart-scale`, `chart-metrics`, `chart-memory`, `chart-colors` |
| `src-tauri/src/commands/argus.rs` | The thin command surface |
| `src-tauri/src/argus/` | `sampler.rs` (sampling thread), `service.rs` (status and install), `store.rs` (settings), `mod.rs` (`ArgusState`) |

There is no `standalonePaths` entry and no window record: everything is one
route in the main window. The sidebar group `taskManager` is deliberately
absent from `GROUP_ORDER` in `src/lib/sidebar-config.ts`, so the entry falls
into **其他**.

## Sampling lifecycle

```
page mounts
  → useTaskManager() store starts (first subscriber only)
  → argus_settings_get
  → argus_snapshot_start { channel, intervalMs }
      → sampler thread: Collector + ETW session + service clients
      → one frame per tick over ipc::Channel<Snapshot>
page unmounts (last subscriber), or the app exits
  → argus_snapshot_stop
  → thread stops, ETW session released
```

- **One subscription per page.** The page shell and both tabs call
  `useTaskManager()`, but a module-level store owns the single
  `Channel<Snapshot>`: the first caller starts sampling and the last one to
  unmount stops it. Pausing only drops incoming frames; the backend keeps
  sampling, so resuming is immediate.
- **No global event.** Frames travel over a Tauri channel to this page only, so
  nothing is broadcast to other windows.
- **Fresh baseline.** Each start builds a new collector, so the first one or two
  ticks have no CPU or rate figures (there is no previous sample to diff
  against). Leaving the page clears the performance history by unmounting it.
- **Interval** is 250–5000 ms, default 1000 ms. It is clamped on read and on
  write, and changing it in the settings dialog restarts the tick immediately.
- **A dead thread is replaced.** If a page vanished without stopping (a window
  reload, say), the handle left in `ArgusState` can no longer deliver; the next
  `argus_snapshot_start` detects the failed send and spawns a fresh thread.

## Processes tab

### Views

| View | Rows |
| --- | --- |
| **Apps** | One collapsible group per application (processes that own an app window, plus their children), collapsed by default; the rest follow as individual processes |
| **Process tree** | The parent/child tree, indented and expanded by default; a node collapses its subtree |
| **List** | Every process flat |

`buildProcessRows` in `src/lib/task-manager/process-sections.ts` builds all
three from one snapshot. The tree walks the parent chain with an explicit stack
(there is no recursion), stops indenting at `MAX_TREE_DEPTH = 32`, and shows a
node whose parent chain forms a cycle instead of dropping it.

### Search, sort and virtualization

Search matches the process name, the PID and the image path, case-insensitively
and trimmed; a blank query returns `null` from `createProcessMatcher`, so no
filter runs. In the apps view a query expands matching groups and hides groups
with no match. An empty result has its own state with a **clear search** action.

Clicking a column header sorts by name, PID, CPU, memory, disk, network or GPU;
the first click on a numeric column sorts descending (busiest first) and the
default is CPU descending. Groups are sorted by their aggregate value; processes
whose disk rate is still `null` sort after measured ones.

The table is virtualized with `@tanstack/react-virtual` at a fixed 32 px row;
only rows near the viewport exist in the DOM, so a 300-process machine scrolls
without jumps. Column headers stay sticky.

### Columns

Name (with the app icon and indentation), PID, CPU, memory, disk, network, GPU,
user and status. Disk shows read + write with both rates in the tooltip; network
shows `—` until the service measures it; user shows `—` because no producer is
wired yet; status shows running or suspended.

### Detail panel

Selecting a row opens the detail sheet and calls `argus_process_details` lazily.
The fast fields (path, resources, threads, handles) come from the snapshot; the
slow ones (command line, user, integrity level, architecture, priority, version
resource) come from that call. A process that cannot be opened comes back with
`accessible: false` and the sheet shows why instead of empty fields. A response
that arrives after the sheet moved to another process is discarded. PID and path
can be copied from the sheet.

### Actions

| Action | Behaviour |
| --- | --- |
| **End task** | Confirmation dialog, then `argus_kill_process` |
| **End process tree** | Confirmation names the child count, then `argus_kill_process_tree` |
| **Priority** | Submenu (idle … realtime); realtime asks for a second confirmation, then `argus_set_priority` |
| **Efficiency mode** | On/off toggle, then `argus_set_efficiency` |

The page never ends its own process: the host rejects that PID, and the menu
disables the action on the executable the page runs from. Ending a system
process needs the privileged service — the host tries locally first and hands
the operation to the service only on `access-denied`.

## Performance tab

Five summary cards (CPU, memory, disk, network, GPU) show the current reading
and the 60-second peak with a share bar. Below them, five canvas panels draw:

- **CPU** — total utilization, per-logical-processor utilization, and the CPU
  identity.
- **Memory** — used and committed totals plus the composition (in use,
  modified, standby, free).
- **Disk** — per-volume activity, read and write rates.
- **Network** — received and sent rates per adapter.
- **GPU** — utilization, dedicated and shared memory, and the busiest engines.

The history is 60 one-second buckets (`chart-history.ts`). A snapshot that
lands in an existing bucket overwrites it; a bucket that received no sample
stays `null` and the line breaks instead of stretching. At intervals slower
than one second the chart therefore shows gaps rather than a ramp. Pausing
freezes the window: no new buckets are pushed, so the right edge stops moving.
When the page is left the tab unmounts and the history is dropped.

## The privileged service

The service is optional. It is a LocalSystem Windows service named
`WingHarnessPrivileged` (`WingHarnessPrivilegedDev` in a development build),
listening on `\\.\pipe\WingHarness.Privileged.v1`
(`.Dev.v1` for development). The host and the service speak a versioned JSON
protocol whose operation set is fixed by an enum: `Ping`, `NetworkSnapshot`,
`DiskSnapshot`, `Terminate`, `Priority` and `Efficiency`. Unknown operations or
fields are rejected, and a `Terminate` must carry a positive PID and creation
time — the System process, Idle and the service itself are never valid targets.

What the service provides:

- Process termination, priority changes and efficiency mode for processes the
  current account cannot open.
- Per-process network traffic from an ETW session.
- Per-process disk counters (read/write bytes per second).

What it deliberately does **not** provide: a kernel driver (PawnIO), sensors or
fan control, a Task Manager replacement, privilege-elevation helpers for other
programs, handle or file-lock queries, connection management, or service
control. It creates no window and starts no webview.

### Install, update and uninstall

| Action | What happens |
| --- | --- |
| **Install** | Confirmation, then one UAC prompt (`ShellExecuteExW` with `runas`). The helper copies the payload to `%ProgramFiles%\WingHarness Privileged[ Dev]`, records the installing account's SID in `owner.sid`, creates and starts the service, and restricts the directory to Administrators/SYSTEM |
| **Update** | The same UAC path replaces the binary and restarts the service; offered after an app upgrade when the installed service speaks another protocol |
| **Uninstall** | One UAC prompt, then the service is stopped, deleted, and its binary, `owner.sid` and lock file are removed; the directory is removed only if it is empty |

- Cancelling the UAC prompt changes nothing; the page re-reads the status and
  shows a neutral notice instead of an error.
- The service starts with Windows and stays resident, including after the app
  is closed. Uninstalling the app does not remove it — uninstall it from this
  page.
- Only the account recorded in `owner.sid` is authorized. Another account sees
  the installed service as not authorized and cannot use it.
- The host always acts locally first. Only on `access-denied`, and only when the
  host itself is not elevated, is the same operation handed to the service. The
  service's reply is authoritative and is never retried locally, so a lost reply
  cannot end the same process twice.
- The service is never installed or elevated implicitly at startup.

## Commands

| Command | Arguments | Returns |
| --- | --- | --- |
| `argus_snapshot_start` | `{ channel, intervalMs }` | — |
| `argus_snapshot_stop` | — | — |
| `argus_set_interval` | `{ intervalMs }` | `ArgusSettings` |
| `argus_refresh` | — | — |
| `argus_settings_get` | — | `ArgusSettings` |
| `argus_settings_set` | `{ settings }` | The normalized settings that were written |
| `argus_process_details` | `{ pid }` | `ProcessDetails` |
| `argus_kill_process` | `{ pid, createTime, force }` | — |
| `argus_kill_process_tree` | `{ pid, createTime }` | `TreeKillReport` |
| `argus_set_priority` | `{ pid, createTime, priority }` | The priority the process ended up with |
| `argus_set_efficiency` | `{ pid, createTime, on }` | — |
| `argus_service_status` | — | `ServiceStatus` |
| `argus_service_manage` | `{ action }` (`install` / `uninstall` / `update`) | `ServiceStatus` |

A command is only callable once it is named in all four lists: `all_commands!`
in `src/invoke.rs`, `COMMANDS` in `build.rs`, `capabilities/default.json`, and
`permissions/autogenerated/*.toml`.

Every action carries the process creation time together with the PID, so a
reused PID cannot make the page act on a different process. Errors are
`{ code, message, detail? }`; `message` is English for logs, and the frontend
translates by `code` through `argusErrorKey`:

| Code | Meaning |
| --- | --- |
| `not-found` | The process has already exited, or its PID was reused |
| `invalid-input` | The interval is out of range, the service action is unknown, or the target is this app |
| `access-denied` | Administrator rights or the privileged service are required |
| `service-unavailable` | The service is not installed or not running, or speaks another protocol |
| `internal` | Another Windows error; `detail` carries it |

## Data layout

```
<data dir>/argus/
└── settings.json
```

```json
{
  "version": 1,
  "intervalMs": 1000
}
```

`version` is written for future migrations and ignored on read. The directory is
`argus_core::paths::CONFIG_DIR`, set once in `src-tauri/src/lib.rs` to
`config::dir().join("argus")`.

- **Missing file** — the defaults, and nothing is written.
- **Write** — staged as `settings.json.tmp`, flushed with `sync_all`, then
  renamed over the target under a process-wide `Mutex`.
- **Unparseable file** — renamed to `settings.json.bak-<unix seconds>` and
  replaced by the defaults in memory, so a hand-edited file never wedges the
  page.
- **Validation** — `intervalMs` is clamped to 250–5000 on read and on write;
  unknown fields and a future `version` are ignored.

Nothing else is persisted: there is no history store and no rules store in this
port.

## Limits and platform notes

- **Windows only.** Both crates are `cfg(windows)`; there is no macOS or Linux
  path.
- **Windows 10 vs Windows 11.** Efficiency mode is set through the EcoQoS
  `SetProcessInformation` API, which Windows 10 22H2 accepts. Task Manager on
  Windows 10 does not display it, so the toggle cannot be confirmed there the
  way the acceptance checklist expects; verify it on Windows 11.
- **CPU frequency is unavailable.** `cpuMhz` is `null` and `coreMhz` is empty
  because the only upstream source was a sensor module that was not ported. The
  speed row and the per-core frequency line are hidden.
- **The user column is empty.** `ProcessRow` has no `user` field; reading the
  token owner for every process on every tick was not worth the cost, so the
  column shows `—` until a producer exists.
- **Disk and network need warm-up.** Rates need two samples; the first ticks
  show `—`, and a process that just started has no disk or network row yet.
- **Per-process network needs the service.** Without it the column shows `—`
  and the page explains why in the toolbar hint.
- **GPU and disk hardware can be absent.** Machines without a supported GPU or
  with no disk counters get the panel's empty state, not an error.
- **Protected processes.** The detail sheet explains that it cannot read the
  command line, user or version instead of showing empty values.
- **A service left behind.** Upgrading or uninstalling the app does not touch an
  installed service. Use **Update service** after an upgrade; **Uninstall**
  removes it.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "not allowed by ACL" | The command is missing from `build.rs` or `capabilities/default.json` |
| The table stays empty | `argus_snapshot_start` failed — read the English `message` in the dev console |
| No frames after returning to the page | The previous sampler thread exited; the next start replaces it, so reload the page and report it if it repeats |
| Network column shows `—` | The privileged service is not installed or not running |
| Ending a system process says access denied | Install the service; the message says so |
| The service badge says incompatible | The installed service speaks another protocol; use **Update service** |
| Settings reset to the defaults | `settings.json` could not be parsed; look for `settings.json.bak-*` in the data directory |
| Charts show gaps | The sampling interval is longer than one second, so not every bucket has a sample |
| Efficiency mode has no visible effect | Check it in Windows 11's Task Manager; Windows 10 does not show the badge |

## Licence

`src-tauri/argus-core` and `src-tauri/argus-service` are adapted from Argus
(https://github.com/Ray-lea/Argus), version 0.3.4, AGPL-3.0-or-later. The
project as a whole is AGPL-3.0-only; the ported portions keep their AGPL
notice, and every ported file carries an attribution header. The porting
records are [argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) and
[argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md); the
notice is in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
