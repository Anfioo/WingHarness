# Task Manager

The **任务管理器** (Task Manager) page shows what this machine is doing: the
process table with three views, a detail panel and process actions, a
performance tab with CPU, memory, disk, network, GPU and battery detail views,
and a services tab for the Windows Service Control Manager. An optional
Windows service adds actions on protected system processes, service control and
per-process network and disk traffic; without it the page still monitors
everything that needs only the account's own rights.

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
| `/task-manager` | The page: header, service summary, tab strip, the process, performance and services tabs, the settings dialog |

| Path | Responsibility |
| --- | --- |
| `src/pages/task-manager/index.tsx` | Page shell inside `AppShell` |
| `src/pages/task-manager/task-manager-app.tsx` | Header (title, service badge, refresh, settings), tab strip, all three tab panels |
| `src/pages/task-manager/tabs/processes.tsx` | Process tab: the vitals band, toolbar, table, inline detail panel, confirmation dialogs |
| `src/pages/task-manager/tabs/performance.tsx` | Performance tab: the device list, one detail view per device, the 60-sample window |
| `src/pages/task-manager/tabs/services.tsx` | Services tab: polling lifecycle, search / filter / sort state, toolbar actions, toasts |
| `src/components/task-manager/` | Table, toolbar, row, detail body and actions, right-hand detail panel, vitals band, hardware overview, splitter, context menu, service table and menu, the performance device list and per-device views, service panel and badge, settings dialog, `format.ts` |
| `src/hooks/use-task-manager.ts` | One shared store: channel, settings, service status, actions |
| `src/commands/services/task-manager/` | Typed wrappers over the eighteen `argus_*` commands and their DTOs |
| `src/lib/task-manager/` | Pure logic: `process-search`, `process-sections`, `process-identity`, `process-history`, `performance-target`, `service-rows`, `chart-history`, `chart-scale`, `chart-metrics`, `chart-memory`, `chart-colors` |
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

- **One subscription per page.** The page shell and every tab call
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

### Vitals band

Above the toolbar sits a 128 px band of four cards — CPU, memory, disk and
network — and a fifth for the busiest GPU when the machine has one. Each card
shows its title, a secondary reading, the current figure in the unit that suits
it, and the last 60 samples as a sparkline:

| Card | Main figure | Secondary | Chart |
| --- | --- | --- | --- |
| CPU | current utilization, % | current clock, GHz | total CPU utilization |
| Memory | used GB of installed GB | utilization, % | used bytes against installed |
| Disk | read + write rate of every disk | the busiest disk's active time, % | summed read + write rate |
| Network | receive + send rate of every adapter | `↓ received · ↑ sent` | summed transfer rate |
| GPU | the busiest GPU's utilization, % | its temperature, °C | that GPU's utilization |

The band keeps its own 60-sample window (`chart-history.ts`), pushed once per
snapshot like the performance tab's, so it spans 60 × the sampling interval and
freezes while sampling is paused. A card is a button: `performance-target.ts`
hands the device to the performance tab and the card switches to it. The keys
are `cpu`, `memory`, `disk:<index>`, `nic:<id>` and `gpu:<id>`; the performance
tab spells the last three with a dot (`disk.0`), and the hand-off maps between
them. The disk card opens the busiest disk, the network card the first adapter
and the GPU card the busiest GPU — the same devices whose figures the cards
show.

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

Clicking a column header sorts by name, PID, CPU, memory, disk read, disk write,
I/O, network, GPU, threads or handles; the first click on a numeric column sorts
descending (busiest first) and the default is CPU descending. Groups are sorted
by their aggregate value; processes whose disk rate is still `null` sort after
measured ones.

The table is virtualized with `@tanstack/react-virtual` at a fixed 32 px row;
only rows near the viewport exist in the DOM, so a 300-process machine scrolls
without jumps. Column headers stay sticky.

### Columns

