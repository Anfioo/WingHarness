# Task Manager

The **任务管理器** (Task Manager) page shows what this machine is doing: six tabs
over one shared snapshot — the process table with three views, a detail panel and
process actions; a performance tab with CPU, memory, disk, network, GPU and
battery detail views; the Windows Service Control Manager; the programs that
start at logon; every TCP and UDP endpoint; and the recorded history of the
system charts. An optional Windows service adds actions on protected system
processes, service control, connection reset and per-process network and disk
traffic; without it the page still monitors everything that needs only the
account's own rights.

It sits in the sidebar under **其他** (Other) and is a single page — it opens no
window of its own. Its settings live in the global Settings window, and its
background-monitoring switch also has a row in the tray popup. Sampling runs
while the page is mounted; background monitoring keeps it running after the page
closes and records history to disk.

Two other pages overlap this one on purpose: `systools` has its own startup
manager, and `ports` has its own listener table. This page does not replace
either; see [SYSTOOLS.md](./SYSTOOLS.md) and [PORTS.md](./PORTS.md).

The engines are [`src-tauri/argus-core`](../../src-tauri/argus-core) (crate
`argus-core`, library `argus_core`) and
[`src-tauri/argus-service`](../../src-tauri/argus-service) (crate
`argus-service`, library `argus_service`). Both are adapted from
[Argus](https://github.com/Ray-lea/Argus) 0.3.4 (AGPL-3.0-or-later);
[argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) and
[argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md) record
what came across and what did not.

## Routes and files

| Route / window | Renders |
| --- | --- |
| `/task-manager` | The page: the tab strip with the service badge, refresh and settings actions, and the process, performance, services, startup, connections and history tabs |
| Settings window, `taskManager` section | Sampling interval, background monitoring, history usage and clearing, service install/update/uninstall |

| Path | Responsibility |
| --- | --- |
| `src/pages/task-manager/index.tsx` | Page shell inside `AppShell` |
| `src/pages/task-manager/task-manager-app.tsx` | Tab strip (with the service badge, refresh and settings), all six tab panels |
| `src/pages/task-manager/tabs/processes.tsx` | Process tab: the vitals band, toolbar, table, inline detail panel, confirmation dialogs |
| `src/pages/task-manager/tabs/performance.tsx` | Performance tab: the device list, one detail view per device, the 60-sample window |
| `src/pages/task-manager/tabs/services.tsx` | Services tab: polling lifecycle, search / filter / sort state, toolbar actions, toasts |
| `src/pages/task-manager/tabs/startup.tsx` | Startup tab: 10 s polling, search, sort, enable/disable |
| `src/pages/task-manager/tabs/connections.tsx` | Connections tab: 2 s polling while active and visible, filters, search, context actions |
| `src/pages/task-manager/tabs/history.tsx` | History tab: range switch, chart cursor, the busy-process table of the selected moment |
| `src/components/task-manager/` | Table, toolbar, row, detail body and actions, right-hand detail panel, vitals band, hardware overview, splitter, context menu, service table and menu, the performance device list and per-device views, service badge, startup and connection tables/toolbars/menus, the history chart and process table, the settings partition's controls, `format.ts` |
| `src/hooks/use-task-manager.ts` | One shared store: channel, settings, service status, actions |
| `src/hooks/use-task-manager-{startup,connections,history,settings}.ts` | Per-tab polling and state; `settings` belongs to the Settings window |
| `src/commands/services/task-manager/` | Typed wrappers over the twenty-eight `argus_*` commands and their DTOs |
| `src/lib/task-manager/` | Pure logic: `process-search`, `process-sections`, `process-identity`, `process-history`, `performance-target`, `service-rows`, `startup-rows`, `connection-rows`, `history-range`, `history-format`, `history-metrics`, `chart-history`, `chart-scale`, `chart-metrics`, `chart-memory`, `chart-colors`, `engine-grid`, `settings-event` |
| `src/windows/settings/task-manager-section.tsx` | The task manager partition of the Settings window |
| `src/windows/tray-menu/task-manager-row.tsx` | The tray popup's background-monitoring row |
| `src-tauri/src/commands/argus.rs` | The thin command surface |
| `src-tauri/src/argus/` | `sampler.rs` (sampling thread), `service.rs` (status, install and connection routing), `store.rs` (settings), `mod.rs` (`ArgusState`) |

There is no `standalonePaths` entry and no window record for the page itself:
everything is one route in the main window. The sidebar group `taskManager` is
deliberately absent from `GROUP_ORDER` in `src/lib/sidebar-config.ts`, so the
entry falls into **其他**.

## Sampling lifecycle

```
page mounts
  → useTaskManager() store starts (first subscriber only)
  → argus_settings_get
  → argus_snapshot_start { channel, intervalMs }
      → sampler thread: Collector + ETW session + service clients
      → one frame per tick over ipc::Channel<Snapshot>
      → when background monitoring is on, the same frame feeds the history recorder
page unmounts (last subscriber)
  → argus_snapshot_stop
      background off → thread stops, ETW session released
      background on  → only the page's subscription is dropped; the thread keeps
                       sampling at the background interval and recording history
app exits → the thread stops
```

- **One subscription per page.** The page shell and every tab call
  `useTaskManager()`, but a module-level store owns the single
  `Channel<Snapshot>`: the first caller starts sampling and the last one to
  unmount stops it — unless background monitoring is on, in which case
  `argus_snapshot_stop` only unsubscribes. Pausing only drops incoming frames;
  the backend keeps sampling, so resuming is immediate.
- **Background monitoring** is one switch (`backgroundMonitoring`) for both
  sampling and history; it is off by default. Its interval is 1–60 s, default
  5 s, and is clamped on read and write. Turning it on starts a thread even with
  no page open; turning it off stops the thread when no page is subscribed.
  Every change is persisted and broadcast as `argus-settings-changed`.
- **No global event for frames.** Frames travel over a Tauri channel to this
  page only. The only global event is `argus-settings-changed`, which carries
  the settings document to the page, the Settings window and the tray row.
- **Fresh baseline.** Each start builds a new collector, so the first one or two
  ticks have no CPU or rate figures (there is no previous sample to diff
  against). Leaving the page clears the performance tab's 60-sample window by
  unmounting it; recorded history is not affected.
- **Interval** is 250–5000 ms, default 1000 ms. It is clamped on read and on
  write, and changing it in the Settings window restarts the tick immediately.
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

## Startup tab

The tab lists every program that starts at logon, from five registry/folder
sources plus packaged app tasks:

| Source | Location id | Scope |
| --- | --- | --- |
| `HKCU\…\CurrentVersion\Run` | `hkcuRun` | current user |
| `HKLM\…\CurrentVersion\Run` | `hklmRun` | all users |
| `HKLM\Software\WOW6432Node\…\Run` | `hklmRun32` | all users (32-bit view) |
| Startup folder under `%APPDATA%` | `userFolder` | current user |
| Startup folder under `%ProgramData%` | `commonFolder` | all users |
| AppModel startup tasks | `package` | current user |

Each row shows the name (program metadata or the shortcut name), publisher,
status switch, location and command; a missing executable is marked beside the
name. Search matches the name, entry, publisher, command and description; the
columns sort by name, publisher, status, location or command. The list polls
every 10 seconds, and only while the tab is active and the document is visible.

- **Identity.** `id` is `<location>|<entry>`, and it is what
  `argus_startup_set_enabled` receives. A malformed id, or one naming no known
  location, is refused before anything touches the registry.
- **Enable/disable** writes the 12-byte `StartupApproved` value instead of
  editing the entry: an even first byte enables, an odd first byte with a
  timestamp disables, which is how Windows' own Task Manager does it. The switch
  updates optimistically and is rolled back with a toast when the write fails.
- **Rights.** Current-user entries change immediately. All-users entries need
  administrator rights; the failure comes back as `access-denied` and is shown
  as a toast. Packaged tasks that are policy-managed or unavailable carry
  `blocked` and their switch is disabled.
- **Packaged tasks** are read from the app manifest; one task that cannot be
  read is skipped and logged without hiding the rest of the list.
- **Coexistence.** The `systools` page has its own startup manager with a
  different model (scan, plan, apply). Both read the same Windows state; this
  tab is the Task Manager-style per-entry switch, and neither replaces the
  other.

## Connections tab

The tab lists every TCP and UDP endpoint with the process that owns it, read
from `GetExtendedTcpTable` / `GetExtendedUdpTable` for IPv4 and IPv6. Rows show
the process, protocol, local endpoint, remote endpoint, TCP state and PID;
IPv6 endpoints are bracketed. The list polls every 2 seconds, and only while
the tab is active and the document is visible; switching back refreshes at once.

- **Filters** — All / Listening / Established / UDP. They match exactly:
  pending TCP states appear only under All.
- **Search** — a digits-only query matches the local port, the remote port or
  the PID exactly; anything else matches a substring of the local and remote
  addresses, the process name or its description.
- **Sorting** — click a header to sort by process, protocol, local endpoint,
  remote endpoint, state or PID; the default is local port ascending.
- **Go to process** hands the PID to the process tab through the shared
  `revealPid`; the process row is selected there. Ending a process asks first
  and reports a process that has already exited instead of failing silently.
- **Close connection** is enabled only for an established IPv4 TCP row and only
  when the privileged service is running and authorized. The host calls
  `SetTcpEntry` locally first; on `access-denied` and when it is not elevated it
  routes the same request to the service, whose answer is authoritative and is
  never retried locally. UDP, IPv6 and non-established rows expose no reset.
- **Copy** copies the local or remote endpoint.
- **Coexistence.** The `ports` page owns TCP listeners, pinning and ending the
  process behind a port. This tab is the Task Manager-style full endpoint list;
  both pages read live state and stay independent.

## History tab

When background monitoring is on, the sampler writes one frame every 5 seconds
to `<data dir>/argus/history/<YYYY-MM-DD>.hist` (the source's `ARGH` version 2
format), keeps 7 days, prunes expired files at startup and truncates a torn tail
record when it opens a file. History is written only while the sampler runs, so
the default configuration (background off) produces no files.

- **Ranges** — 1 hour, 6 hours, 24 hours, 7 days. Each asks the backend for at
  most a few hundred buckets; the backend averages frames into them, caps the
  request at 4096 buckets and leaves empty buckets out.
- **Gaps** — the charts break the line where the recorder was not running. A
  pair of points is joined when their spacing fits the surrounding cadence, up
  to 65 seconds (the slowest background interval plus lateness); a longer stop
  leaves a visible gap.
- **Cursor** — hovering reads the nearest moment; clicking or the arrow keys pin
  it, Shift moves further, Page Up/Down jumps, Home/End go to the edges and
  Escape returns to the newest point. The readout follows the pinned moment
  unless the pointer is reading another.
- **Processes** — the table below the charts shows the busiest processes in the
  selected frame. Right-click or activate a row to go to the process tab when
  the process is still running; an exited process is reported with a toast.
- **Empty states** distinguish "recording is off" (with a link to the Settings
  partition), "no history recorded yet" and "the query failed" (with retry).
- **Clearing** happens in the Settings partition. It closes the recorder's file
  first, deletes only `.hist` day files and leaves the history tab empty.

## Settings partition

The task manager's settings moved out of the page into the global Settings
window, section `taskManager`. The page's gear button and the service badge both
call `openSettingsSection("taskManager")`; if the Settings window is already
open it receives the `settings-section` event and focuses that section instead
of opening a second window. There is no in-page settings dialog or service
panel any more.

The partition holds:

| Control | Behaviour |
| --- | --- |
| Sampling interval | 250 / 500 / 1000 / 2000 / 5000 ms; saves immediately |
| Background monitoring | One switch for sampling and history; 5 / 10 / 15 / 30 s presets (or the saved value) |
| History storage | Current size and oldest record, retry, and clear with confirmation |
| Privileged service | Status, recheck, install, update and uninstall |

- Every setting saves at once; a failed save toasts and leaves the previous
  value in place. The backend clamps both intervals and broadcasts
  `argus-settings-changed`, so the page, the tray row and this window agree
  without polling.
- Starting or reading the partition never starts the page's sampling thread.
- Only install, update and uninstall ask for UAC. Cancelling the prompt changes
  nothing.

## Tray row

The tray popup (`tray-menu`) has one row after FRP and the divider before Quit:
**background monitoring**. It shows the current value and toggles it through
`argus_set_background_monitoring`; a failed toggle reverts the switch and
toasts. The popup is sized from constants, so adding the row changed
`MENU_ITEM_COUNT` and the height to 9 rows / 305 px — see
[TRAY_MENU.md](./TRAY_MENU.md).

## Privileged service

The service is optional. It is a LocalSystem Windows service named
`WingHarnessPrivileged` (`WingHarnessPrivilegedDev` in a development build),
listening on `\\.\pipe\WingHarness.Privileged.v1`
(`.Dev.v1` for development). The host and the service speak a versioned JSON
protocol whose operation set is fixed by an enum: `Ping`, `NetworkSnapshot`,
`DiskSnapshot`, `Terminate`, `Priority`, `Efficiency`, `ControlService`,
`ServiceStartType` and `CloseConnection`. Unknown operations or fields are
rejected, a `Terminate` must carry a positive PID and creation time, a service
operation must name a non-empty service of at most 256 bytes, and a
`CloseConnection` must carry two non-zero ports and two IPv4 addresses — the
System process, Idle and the service itself are never valid targets. The
operation set is protocol version 4; a Ping is always sent in the version-1
envelope so an older service can report its version, and a version-3 (or older)
service is reported as outdated rather than as denying the new operations.

What the service provides:

- Process termination, priority changes and efficiency mode for processes the
  current account cannot open.
- Service control (start, stop, restart) and startup-type changes for services
  the account cannot change.
- Per-process network traffic from an ETW session.
- Per-process disk counters (read/write bytes per second).
- Resetting an established IPv4 TCP connection on behalf of an unelevated
  caller. Connection enumeration itself stays local; the service only performs
  the reset when the local `SetTcpEntry` is denied.

What it deliberately does **not** provide: a kernel driver (PawnIO), sensors or
fan control, a Task Manager replacement, privilege-elevation helpers for other
programs, handle or file-lock queries, or UDP/IPv6 connection resets. It creates
no window and starts no webview.

### Install, update and uninstall

| Action | What happens |
| --- | --- |
| **Install** | Confirmation, then one UAC prompt (`ShellExecuteExW` with `runas`). The helper copies the payload to `%ProgramFiles%\WingHarness Privileged[ Dev]`, records the installing account's SID in `owner.sid`, creates and starts the service, and restricts the directory to Administrators/SYSTEM |
| **Update** | The same UAC path replaces the binary and restarts the service; offered after an app upgrade when the installed service speaks another protocol |
| **Uninstall** | One UAC prompt, then the service is stopped, deleted, and its binary, `owner.sid` and lock file are removed; the directory is removed only if it is empty |

- Cancelling the UAC prompt changes nothing. The action's failure is toasted
  from its error code; a cancellation currently arrives as `access-denied` and
  is not distinguished from a real denial.
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
| `argus_startup_list` | — | `StartupItem[]` |
| `argus_startup_set_enabled` | `{ id, enabled }` | — |
| `argus_connections_list` | — | `Connection[]` |
| `argus_connections_close` | `{ localAddress, localPort, remoteAddress, remotePort }` | — |
| `argus_history_range` | — | `[first, last]` Unix ms, or `null` |
| `argus_history_series` | `{ from, to, buckets }` | `HistoryPoint[]` |
| `argus_history_moment` | `{ ts }` | `HistoryMoment \| null` |
| `argus_history_usage` | — | `HistoryUsage` |
| `argus_history_clear` | — | — |
| `argus_set_background_monitoring` | `{ enabled }` | `ArgusSettings` |

A command is only callable once it is named in all four lists: `all_commands!`
in `src/invoke.rs`, `COMMANDS` in `build.rs`, `capabilities/default.json`, and
`permissions/autogenerated/*.toml`.

Every action carries the process creation time together with the PID, so a
reused PID cannot make the page act on a different process. Errors are
`{ code, message, detail? }`; `message` is English for logs, and the frontend
translates by `code` through `argusErrorKey`:

| Code | Meaning |
| --- | --- |
| `not-found` | The process has already exited, or its PID was reused, the service no longer exists, a startup entry has vanished, or the history moment has no frame |
| `invalid-input` | The interval is out of range, a startup id is malformed, a connection reset target is not IPv4 or has a zero port, a history range is invalid, the service action is unknown, or the target is this app |
| `access-denied` | Administrator rights or the privileged service are required (including a machine-level startup entry and a connection reset) |
| `service-unavailable` | The service is not installed or not running, or speaks another protocol |
| `internal` | Another Windows error, a registry/file/COM failure or an aggregation failure; `detail` carries it |

## Data layout

```
<data dir>/argus/
├── settings.json
└── history/
    └── <YYYY-MM-DD>.hist
```

```json
{
  "version": 2,
  "intervalMs": 1000,
  "backgroundMonitoring": false,
  "backgroundIntervalMs": 5000
}
```

`version` is written for future migrations and ignored on read. A version-1 file
simply lacks the background fields, which take their defaults and are written
back as version 2 on the next save. The directory is
`argus_core::paths::CONFIG_DIR`, set once in `src-tauri/src/lib.rs` to
`config::dir().join("argus")`.

- **Missing file** — the defaults, and nothing is written.
- **Write** — staged as `settings.json.tmp`, flushed with `sync_all`, then
  renamed over the target under a process-wide `Mutex`.
- **Unparseable file** — renamed to `settings.json.bak-<unix seconds>` and
  replaced by the defaults in memory, so a hand-edited file never wedges the
  page.
- **Validation** — `intervalMs` is clamped to 250–5000 and
  `backgroundIntervalMs` to 1000–60000 on read and on write; unknown fields and
  a future `version` are ignored.
- **History** is the one persisted-data exception on this page: day files live
  under the same data directory (never `localStorage`), one frame every 5
  seconds, seven days kept. They are written only while background monitoring
  is on and are cleared only through `argus_history_clear`, which closes the
  recorder's file before deleting.

No rules or automation store is part of this port.

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
- **Background monitoring is off by default.** A fresh profile samples only
  while the page is open and writes no history. Turn it on from the Settings
  window or the tray row.
- **History is short by design.** One frame per 5 seconds, seven days kept, so a
  week of history stays a few megabytes. The sampler also has to be running:
  gaps appear whenever background monitoring was off.
- **Connection reset is narrow.** Only established IPv4 TCP connections can be
  reset, and only locally or through the privileged service. UDP and IPv6
  connections can be inspected but not reset.
- **Startup entries follow Windows rules.** All-users entries need
  administrator rights, policy-managed packaged tasks cannot be changed, and an
  entry whose executable is gone is marked but still listed.

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
| Charts show gaps | A reading was unavailable for that frame (rates need two samples), or the recorder was not running; the line breaks only there |
| History stays empty | Background monitoring is off (the tab says so and links to the Settings partition), or no frame has been recorded yet |
| **Close connection** is disabled | The row is not an established IPv4 TCP connection, or the privileged service is not running and authorized |
| A startup switch says access denied | The entry belongs to all users; it needs administrator rights |
| The tray row and the Settings window disagree | The settings event did not arrive; both listen to `argus-settings-changed`, so reload the window and report it |
| Efficiency mode has no visible effect | Check it in Windows 11's Task Manager; Windows 10 does not show the badge |

## Licence

`src-tauri/argus-core` and `src-tauri/argus-service` are adapted from Argus
(https://github.com/Ray-lea/Argus), version 0.3.4, AGPL-3.0-or-later. The
project as a whole is AGPL-3.0-only; the ported portions keep their AGPL
notice, and every ported file carries an attribution header. The porting
records are [argus-core/UPSTREAM.md](../../src-tauri/argus-core/UPSTREAM.md) and
[argus-service/UPSTREAM.md](../../src-tauri/argus-service/UPSTREAM.md); the
notice is in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
