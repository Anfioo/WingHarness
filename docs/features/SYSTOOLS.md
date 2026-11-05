# System Tools

The **系统工具** (System tools) page is a Windows maintenance console: startup
entries, application uninstall and leftovers, reversible system settings, disk
analysis, duplicate files and large files. It sits in the sidebar under
**工作台**, and it can detach into its own window at `/systools-window?tab=…`.

The module is adapted from [MangoDisk](https://github.com/harry0703/MangoDisk)
(GPL-3.0-only) and is the reason this project is GPL-3.0 rather than MIT. The
engine is [`src-tauri/systools-core`](../../src-tauri/systools-core).

## The six tabs

| Key | English | 中文 |
| --- | --- | --- |
| `startup` | Startup | 启动项 |
| `uninstall` | Uninstall | 卸载与残留 |
| `optimize` | Optimize | 系统优化 |
| `analysis` | Analysis | 磁盘分析 |
| `duplicates` | Duplicates | 重复文件 |
| `largeFiles` | Large files | 大文件 |

All six panels stay mounted while hidden, so a scan survives a tab switch. There
is only ever one window: opening the page again focuses the existing window and
sends it `systools-select-tab`.

## Architecture

```
page tabs (src/pages/systools/tabs/*)
  └─ src/lib/systools/* + src/commands/services/systools (DTOs, path helpers, errors)
       └─ invoke("systools_*")
            └─ systools-core/src/commands.rs      thin façade
                 ├─ storage/analysis, duplicates, large_files, index
                 ├─ applications/uninstall, leftovers
                 ├─ startup, system_settings
                 ├─ filesystem (permanent delete, exclusions)
                 └─ platform/  ── trait Platform ── WindowsPlatform (only impl)
```

`platform/contracts` defines a `Platform` trait of about thirty methods, each with
a safe default: an unimplemented fast path returns `None` and the traversal falls
back to a portable bounded walk. So porting to another OS means writing one
adapter; today only `WindowsPlatform` exists, and the Windows-only fast paths are
the MFT-based analysis records, the large-file candidate query and directory
entry identities.

Scanning a directory:

```
systools_analysis_scan { path, refresh, excludedPaths, excludedNames, scanMode }
  → resolve_exclusion_paths   (≤50, absolute, no links)
  → traversal (parallel walk, or the Windows fast path)
       Platform::should_skip / is_link_like / file_space_usage
       storage::index cache (in memory, 2 roots)
  → events "systools:analysis-progress"
  → AnalysisResult { root, totalBytes, entries[≤500], directoryHierarchy, coverage }
```

## Commands

| Group | Commands |
| --- | --- |
| Analysis | `systools_analysis_scan`, `_cancel`, `_remainder_list`, `_remainder_release`, `_export`, `_delete_entries` |
| Duplicates | `systools_duplicates_scan`, `_cancel`, `_page`, `_delete` |
| Large files | `systools_large_files_scan`, `_filter`, `_cancel`, `_delete` |
| Optimize | `systools_system_settings_scan`, `_cancel_scan`, `_prepare_change`, `_execute_change` |
| Startup | `systools_startup_scan`, `_cancel_scan`, `_prepare_change`, `_execute_change`, `_cancel_change` |
| Uninstall and leftovers | `systools_uninstall_scan`, `_cancel_scan`, `_describe_identity`, `_close_applications`, `_prepare_batch`, `_execute_batch`, `_cancel_execution`, `_remove_record`, `_open_windows_apps`, `systools_leftovers_scan`, `_execute`, `_cancel` |
| Shared | `systools_volumes_list`, `_system_disk`, `_filter_directory_paths`, `_reveal_in_file_manager`, `_open_*_entry`, `_file_icons`, `_application_icons` |
| Preferences | `systools_prefs_get`, `systools_prefs_set` |

**Every mutation is a plan.** `scan` observes, `prepare_change` compiles a plan
with an expiry and a per-item skip list, `execute_change` applies it by plan id.
A startup plan expires after five minutes, and an item that changed since the scan
is skipped rather than forced through.

## Elevation

Operations that need administrator rights — machine-scope settings, services,
scheduled tasks, machine-wide uninstall, registration removal — are performed by
the same executable relaunched elevated with
`--systools-elevation-helper` (or `--systools-startup-helper`,
`--systools-system-settings-helper`, `--systools-application-record-helper`).
Those flags are handled before Tauri initialises, so the helper never opens a
window.

The helper speaks newline-framed JSON over a loopback broker, protocol id
`systools-elevation-v1`, 64 KiB maximum message. Requests carry a file path plus a
digest — never a command line — so an elevated process cannot be talked into
running something the unelevated side did not ask for.

## Data layout

```
<data dir>/systools/
├── prefs.json                    # excludedPaths, excludedNames
├── uninstall-history.json        # last 200 executions
├── leftover-history.json         # last 200
├── leftover-observations.json    # last 400
└── system-settings-recovery.json # recovery ledger, ≤1024 items, ≤1 MiB
```

Scan caches are **in memory only** — the analysis index (two roots, LRU) and the
duplicate hash cache (500 000 entries) both die with the process. `prefs.json` is
written atomically; an unparseable `system-settings-recovery.json` is moved to
`.invalid.json` and a fresh ledger starts.

**There is no recycle bin.** Deletions go through `permanent_delete` and free the
bytes immediately. The guards are the preflight checks, the plan preview and the
confirm dialog — nothing else.

## Behaviour worth knowing

**Traversal.** Exclusions are absolute paths, at most 50, canonicalised with links
refused, so a rule that points at a missing folder keeps its resolved parent and
survives a disconnected volume. `should_skip` always skips `System Volume
Information`, `$Recycle.Bin`, `Recovery`, `$WinReAgent` and
`Windows\{WinSxS,Installer,System32}`; the large-file and duplicate scans also skip
`Windows`, `Program Files*`, `ProgramData` and the usual upgrade leftovers.
Page and hibernation files are marked system-critical and cannot be deleted from
here. Reparse points and cloud placeholders (`OFFLINE`, `RECALL_ON_OPEN`,
`RECALL_ON_DATA_ACCESS`) are never walked or opened.

**Two ways to measure.** `Standard` mode reports **allocated** bytes — real disk
usage, with hard links reconciled and sparse/compressed files counted by
allocation. `Fast` mode reports **logical** size from metadata and is much
cheaper. Read-only analysis deliberately does not skip protected system folders,
so its totals are larger than the cleanup tabs' totals; the two are not
comparable, which is why coverage is reported as explicit omission buckets
(permission denied, read errors, excluded, link or mount, other).

**Duplicates.** Enumerate → group by exact size → hash a 16 KiB sample from head,
middle and tail (blake3) → full hash only where samples collided → group. Physical
aliases are removed using directory identity hints, so hard links do not appear as
duplicates. Results are paged at 40.

**Large files.** Candidates start at 50 MiB; the caller may raise the floor.
Results cap at 2 000 across at most eight live sessions, and re-thresholding an
existing scan does not walk the disk again.

**Optimize.** The catalogue is compiled in — six categories (performance,
productivity, privacy, storage, gaming, appearance) with a recommended / optimized
/ unavailable state and a standard / caution / high risk label. Setting ids are
opaque (`windows.*`) and map to a private registry identity; nothing here takes a
registry path from the user. Before the first change the ledger records the
original and optimized values, and a restore is only offered while the live value
still matches the ledger.

**Startup.** Seven sources: per-user Run, per-user startup folder, common startup
folder, scheduled tasks, services, packaged startup tasks, and an advanced
autoruns pass. Every item carries a capability — toggleable, elevation required,
remove only, system managed, policy managed, or view only — and changes are queued
in the UI, compiled into a plan, applied, then re-read to report a verified state.

**Applications and leftovers.** The inventory merges registry, MSI, Appx, winget,
Steam, Scoop and Chocolatey registrations. Uninstalling supports silent,
interactive and external-client execution, a dry run, and records history. The
leftover scan looks at the uninstall registry hives (including WOW64), orphaned
registry groups and the usual data roots, bounded to 500 candidates, 20 s and
200 000 measured entries.

**Delete safeguards.** Volume roots, drive roots, the Windows directory, Program
Files and shell folders are refused as cleanup roots; system-managed files and
anything behind a link are refused as targets.

## Limits

- **Windows only.** The `Platform` trait is the seam, but no other adapter exists.
- **UAC is required** for machine-scope changes, and the helper is a full relaunch.
- **Deletions are irreversible.**
- **No scan cache on disk** — every launch rescans.
- Analysis totals include system directories that the cleanup tabs skip.

## Wiring this module into another app

1. Add `systools-core` to `src-tauri/Cargo.toml` and expose `systools_*` through
   `invoke.rs`, `build.rs` and `capabilities/default.json`.
2. Add `systools` to the capability window list and call
   `systools_core::helper::run_from_args` before Tauri initialises.
3. Set `systools_core::paths::CONFIG_DIR` in setup.
4. Copy `src/pages/systools` and `src/lib/systools`.
5. Keep the GPL-3.0 notice and the 10 byte-identical files' attribution.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "not allowed by ACL" on any `systools_*` call | Missing from `build.rs` or `capabilities/default.json` |
| A second window never appears | By design — the one window is reused and told which tab to show |
| The window always opens on 启动项 | `?tab=` is missing or not one of the six keys |
| A startup toggle is silently skipped | The plan skipped it: elevation required, catalogue expired (5 min), or the item changed |
| Optimize says the change cannot be restored | The ledger is missing or the live value no longer matches the original |
| Analysis totals dwarf Explorer's | `Standard` mode counts allocated bytes and includes protected system folders |
| A scan hangs on a cloud folder | A placeholder attribute or reparse point was not short-circuited |
| "persistenceFailed" when saving preferences | The data directory is not writable |
| Duplicate scans are slow every launch | The hash cache is in memory only |
| Delete refuses with "Windows manages this file" | A page or hibernation file was selected |