Name (with the executable's icon and indentation), PID, CPU, memory, disk read,
disk write, I/O, GPU, network, threads and handles. The icons come from the
sampler's per-executable cache, are fetched lazily and fall back to a generic
app icon (or a kernel icon for a process without an image path). The network
column exists only while the service measures it; without the service it is
hidden and the toolbar explains why. A suspended process carries a tag beside
its name instead of occupying a status column.

### Detail panel

Selecting a row opens the panel to the right of the table. The table and the
panel scroll independently (the table keeps its own horizontal scroll) and the
page itself never overflows sideways. The panel is 360 px wide by default and
resizes between 280 and 520 px by dragging its left edge, with the arrow keys,
or by double-clicking for the default; the width is component state, not a
preference, so a fresh page starts at the default.

The header carries the executable's icon, the label, name, PID and company, and
a close button that clears the selection. Below it, CPU, memory, disk and —
while the service measures it — network mini charts, plus GPU on a machine that
has one, plot that process instance's own 60-sample window
(`process-history.ts`, keyed by `pid:createTime`, capped at 500 processes and
pruned to the processes in the newest snapshot). The ported sections follow —
process, resources, path, command line and version — with the copy and end
actions pinned at the bottom. The fast fields (path, resources, threads,
handles) come from the snapshot; the slow ones (command line, user, integrity
level, architecture, priority, version resource) come from
`argus_process_details`. A response that arrives after the panel moved to
another process is discarded, and a process that cannot be opened comes back
with `accessible: false`; the panel shows why instead of empty fields.

With nothing selected the panel shows this computer's parts — processor,
memory, every disk, adapter, GPU and battery, with the reading that matters for
each — in the performance page's colors, and each line opens that device on the
performance tab. An ended process clears the selection, so the panel returns to
that overview by itself.

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
the operation to the service only on `access-denied`. A tree kill reports what
actually happened: the toast follows the returned `TreeKillReport`, so children
that could not be ended are called out instead of being counted as successes.

## Performance tab

The tab is a device list beside one detail view, like Task Manager's own
performance page. The list has an entry per CPU, memory package, physical disk,
network adapter, GPU and battery; each shows its current reading and a
sparkline over the same sample window. Selecting an entry switches the
detail view; the selection falls back to the first device when its own device
disappears.

- **CPU** — total utilization with kernel time, or the logical-processor grid
  (one traced card per thread). A hybrid CPU can show all cores or only its P
  or E cores, and the mode toggle switches between the overall and per-core
  views. The facts below cover base speed, sockets, cores, cache and
  virtualization.
- **Memory** — used, available, committed, cached, the paged pools and the
  composition bar; the installed modules' speed, slots, form factor and type.
- **Disk** — each physical disk's busy time and read/write rates, response
  time, capacity, bus and temperature.
- **Network** — each adapter's received/sent rates, link speed, addresses and
  MAC.
- **GPU** — an engine-utilization grid above dedicated and shared memory
  charts, with smart display or a chosen engine count, a picker per chart, grid
  / focus / list layouts and a draggable split between the two areas; clocks,
  temperature, fan and power below.
- **Battery** — charge level and flow, wear against design capacity, cycle
  count and the pack's identity. Machines without a battery simply do not get
  the entry.

The history is 60 samples (`chart-history.ts`), one point per snapshot. Each
frame appends one point and drops the oldest, so consecutive readings always
join and the curve never breaks between samples; only a reading that is
unavailable (rates on the first frames) becomes `null`. The window therefore
spans 60 × the sampling interval — 60 s at 1 s, 300 s at 5 s — and the chart's
axis labels follow it. Pausing freezes the window: no new points are pushed, so
the right edge stops moving. When the page is left the tab unmounts and the
history is dropped.

Each resource has its own hue (`--perf-cpu`, `--perf-mem`, `--perf-io`,
`--perf-net`, `--perf-gpu`, `--perf-bat`), with a lighter set for the dark
theme. A hybrid CPU draws performance cores and efficiency cores in two
different colors.

Battery telemetry comes from the battery class driver's IOCTLs (the source
behind `powercfg /batteryreport`), not WMI, and standard users may open the
devices read-only.

## Services tab

