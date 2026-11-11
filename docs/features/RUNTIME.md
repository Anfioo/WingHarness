# Runtime Installer

Clash and FRP both run an executable the app does not ship: `mihomo.exe` for the
Clash page and `frpc.exe` for the FRP console. The **运行时** (Runtimes) section
in the Settings window can download and unpack either one, so the first-run
experience is no longer "download it yourself and drop it in the right folder".

The same card appears in three places:

| Where | What it installs |
| --- | --- |
| Settings → **运行时** | Both runtimes |
| Clash page → **运行时** tab | `clash/mihomo.exe` and its Geo databases |
| FRP page → **运行时** tab | The official `frp/frpc.exe` entry, which cannot be deleted |

## Sources

Every card offers the same three ways to install, and all three target the same
official path — this feature never creates extra frpc records:

1. **Official** — the archive URL hardcoded in
   `src/lib/runtime/official.ts`. It is a fixed build, not "the latest upstream
   release", so rebuilding the app cannot change what the feature runs.
2. **From URL** — any `http(s)` URL returning a `.7z` or `.zip` archive.
3. **From archive** — a local `.7z` or `.zip` chosen with the file picker.

Installing over an existing runtime is allowed; the files are replaced. A
running `mihomo.exe` or `frpc.exe` cannot be replaced, and the backend reports
that as a write error.

## Where the files land

```text
<data dir>/
├── clash/
│   ├── mihomo.exe        the binary the Clash engine probes and runs
│   ├── geoip.dat
│   ├── geosite.dat
│   ├── geoip.metadb
│   ├── Country.mmdb
│   └── …                 clash.json, profiles/, prism/, run/ belong to the feature
└── frp/
    ├── frpc.exe          the official runtime
    ├── README.md
    └── …                 frp.json, profiles/, logs/ belong to the feature
```

An archive that wraps everything in one top-level folder is flattened: an entry
`frp_0.61.0_windows_amd64/frpc.exe` becomes `frp/frpc.exe`. Two or more
top-level entries mean the archive really is a tree and is kept as one.

After an FRP install the extracted binary is registered through
`frp_runtime_import`, so it is usable immediately and shows up in the FRP
runtime list with its version. An installed Clash runtime needs no registration:
`prism_core::store::core_binary()` always points at `clash/mihomo.exe`.

## Pipeline

```text
fetch (frontend)
  @tauri-apps/plugin-http → plugin:http|fetch
extract (Web Worker)
  7z-wasm `7zz x archive -oout -y -bd`
write (Rust)
  runtime_write_file, one raw body per file
```

- **Why the http plugin?** `fetch` in a webview obeys CORS, and the official
  host returns no `Access-Control-Allow-Origin`. The plugin runs the request in
  Rust and streams the body back, which is the only way an arbitrary
  user-supplied URL can work. The archive is still downloaded by frontend code.
- **Why 7z-wasm?** It is the same `7-Zip 24.09` build the preview subsystem
  already bundles for archive listing; a `.7z` archive needs no new Rust
  dependency. The worker is created per install and terminated after it answers,
  because the wasm instance owns its MEMFS.
- **Why a raw body?** The largest official archive is 22 MiB and unpacks to
  ~98 MiB. Sending a `Vec<u8>` as JSON would turn that into an array of numbers.
  `runtime_write_file` reads `tauri::ipc::InvokeBody::Raw`, and the entry name
  travels inside the same buffer:
  `[kind: 1 byte][name length: u32 LE][name: UTF-8][content]`.

## Security boundaries

An archive is untrusted input. `src-tauri/src/commands/runtime.rs` refuses,
after normalising both separators:

- absolute paths, empty components, `.` and `..`;
- NULs and control characters;
- on Windows: `:`, trailing dots/spaces, and reserved device names
  (`CON`, `NUL`, `COM1` …), all of which alias a different file;
- entries whose first component is one of the feature's own files:
  `clash.json`, `subscriptions.json`, `tests.json`, `sysproxy`, `prism/`,
  `profiles/`, `run/` for Clash, and `frp.json`, `profiles/`, `logs/` for FRP.

Caps: 512 MiB for a read or downloaded archive, 256 entries, 1 GiB unpacked.
Writes go through a sibling `.tmp` file and a rename, so a failed install never
leaves a half-written executable.

## Files

| Path | Responsibility |
| --- | --- |
| `src/lib/runtime/official.ts` | The official URLs and the binary name per kind |
| `src/lib/runtime/install.ts` | Fetch with progress, worker lifecycle, sequential writes |
| `src/lib/runtime/extract.worker.ts` | 7z-wasm extraction, common-root stripping, path checks |
| `src/components/runtime/runtime-installer.tsx` | The card: status, three sources, URL dialog, progress |
| `src/windows/settings/runtime-section.tsx` | Settings section wrapping both cards |
| `src/commands/services/runtime/` | Typed wrappers for `runtime_target`, `runtime_read_archive`, `runtime_write_file` |
| `src-tauri/src/commands/runtime.rs` | The file bridge: target paths, archive read, safe atomic writes |

## Adding a runtime kind

A new kind needs four things: a variant in `RuntimeKind` in
`src-tauri/src/commands/runtime.rs` (directory, binary name, protected entries),
a URL in `OFFICIAL_RUNTIME_URLS`, a binary name in `runtimeBinaryName`, and the
two i18n titles in `src/i18n/locales/runtime/`. The card itself is generic.
