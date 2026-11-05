# FRP Console

The **FRP 控制台** (FRP console) page manages local `frpc` clients. It sits in the
sidebar under **其他** (Other) and opens one page with five tabs: overview,
servers, tunnels, logs and runtimes. It owns the whole lifetime of `frpc`: it
generates each server's TOML config, verifies it, spawns one child process per
server, supervises that process, and streams its output back to the page.

The process manager, TOML generator, runtime discovery and log handling are
adapted from [frpilot](../../THIRD_PARTY_NOTICES.md) (MIT). This port keeps the
JSON storage model used by the other modules: no SQLite, no keyring, no
built-in downloader.

## What you need

- A reachable `frps` (FRP server).
- A local `frpc` executable. The app never downloads one; you either import a
  path or let the scan find one.

## Runtimes

A runtime is a record of one `frpc` binary: absolute path, detected version,
platform and architecture, size and (when available) SHA-256.

| Action | Behaviour |
| --- | --- |
| Import | Pick a file, probe it with `frpc --version`, and store the result. Probing happens before anything is persisted. |
| Discover | Scans `PATH`, common install directories (`Program Files`, `FRP`, package-manager roots, …) and, when requested, a shallow depth-limited walk of the home directory. Candidates already imported are marked. |
| Delete | Removes the record only — the binary on disk is left untouched. Refused while a server profile references the runtime or while it is running. |

Profiles pick a runtime in one of two ways:

- **Recommended** — uses the profile's bound runtime when it still exists,
  otherwise the newest compatible runtime for the current platform. A newer
  import can therefore change what the profile runs.
- **Pinned** — a specific runtime record. The profile fails with
  `runtime-missing` if that record disappears or its file is gone.

The same resolution is used by `frpc verify` and by the actual spawn, so a
config is never validated against a different binary than the one that runs.

## Servers (profiles)

A profile is one `frps` connection: address, port, optional token, runtime
policy, reconnect toggle and a free-form note. Every profile gets its own
`frpc` child process — starting one profile never affects another.

- Tokens are stored in plain text inside the data directory (same rule as the
  server manager), masked in the UI with a reveal toggle, and redacted from
  config previews.
- Changing anything that affects the generated config bumps the profile's
  `configRevision`. A running profile then shows **需重启** (restart required)
  until it is restarted.
- Deleting a profile stops its child first, then removes its tunnels, generated
  config, pid record and log directory.

## Tunnels

A tunnel belongs to a profile and always has a name, an enabled flag, a local
address (`localIp` + `localPort`) and a type-specific options object:

| Type | Options shape | Required fields |
| --- | --- | --- |
| `tcp`, `udp` | `port` | `remotePort` (1–65535) |
| `http`, `https` | `domain` | at least one of `customDomains` / `subdomain`; `locations` optional |
| `stcp`, `xtcp` | `secret` | `secretKey`; `role` (`server` or `visitor`); visitors also need `serverName` |

The shape must match the type — the form, the store and the TOML generator all
use the same normaliser, so a bad combination is rejected before `frpc` ever
sees it. Tunnel names are unique per profile; a duplicate is reported as a
`conflict`.

## Generated config

The structured form is the only source of truth. The TOML in
`profiles/<profileId>/frpc.toml` is a build artefact, regenerated on every
start:

1. Take a short lock, copy the profile, its tunnels and the runtime records.
2. Release the lock, render the TOML and run `frpc verify -c <path>` (20 s
   timeout).
3. Take a short lock again, confirm the profile still exists, write the final
   config and bump the revision if needed.
4. Release the lock and spawn the process.

`verify` is also exposed for the preview panel; previews and verify output are
redacted (`auth.token`, tunnel `secretKey`).

## Process supervision

One child process per profile, tracked by a process registry that is guarded by
its own locks. All events are emitted outside those locks.

| Behaviour | Value |
| --- | --- |
| Stop | Graceful terminate, killed after 5 s |
| Reconnect backoff | 1 s, 2 s, 4 s … capped at 60 s (when reconnect is enabled) |
| Circuit breaker | 5 consecutive crashes stop the profile; a run that lasts 30 s resets the counter |
| Crash window | Only exits within 15 s of spawn count as crashes |
| Latency | TCP handshake to the server, reported every 2 s |
| Health check | Restart decision every 15 s after a 45 s grace period; two consecutive failures restart the process |
| Sleep/wake | A wall-clock gap of 30 s or more triggers an immediate probe and a single-failure restart |
| Permanent failures | Auth/config errors (`login to server failed`, `authorization failed`, `token rejected`, missing file, permission denied …) stop retrying and mark the profile failed |