The tab lists every Win32 service from the Service Control Manager: display
name, key name, hosting PID, state, startup type and description. It is a plain
table — a few hundred rows at most, so it is not virtualized — with a sticky
header and the same 32 px row height as the process table.

### Data and polling

- **One SCM pass per list read.** `argus_services_list` calls
  `EnumServicesStatusExW` once for every service's state and PID. The static
  configuration (display name, startup type, binary path, account, description)
  costs three RPCs per service, so `ServiceCatalog` caches it for 60 seconds;
  `invalidate` drops one entry after a control action or a start-type change.
- **Display names are read in the caller's language.** The description comes
  from the service configuration and is overridden by the registry's MUI string
  when one exists, so a localized Windows shows the localized text.
- **Polling is tab- and visibility-scoped.** The tab fetches immediately when
  it becomes the selected tab and then every 3 seconds, but only while the tab
  is selected *and* `document.visibilityState` is `visible`. Switching to
  Processes or Performance, hiding the page or unmounting the tab clears the
  timer; becoming visible again fetches at once. The fetched list lives in the
  tab's own component state — it is not part of `Snapshot` or the shared
  `useTaskManager` store.
- **Standard users can read the list.** `EnumServicesStatusExW` needs no
  elevation. A configuration query that the account cannot perform leaves
  `startType` `null`, which the table renders as `—`.

### Search, filter and sort

Search matches the display name, key name, description or an exact PID.
The state filter is **All / Running / Stopped**: running and stopped are exact
matches, so every pending state appears only under All. Clicking a column header
sorts by service, service name, PID, status, startup type or description; the
default is display name ascending, and clicking the active header reverses it.
Startup types sort in Windows' own order (boot, system, automatic, automatic
delayed, manual, disabled) with an unknown type last. Sorting is stable: equal
values keep the order they arrived in. `src/lib/task-manager/service-rows.ts`
holds all of this as pure functions and is covered by vitest.

The empty states are distinct: while the first read is in flight the tab shows
a skeleton, a failed read shows the translated error with a retry button, and a
list with no match for the current query or filter offers **Clear filters**.

### Actions

| Action | Behaviour |
| --- | --- |
| **Start / Stop / Restart** | Toolbar buttons act on the selected row; the context menu acts on the right-clicked one |
| **Startup type** | Context submenu: Automatic, Automatic (delayed start), Manual, Disabled; the current one is checked |
| **Copy service name** | Copies the key name |
| **Open file location** | Splits the executable out of the service command line and reveals it with `systools_reveal_in_file_manager` |
| **Open Services** | Launches `mmc.exe services.msc` as a separate process |

- **Disabled rules.** A service in a pending state (or with an action already
  in flight) cannot be acted on. Start is disabled while it runs; stop and
  restart are disabled when the service does not accept stop requests
  (`canStop`), which includes drivers and services without a stop control.
- **Every action ends in a toast**, translated from the error's `code` through
  `argusErrorKey`, and refreshes the list afterwards.
- **Permission routing.** The host tries the SCM with its own rights first.
  Only on `access-denied`, and only when the host is not elevated, is the same
  operation handed to the privileged service; its answer is authoritative and
  is never retried locally. Stopping a protected service and changing any
  startup type generally need administrator rights or the service. A service
  installed under an older protocol is reported as outdated, so the page asks
  for an update instead of showing a misleading access-denied error.
- **Not implemented on purpose.** Argus's per-row pin / note marks, its
  "go to process" jump and double-clicking a row to open the process tab are
  not part of this port; the row has no action that would need them.



The service is optional. It is a LocalSystem Windows service named
`WingHarnessPrivileged` (`WingHarnessPrivilegedDev` in a development build),
listening on `\\.\pipe\WingHarness.Privileged.v1`
(`.Dev.v1` for development). The host and the service speak a versioned JSON
protocol whose operation set is fixed by an enum: `Ping`, `NetworkSnapshot`,
`DiskSnapshot`, `Terminate`, `Priority`, `Efficiency`, `ControlService` and
`ServiceStartType`. Unknown operations or fields are rejected, a `Terminate`
must carry a positive PID and creation time, and a service operation must name
a non-empty service of at most 256 bytes — the System process, Idle and the
service itself are never valid targets. The operation set is protocol version
3; a Ping is always sent in the version-1 envelope so an older service can
report its version, and a version-2 service is reported as outdated rather
than as denying the new operations.

