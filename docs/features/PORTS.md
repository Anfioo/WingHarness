# Port Management

The **端口** (Ports) page lists every TCP port this machine is listening on,
keeps a set of common development ports pinned on top, and can end the process
behind a port. It sits in the sidebar under **其他** (Other) and is a single
page — it opens no window of its own.

The engine is [`src-tauri/ports-core`](../../src-tauri/ports-core) (crate
`ports-core`, library `ports_core`). It is adapted from
[Porter](https://github.com/t21dev/porter-app) (MIT);
[ports-core/UPSTREAM.md](../../src-tauri/ports-core/UPSTREAM.md) records what
came across and what did not.

## Routes and files

| Route | Renders |
| --- | --- |
| `/ports` | The page: stats, toolbar, pinned and other lists, detail sheet, settings dialog |

| Path | Responsibility |
| --- | --- |
| `src/pages/ports/index.tsx` | Page shell; assembles the hook and the three component groups |
| `src/hooks/use-ports-page.ts` | Settings, two polling loops, filters, counts, the kill flow |
| `src/components/ports/` | Stats, toolbar, list, row, detail sheet, settings dialog, shared prop types |
| `src/commands/services/ports/` | Typed wrappers over the seven `ports_*` commands and their DTOs |
| `src/lib/ports/port-services.ts` | The service map used by the page (with the attribution header) |

There is no `standalonePaths` entry and no window record: everything is one
route in the main window. The sidebar group `ports` is deliberately absent from
`GROUP_ORDER` in `src/lib/sidebar-config.ts`, so the entry falls into **其他**.

## Views

- **Stats** — three counts, `free`, `occupied` and `system`, computed over the
  rows that are currently visible, not over the whole table.
- **Toolbar** — search, the three status toggles, a manual refresh, and a hint
  that reads either the last update time or **已暂停** (paused). `/` focuses the
  search box; `Escape` clears it.
- **List** — the pinned section always, then the other ports collapsed behind a
  header button. With *pinned only* on, the other section is not rendered at
  all.
- **Detail sheet** — opens on a row and calls `ports_detail` lazily; a response
  that arrives after the sheet closed or moved to another port is discarded.
- **Settings dialog** — add and remove pinned ports, reset to the five defaults,
  and toggle *pinned only*. Edits are a draft: closing without saving drops them.

## Scanning

On Windows the listener table comes from IPHLPAPI `GetExtendedTcpTable` with
`TCP_TABLE_OWNER_PID_LISTENER`, once for `AF_INET` and once for `AF_INET6`. The
size query is retried up to four times when the table grows between the size
query and the read (`ERROR_INSUFFICIENT_BUFFER`).

```
ports_list
  → read_listeners (IPv4 + IPv6 listener rows)
      dedupe by port, first row wins, ascending
  → process_names: refresh only the owning PIDs, never the whole table
  → Vec<PortEntry>
```

**One row per port.** A socket bound on both `0.0.0.0` and `::` is a single
row, and the address shown is the first one the table returned.

**Three states**, from `status_for`:

| Condition | Status |
| --- | --- |
| No owning process is known | `free` |
| Owning PID below 1 000 | `system` |
| Anything else | `occupied` |

The PID threshold (`SYSTEM_PID_LIMIT = 1000`) is a Windows heuristic for
system services, not a privilege check. A pinned port nothing listens on comes
back from `ports_pinned_scan` as a `free` placeholder with no address and no
process, so it can be shown before its service starts.

`ports_detail` reads the listener table once, finds the port, and refreshes only
that PID with executable path, command line, working directory, memory, start
time and user. Any field sysinfo cannot resolve stays `null` and the sheet shows
**未知** (unknown).

## Polling

| Loop | Interval |
| --- | --- |
| All listening ports (`ports_list`) | 3 000 ms |
| Pinned ports (`ports_pinned_scan`) | 2 000 ms |

Polling is paused when any of these is true: the page is not active
(`usePageActive()`), the document is hidden, or the window is minimized. The
effect returns early while paused, so the first resume fetches immediately
instead of waiting for the next tick. A change to the pinned list restarts both
loops through `pinnedKey`. A successful `ports_list` clears the error row; a
failed pinned scan sets it again on the next tick.

## Filters and counts

Search matches the port number as a substring and, for non-free rows, the
process name. It is case-insensitive and trimmed. The three status toggles
combine with it, and both apply to the pinned list as well as the other list —
turning every status off hides the pinned ports too.

`counts` is computed from `[...pinned, ...others]`, so it always describes what
is on screen. With a query active the page switches to a single merged results
list, deduplicated by port and ascending.

## Ending a process

```
ports_kill { pid }
  ensure_killable
  → sysinfo process.kill()
  → poll for exit, 50 ms steps, 500 ms budget
  → Ok | access_denied | not_found | invalid_input | internal
```

`ensure_killable` rejects, in this order: PID 0, this app's own process, PIDs
below 1 000, PIDs that own no listening port, and PIDs that no longer exist.
The listening-port check is what keeps the command from becoming a generic
process killer. None of these rejections reach the elevation path.

What ends up in the UI:

- `access_denied` on `ports_kill` triggers one call to `ports_kill_elevated`
  with the same PID.
- The elevated call runs `%SystemRoot%\System32\taskkill.exe /PID <pid> /F`
  through `ShellExecuteExW` with the `runas` verb, hidden, behind a single UAC
  prompt. It waits up to 15 s for the child and maps exit 0 to success, 128 to
  `not_found`, and anything else to `elevation_failed` with `detail.exitCode`.
- A cancelled UAC prompt is `elevation_cancelled`; the page shows an info toast
  and the process is untouched.
- After either path the page refreshes both lists.

Every command string is built inside the crate; the frontend only ever sends a
PID.

## Commands

| Command | Arguments | Returns |
| --- | --- | --- |
| `ports_settings_get` | — | `PortsSettings` |
| `ports_settings_set` | `{ settings }` | The normalized settings that were written |
| `ports_list` | — | `PortEntry[]` |
| `ports_pinned_scan` | `{ ports }` | `PortEntry[]`, free placeholders included |
| `ports_detail` | `{ port }` | `PortDetail \| null` |
| `ports_kill` | `{ pid }` | `void` |
| `ports_kill_elevated` | `{ pid }` | `void` |

A command is only callable once it is named in all four lists: `all_commands!`
in `src/invoke.rs`, `COMMANDS` in `build.rs`, `capabilities/default.json`, and
`permissions/autogenerated/*.toml`.

Errors are `{ code, message, detail }`, with `message` in English for logs and
the frontend translating by `code`:

| Code | Meaning |
| --- | --- |
| `not-found` | The process or port is gone |
| `invalid-input` | A PID or port the page must not act on, `detail.field` names it |
| `access-denied` | Windows refused the plain termination — try the elevated path |
| `elevation-cancelled` | The UAC prompt was dismissed |
| `elevation-failed` | The elevated `taskkill` failed, timed out, or returned another code |
| `not-implemented` | Reserved; no command returns it today |
| `internal` | A read or write that could not be done |

## Data layout

```
<data dir>/ports/
└── settings.json
```

```json
{
  "version": 1,
  "pinnedPorts": [3000, 5173, 8080, 5432, 27017],
  "pinnedOnly": false
}
```

`version` is written for future migrations and ignored on read. The directory is
`ports_core::paths::CONFIG_DIR`, set once in `src-tauri/src/lib.rs` to
`config::dir().join("ports")`, so the file moves with the configured data
directory.

- **Missing file** — the five defaults, and nothing is written. A fresh install
  stays clean until the user saves.
- **Write** — staged as `settings.json.tmp`, `write_all`, `sync_all`, then
  renamed over the target under a process-wide `Mutex`. The temp file is removed
  on every failure.
- **Unreadable, unparseable or invalid file** — renamed to
  `settings.json.bak-<unix seconds>` and replaced by the defaults in memory, so
  a hand-edited file never wedges the page. The backup keeps the original bytes.
- **Save validation** — zero and anything above 65 535 are rejected, the rest is
  deduplicated and sorted ascending, and more than 50 entries is an error rather
  than a truncation.

The frontend mirrors the limit constants (`MAX_PINNED_PORTS = 50`,
`DEFAULT_PINNED_PORTS = [3000, 5173, 8080, 5432, 27017]`), but the backend is
authoritative: it validates on every save and on every load.

## Limits and platform notes

- **TCP listeners only.** UDP sockets are not enumerated, and only listening
  sockets are listed — the local end of outbound connections is not a row.
- **Windows only.** `scan`, `process` and `elevate` are compiled against the
  Windows APIs; on other targets they return `internal` with an English message.
  There is no macOS `lsof` path, no Linux `/proc` path and no Flatpak path.
- **PID below 1 000 is assumed to be a system process.** A user process that
  happens to hold a low PID is shown as `system` and cannot be ended from the
  page.
- **A port can look free while `netstat` still lists it.** Windows can keep a
  `LISTENING` row for a PID that has already exited; the page follows its own
  rule (no resolvable process means `free`).
- **The 3 s window.** A port that appears and disappears between polls is never
  shown, and a row the user just killed may take one interval to disappear if
  the manual refresh races the poll.
- The detail sheet's kill action is hidden for `system` rows and for rows whose
  process could not be resolved; `ports_kill` refuses the same cases anyway.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "not allowed by ACL" | The command is missing from `build.rs` or `capabilities/default.json` |
| The page shows a load error row | `ports_list` failed — read the English `message` in the dev console |
| Pinned ports vanish | A status toggle is off; the filter applies to the pinned list too |
| A pinned port shows as free | Nothing listens on it; that is the placeholder row |
| Settings reset to the defaults | `settings.json` could not be read or parsed; look for `settings.json.bak-*` |
| "At most 50 pinned ports" | The cap is 50 — remove one before adding another |
| Killing shows "access denied" twice | The elevated `taskkill` also failed; `detail.exitCode` says why |
| An info toast after confirming | The UAC prompt was dismissed; the process is still running |
| The toolbar says paused | The page is not active, the window is minimized, or the document is hidden |

## Licence

`src-tauri/ports-core` is adapted from Porter
(https://github.com/t21dev/porter-app), Copyright (c) 2025 Porter App
Contributors, MIT. The full text is in
[licenses/Porter-LICENSE.txt](../../licenses/Porter-LICENSE.txt); the porting
record is [ports-core/UPSTREAM.md](../../src-tauri/ports-core/UPSTREAM.md).