Frontend state arrives through three events — `frp:state` (state changes only),
`frp:metrics` (latency and tunnel states every 2 s) and `frp:log` — plus a
listed-connections poll as a fallback.

On startup the backend reaps `frpc` processes left behind by a previous run
using the pid records under `profiles/<profileId>/frpc.pid`, then deletes those
records. When the app exits, every managed child is stopped.

## Logs

Each output line is tagged with a stream (`stdout` / `stderr`), an inferred
level and a timestamp, then:

- kept in a 400-line in-memory ring buffer (per profile) for `frp_logs_recent`;
- pushed to the page over `frp:log`, where the page keeps a 2,000-line buffer
  shared by the logs tab only;
- appended to `logs/<profileId>/frpc.YYYYMMDD.log`.

Files rotate when they pass `logMaxFileSizeMb` (default 20 MB) into
`frpc.<day>.part.<stamp>.log`, and are pruned by `logRetentionDays` (default 7)
and `logMaxFilesPerProfile` (default 5). Clearing logs in the UI clears the
in-memory buffers only; files on disk stay.

## Data layout

Everything lives under the app data directory in `frp/` (the data directory is
configurable in Settings; moving it takes effect after a restart):

```
<data dir>/frp/
├── frp.json                        # profiles, tunnels, runtimes, prefs
├── frp.json.bak-<unix>             # written only when a corrupt file is replaced
├── profiles/
│   └── <profileId>/
│       ├── frpc.toml               # generated on every start
│       └── frpc.pid                # live child pid, used to reap orphans
└── logs/
    └── <profileId>/
        └── frpc.YYYYMMDD.log
```

`frp.json` is written atomically (temp file + rename). A file that cannot be
parsed is moved to `frp.json.bak-<unix>` and replaced with an empty workspace
instead of blocking the page.

Because tokens and tunnel secrets are stored in clear text, treat this
directory as sensitive — do not commit it or drop it in a synced public folder.

## Commands

All commands are prefixed `frp_` and registered in `invoke.rs`, `build.rs` and
`capabilities/default.json`.

| Group | Commands |
| --- | --- |
| Profiles | `frp_profiles_list`, `frp_profile_create`, `frp_profile_update`, `frp_profile_delete`, `frp_profile_reorder` |
| Tunnels | `frp_tunnels_list`, `frp_tunnel_create`, `frp_tunnel_update`, `frp_tunnel_delete` |
| Runtimes | `frp_runtimes_list`, `frp_runtime_probe`, `frp_runtime_import`, `frp_runtime_delete`, `frp_runtimes_discover` |
| Lifecycle | `frp_start`, `frp_stop`, `frp_restart`, `frp_start_all`, `frp_stop_all`, `frp_connections_list`, `frp_nudge_health` |
| Config | `frp_config_preview`, `frp_config_verify` |
| Logs | `frp_logs_recent`, `frp_logs_clear` |

Errors are `{ code, message, detail? }` with one of these codes: `not-found`,
`invalid-input`, `conflict`, `runtime-missing`, `runtime-in-use`,
`config-invalid`, `spawn-failed`, `not-implemented`, `internal`. The page
maps them to i18n strings and falls back to the engine message.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Start returns `runtime-missing` | No compatible runtime, or the pinned binary was moved/deleted. Re-import it on the runtimes tab. |
| Start returns `config-invalid` | `frpc verify` rejected the generated TOML; check the preview's verify output. |
| Profile turns **failed** immediately | The message matched a permanent failure (token rejected, authorization failed). Fix the token; retrying will not help. |
| Profile stops after a few retries | Five crashes within 30 s tripped the circuit breaker. Read the logs for the underlying error. |
| Runtime delete is refused | A profile references it, or a profile using it is running. |
| Tunnels show offline while the process runs | The server has not confirmed `start proxy success` yet; check the logs tab. |
