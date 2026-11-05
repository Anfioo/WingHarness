# Server Manager

The **服务器管理** (Server manager) page is an SSH/SFTP client. It sits in the
sidebar under **其他** (Other): the picker lists profiles and recent connections,
and every server opens as a **tab** inside one shared window, not in a window of
its own.

The module is adapted from [XTerm](https://github.com/rockytkg/XTerm) (MIT) and
the engine is [`src-tauri/server-core`](../../src-tauri/server-core), built on
`russh` — pure Rust, no system libssh and no OpenSSL.

## Windows and routes

| Route | Renders |
| --- | --- |
| `/servers` | The picker: profiles, state, recent connections |
| `/server-window` | The manager window (label `server-manager`), any number of server tabs |

`openServerWindow(profileId)` focuses the existing window and emits
`server-open-profile` to it rather than creating another. On first creation the
profile id travels in `?profile=`; after that, tabs are opened by the event. Each
server tab carries three views — **终端** (Terminal), **XFTP** and **监控**
(Metrics) — and the terminal view has one sub-tab per shell.

Closing a tab calls `server_connection_close`; closing the window closes every
profile first and then destroys it.

## Connecting

```
SshTab.connectTab(tabId)
  → server_connect { profileId, cols, rows, trustHostKey }
       ConnectionManager::connect_shell
         per-profile connect lock
         ensure_connection: reuse a live handle, else
            host key lookup → russh connect (15 s)
            authenticate (password | private key)
            record the key if trustHostKey and it was unknown
            insert into the pool, start the metrics sampler
         open_shell: session channel → request_pty → request_shell
       → { sessionId, connectionId, reused }

reader task → emit "server:output" { sessionId, data: base64 }
xterm onData → server_write { sessionId, data: base64 }
```

**One connection per profile, many channels.** Every shell tab and the SFTP
subsystem share the profile's single SSH connection; `reused` reports whether the
connect attached to an existing one. A per-profile async lock prevents two tabs
from racing into two handshakes.

| Tuning | Value |
| --- | --- |
| Connect timeout | 15 s |
| Write timeout | 30 s |
| Disconnect timeout | 5 s |
| Keepalive | 30 s interval, three missed replies |
| PTY type | profile setting, default `xterm-256color` |
| Initial size | the xterm grid; 80 × 24 when unknown |

Authentication is a password or a private key (optionally with a passphrase) —
**no SSH agent, no keyboard-interactive, no certificates**. Host keys are trusted
on first use, recorded per **profile id** — so editing a profile's host keeps the
old fingerprint and produces a permanent mismatch until the key is forgotten.

## Files

The SFTP pane is two-sided: the local half is served by `server_local_*`
commands, the remote half by `server_sftp_*`. Transfers are queued:

```
server_transfer_start { profileId, direction, sources, targetDir, conflictPolicy }
  → prepare: stat, resolve conflicts, scan both sides
  → register + spawn worker (semaphore slot from prefs)
       create remote directories
       per file: open "<target>.part", read 32 KiB, write, checkpoint
       finalize: rename ".part" over the target
  → "server:transfer-progress" (≤10/s) … "server:transfer-done"
```

| Property | Value |
| --- | --- |
| Chunk | 32 KiB |
| Concurrency | `prefs.maxConcurrentTransfers`, 1–10, default 3 — read once, so a change needs a restart |
| Pause / cancel | atomic flag checked per chunk |
| Resume | from the `.part` file's size |
| Progress throttle | 100 ms |
| Finished rows kept | 200 |
| Remote listing cap | 5 000 entries |
| Text preview | 2 MiB |

Remote paths are normalised lexically (`//`, `.`, `..` collapsed, never above
`/`); symlinks are listed but never followed, and a recursive delete unlinks
them. Downloaded names are sanitised for Windows.

## Metrics

The monitor runs a fixed POSIX shell script on a fresh exec channel of the same
connection once a second: `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`,
`/proc/diskstats`, `/proc/loadavg`, `/proc/uptime`, `df -kP /`, `df -iP /` and
process/thread counts. History holds 300 samples; the sampler stops after three
consecutive failures and does not restart until the connection is reopened. It
starts with the connection, not when the tab is opened.

## Commands and events

| Group | Commands |
| --- | --- |
| Profiles | `server_profiles_list`, `server_profile_create`, `server_profile_update`, `server_profile_delete`, `server_profile_reorder` |
| Secrets and keys | `server_secret_set`, `server_secret_clear`, `server_host_key_get`, `server_host_key_forget`, `server_host_key_trust_pending` |
| SSH | `server_connect`, `server_write`, `server_resize`, `server_disconnect`, `server_connection_close`, `server_sessions_list`, `server_connection_state` |
| SFTP | `server_sftp_home`, `_list`, `_stat`, `_mkdir`, `_rename`, `_delete`, `_read_text`, `_write_text` |
| Local | `server_local_home`, `_list`, `_mkdir`, `_rename`, `_delete` |
| Transfers | `server_transfer_start`, `_pause`, `_resume`, `_cancel`, `_list` |
| Monitor and prefs | `server_metrics_history`, `server_prefs_get`, `server_prefs_set` |

| Event | Payload |
| --- | --- |
| `server:output` | `{ sessionId, data }`, base64 |
| `server:exit` | `{ sessionId, reason }` |
| `server:transfer-progress` | `{ transferId, profileId, transferred, total, bytesPerSec, state }` |
| `server:transfer-done` | `{ transferId, state, error }` |
| `server:metrics` | `{ profileId, sample }` |

Connection state is polled rather than emitted (the picker every 5 s, the metrics
tab every 2 s). Shell output is one event per data frame — heavy output is chatty
because nothing batches it.

## Data layout

```
<data dir>/server/
├── servers.json       # { version: 2, profiles: [...], prefs: {...} }
└── known_hosts.json   # { version: 1, records: { <profileId>: HostKeyRecord } }
```

**Passwords, passphrases and private keys are stored in clear text inside
`servers.json`.** The files are written atomically (`servers.json.tmp`,
`sync_all`, rename under a process-wide lock) and an unparseable file is moved
aside to `servers.json.bak-<unix>` and replaced with defaults, but the contents
are not encrypted, and the UI can reveal them. The OS keyring is used **only** to
read v1 secrets during the one-time migration to format v2.

Several strings in the current code still claim the opposite — the setup comment
in `lib.rs`, the route description and the `servers.subtitle` translation all say
credentials go to the system keychain. Fix or remove them when porting; do not
carry the claim into a new app.

Host keys are a per-profile trust-on-first-use record: `SHA256:<base64>` plus
algorithm, host, port and the time it was trusted.

## Limits

- **No SSH agent, no keyboard-interactive, no certificates.**
- **No chmod, chown, symlink creation or server-side copy** in the SFTP pane.
- **Linux metrics only** — the sampler reads `/proc`.
- **The transfer queue is process memory.** Rows vanish on restart; the `.part`
  files still allow an offset-based resume when the same transfer is started
  again.
- **A profile whose host changed keeps the old host key** until it is forgotten.
- `server_write` accepts 1 MiB per call; text preview is 2 MiB.

## Wiring this module into another app

1. Add `server-core` to `src-tauri/Cargo.toml` and expose the `server_*` commands
   through `invoke.rs`, `build.rs` and `capabilities/default.json`.
2. Add `server-manager` to the capability window list.
3. Set `server_core::paths::CONFIG_DIR` in setup and register `ServerState`.
4. Copy `src/pages/servers`, `src/pages/server-window` and `src/lib/servers`.
5. Add the sidebar entry — in this app the `servers` group is deliberately not in
   `GROUP_ORDER`, so the entry falls into **其他**.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `host-key-unknown` on first connect | No record yet — confirm the fingerprint and trust it |
| `host-key-mismatch` even with trust requested | The server rekeyed, or the profile's host was edited; forget the key first |
| `auth-failed` with `missing-credential` | The profile has an empty password or key |
| `auth-failed` with `remainingMethods` | Password auth is disabled on the server — use a key |
| `not-connected` mid-session | The connection dropped or a write timed out; reconnect |
| Profiles disappear after an edit | `servers.json` failed to parse and was moved to `.bak` |
| Metrics stay at "Waiting for data…" | Not a Linux host, `/proc` unreadable, or the sampler stopped after three failures |
| "The directory has too many entries to list." | More than 5 000 entries — navigate by path |
| "The remote file is not valid UTF-8." | A binary file was opened in the text editor |
| A transfer stays `pending` | Every concurrency slot is held by other transfers |
| `conflict-requires-choice` | The `ask` policy reached the backend directly |
| "not allowed by ACL" | Missing from `build.rs` or `capabilities/default.json` |
