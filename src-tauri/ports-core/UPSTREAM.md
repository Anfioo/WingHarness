# Origin: ports-core

Adapted from [Porter](https://github.com/t21dev/porter-app).

- Upstream version at import: **0.7.1**
- Upstream commit: **132578d** (2026-11-09)
- License: MIT — Copyright (c) 2025 Porter App Contributors. The full text is in
  `licenses/Porter-LICENSE.txt`.
- Imported portions: the Windows TCP listener enumeration, the port scan and
  its three states, the process lookup and termination path, the one-shot
  elevation behaviour, the DTOs, and the port list / row / detail / settings /
  stats / filter UI.

## Status

Rewritten rather than copied — no file is byte-identical to an upstream file.
The crate is first-party code maintained here. Every source file keeps a short
attribution header.

## What came from where

| This crate | Porter |
| --- | --- |
| `src/scan.rs` | `src-tauri/src/platform/windows.rs` (`GetExtendedTcpTable`), `src-tauri/src/services/port_monitor.rs` (scan, status, detail) |
| `src/process.rs` | `src-tauri/src/services/process_manager.rs` (process lookup and termination) |
| `src/elevate.rs` | `src-tauri/src/services/admin.rs` and the Windows branch of `process_manager.rs` (the elevation idea, reimplemented) |
| `src/models.rs` | `src-tauri/src/models/port.rs` |
| `src/commands.rs`, `src/store.rs`, `src/paths.rs`, `src/error.rs` | No direct counterpart; added for this app |
| `src/components/ports/*`, `src/hooks/use-ports-page.ts` | `src/components/dashboard/*` (`PortListItem`, `PortDetailModal`, `PortSettings`, `StatsCard`, `SearchBar`, `StatusFilter`, `OtherPortsList`), `src/hooks/usePorts.ts` |

## Divergences at import

- **Windows only.** Porter also carried `platform/macos.rs` (`lsof`) and
  `platform/linux.rs` (`/proc/net/tcp`) plus a Flatpak host-exec path. None were
  ported; on other targets the commands return an `internal` error.
- **Listening TCP only.** Porter's `include_connections` option (list the local
  end of every outbound connection) is gone, and the `UDP` variant of the
  `Protocol` enum with it. The page lists TCP listeners and nothing else.
- **No whole-app elevation.** Porter detected whether the app was elevated and
  offered to restart it as administrator (`is_elevated` / `request_elevation`).
  Here the app never restarts: a denied kill asks for one UAC prompt that runs
  `taskkill.exe /PID <pid> /F`, and the page carries on. `ShellExecuteExW` with
  the `runas` verb replaces the PowerShell `Start-Process` shim.
- **Kill guards.** Porter's `kill_process` accepted any PID (and
  `kill_process_by_port` resolved the PID itself). `ensure_killable` here
  refuses PID 0, this process, PIDs below 1 000, PIDs with no listening port,
  and PIDs that no longer exist, before either the plain or the elevated path.
- **Typed errors.** Porter returned `Result<_, String>`. This crate returns
  `{ code, message, detail }` with a stable kebab-case code, so the frontend
  branches on `code` instead of matching English text.
- **Settings are a file, not `localStorage`.** Porter kept the pinned list in
  the webview (`porter-pinned-ports`) and the scan options in `scanStore`. Here
  `pinnedPorts` and `pinnedOnly` live in `<data dir>/ports/settings.json`, are
  validated in Rust, written atomically and backed up when unreadable. The UI
  scale, theme, window chrome and update-check stores were not ported.
- **Deduplicated by port.** Porter could return the same port once per socket
  family/address. The list here has one ascending row per port, first row wins.
- **No shell or chrome features.** The custom title bar, theme and UI-scale
  stores, update check and release notes, the About dialog, the "not running as
  administrator" banner, the system-info footer and `get_system_info` were left
  behind; this app already has its own shell, updater and settings.
- **Pinned scan is a separate command.** Porter derived the common-port list in
  the frontend and called one scan for everything. `ports_pinned_scan` takes the
  pinned ports and fills absent ones with `free` placeholders, so the pinned
  section does not depend on the full table.

## Taking an upstream change

1. Diff the relevant Porter module against this crate.
2. Apply the change by hand on top of the local edits; keep it Windows-only and
   listener-only unless the scope is being widened deliberately.
3. `cargo test -p ports-core` (the live-table tests are `#[ignore]`d; run them
   with `--ignored` on a real Windows machine) and open the ports page.