What the service provides:

- Process termination, priority changes and efficiency mode for processes the
  current account cannot open.
- Service control (start, stop, restart) and startup-type changes for services
  the account cannot change.
- Per-process network traffic from an ETW session.
- Per-process disk counters (read/write bytes per second).

What it deliberately does **not** provide: a kernel driver (PawnIO), sensors or
fan control, a Task Manager replacement, privilege-elevation helpers for other
programs, handle or file-lock queries, or connection management. It creates no
window and starts no webview.

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
| `argus_icon` | `{ id }` | A PNG data URL, or `null` while the icon is unresolved |
| `argus_kill_process` | `{ pid, createTime, force }` | — |
| `argus_kill_process_tree` | `{ pid, createTime }` | `TreeKillReport` |
| `argus_set_priority` | `{ pid, createTime, priority }` | The priority the process ended up with |
| `argus_set_efficiency` | `{ pid, createTime, on }` | — |
| `argus_service_status` | — | `ServiceStatus` |
| `argus_service_manage` | `{ action }` (`install` / `uninstall` / `update`) | `ServiceStatus` |
| `argus_services_list` | — | `ServiceInfo[]` |
| `argus_service_control` | `{ name, action }` (`start` / `stop` / `restart`) | — |
| `argus_service_start_type` | `{ name, startType }` (`auto` / `autoDelayed` / `manual` / `disabled`) | — |
| `argus_services_console` | — | — |

A command is only callable once it is named in all four lists: `all_commands!`
in `src/invoke.rs`, `COMMANDS` in `build.rs`, `capabilities/default.json`, and
`permissions/autogenerated/*.toml`.

Every action carries the process creation time together with the PID, so a
reused PID cannot make the page act on a different process. Errors are
`{ code, message, detail? }`; `message` is English for logs, and the frontend
translates by `code` through `argusErrorKey`:

| Code | Meaning |
| --- | --- |
| `not-found` | The process has already exited, or its PID was reused, or the service no longer exists |
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
- **Disk and network need warm-up.** Rates need two samples; the first ticks
  show `—`, and a process that just started has no disk or network row yet.
- **Per-process network needs the service.** Without it the network column is
  hidden and the page explains why in the toolbar hint.
- **Service control needs rights.** Reading the service list needs none, but
  starting, stopping or changing the startup type of a protected service needs
  administrator rights or the privileged service. A service configuration the
  account cannot read shows its startup type as `—`.
- **GPU and disk hardware can be absent.** Machines without a supported GPU or
  with no disk counters get the panel's empty state, not an error.
- **Protected processes.** The detail panel explains that it cannot read the
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
| The network column is missing | The privileged service is not installed or not running |
| Ending a system process says access denied | Install the service; the message says so |
| Starting or stopping a protected service says access denied | Install the service, or run the app as administrator; the page explains this under the list |
| Changing a service's startup type says access denied | Startup-type changes always need administrator rights or the service |
| The service badge says incompatible | The installed service speaks another protocol; use **Update service** |
| Settings reset to the defaults | `settings.json` could not be parsed; look for `settings.json.bak-*` in the data directory |
| Charts show gaps | A reading was unavailable for that frame (rates need two samples); the line breaks only there |
| Efficiency mode has no visible effect | Check it in Windows 11's Task Manager; Windows 10 does not show the badge |

## Licence

`src-tauri/argus-core` and `src-tauri/argus-service` are adapted from Argus
(https://github.com/Ray-lea/Argus), version 0.3.4, AGPL-3.0-or-later. The
project as a whole is AGPL-3.0-only; the ported portions keep their AGPL
notice, and every ported file carries an attribution header. The porting
records are [argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) and
[argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md); the
notice is in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
