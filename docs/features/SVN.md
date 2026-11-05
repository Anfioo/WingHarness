# SVN Workspace

The **SVN 工作副本** (SVN workspace) page is a native Subversion client. It sits
in the sidebar under **工作台** next to the Git repository page, and it is a
picker plus one window per working copy.

It is a native client rather than a bridge: it talks to the machine's `svn`
binary directly, keeps its own state under the data directory, and shares
nothing with the Git repository page.

The crate is [`src-tauri/svn-core`](../../src-tauri/svn-core), adapted from
[OrcaSVN](https://github.com/wustites/OrcaSVN) (MIT). It implements no part of
the SVN protocol — it spawns `svn`, parses the output, and caches a filesystem
snapshot so it does not have to ask again for nothing.

## Windows and routes

| Route | Renders |
| --- | --- |
| `/svn-workspace` | The picker: open and recent working copies |
| `/svn-workspace-window?path=…` | One working copy |
| `/svn-workspace-diff?path=…&target=…&old=…&new=…` | One file diff, in its own window |

Window labels are `svn-wc-` and `svn-diff-` followed by an FNV-1a 64-bit hash of
the normalised path (or of `path|target|old|new` for a diff window). Re-opening
a working copy focuses the window that is already there. Both prefixes must be
listed in [`capabilities/default.json`](../../src-tauri/capabilities/default.json)
or the window fails at runtime.

Nothing tells the picker that a window closed: it re-scans
`getAllWebviewWindows()` when it regains focus or becomes visible.

## What a working copy window does

A status list with a filter, a diff pane, and the operations that act on the
selection: update, commit (whole working copy or only the selected files),
switch, merge, cleanup, add, delete, revert, resolve, and `svn apply-patch`.
Log, diff and blame are available per file, and a local shelf stores changes —
including unversioned files — so a working copy can be put back to a known state
without committing.

## How it works

```
React page and panels (src/pages/svn-workspace, src/features/svn-workspace)
  └─ src/commands.ts wrappers
       └─ svn-core::commands       33 thin #[tauri::command] adapters
            ├─ operations.rs       update / commit / switch / merge / add / …
            ├─ status_cache.rs     in-memory status per working copy
            ├─ store.rs            recent list, JSON stores, atomic writes
            ├─ unversioned.rs      read / restore / delete unversioned files
            ├─ gitignore.rs        reads .gitignore + mtime (matching is frontend)
            └─ executor.rs         spawns svn.exe, parses with parser.rs
```

A status refresh:

```
workspace-view timer (60 s) → refreshStatusIfStale → svn_status(path, force?)
  status_cache::cached_status
    scan(root, baseline) → status_snapshot::scan
        Windows NTFS? status_usn::probe (journal) : metadata inventory
    unchanged → cached entries
    changed   → svn status --xml --depth empty -- <paths>, in chunks
                (or a full svn status --xml)
    spawn_blocking: verify() then write cache/status-<hash>.json
```

## Commands

Thirty-three commands, registered through `src-tauri/src/invoke.rs`,
`build.rs` and `capabilities/default.json`.

| Area | Commands |
| --- | --- |
| Environment | `configure_svn_executable` |
| Store and recents | `svn_workspace_recent`, `svn_workspace_remember`, `svn_workspace_forget`, `svn_store_read`, `svn_store_write`, `svn_store_remove`, `svn_stash_export` |
| Status | `svn_status` |
| Update and commit | `svn_update`, `svn_commit`, `svn_switch`, `svn_merge`, `svn_cleanup` |
| Information | `svn_info`, `svn_remote_info`, `svn_local_revision`, `svn_current_user` |
| Log, diff, blame | `svn_log`, `svn_diff`, `svn_blame` |
| Checkout | `svn_checkout` |
| Per-path edits | `svn_add`, `svn_delete`, `svn_revert`, `svn_resolve`, `svn_apply_patch` |
| Unversioned files | `delete_unversioned`, `read_unversioned_files`, `restore_unversioned_files` |
| Shell integration | `open_workspace_target`, `reveal_workspace_file`, `read_gitignore` |

Every operation that runs `svn` returns `CommandResult { success, output, error }`
rather than a typed result, because the useful diagnostic is whatever `svn`
printed. Wire types are camelCase and mirror
[`src/lib/svn-core/types.ts`](../../src/lib/svn-core/types.ts).

## Data layout

`CONFIG_DIR` is set during app setup to `<data dir>/.svn-workspace`. If setup
skips it, every command fails with "the data directory has not been
initialised".

```
<data dir>/.svn-workspace/
├── recent-workspaces.json           # path, revision, openedAt (max 20)
├── cache/
│   └── status-<fnv1a64(root)>.json  # version 6, root, inventory, entries
├── svn-settings.json                # zustand persist document
├── svn-stashes.json                 # the local shelf
└── svn-commit-draft.json            # the message being typed
```

Writes use the same atomic pattern as the other modules: a
`<name>.<nanos>.json.tmp` file renamed over the target, with the temporary
removed on failure. The status cache keeps the newest five files under a 64 MiB
budget and is only reused when the version, the root, the directory index and a
24-hour age all still check out.

## Behaviour worth knowing

**Status parsing.** `svn status --xml` is parsed as XML, not by column, so
filenames containing spaces are safe. Paths are normalised to `/` on Windows.
`normal`/`none` entries are dropped unless properties changed or a conflict is
recorded, and collapsed `deleted`/`replaced` directories are re-expanded with a
`--verbose` pass so their children reappear individually.

**Cache invalidation.** Change detection does not ask SVN. It compares a
filesystem inventory (path, logical size, mtime in nanoseconds, ctime, symlink
target) and fingerprints of the `svn` binary path, the Subversion `config` and
`servers` files (hashed, never stored raw) and the ancestor `.svn` trees. On
NTFS the USN journal supplies candidate paths. If anything structural changed —
a reparse point appears, the journal reset, admin metadata was touched — the
result is a full scan. A full scan also runs after five minutes regardless.

**Partial commit.** `svn commit --depth empty -- <files>` — an empty selection is
rejected. Before committing, status is re-read and the commit is refused when it
would either miss the children of a copied or moved directory
(`history && is_dir`), or miss the children of a `deleted`/`replaced` directory.
The refusal message says which of the two applies.

**The local shelf.** Stashing diffs each file with `svn diff`, splits the result
into hunks, rebuilds a patch, writes the shelf entry durably **before** touching
the working copy, then applies that patch in reverse and deletes the unversioned
files that are part of the entry. Restoring runs the reverse order: dry-run the
unversioned restore, apply the patch forward, then restore for real. A hunk that
does not apply leaves the entry in place ("saved but not hidden") instead of
silently losing the change. Unversioned content is stored base64, capped at 2 MiB
for the whole entry, symlinks are refused, and every path is sandboxed to the
working copy.

**gitignore.** The Rust side only reads `.gitignore` and its mtime; the matching
is done in the frontend with last-rule-wins and negation support. Filtering is
**off by default** (`gitignoreEnabled`), because an ignored file in an SVN
working copy is still a file SVN tracks.

**Credentials.** None are stored. `svn_current_user` shells `svn auth` and parses
the realm and username so the UI can show who is logged in; trust decisions
belong to Subversion itself (`servers`, `config`, the Windows credential store).
Because every call passes `--non-interactive`, an auth prompt fails the command
instead of hanging the app.

**Invocation.** `svn.exe` is configurable at runtime, verified with
`--version --quiet`, spawned with the working copy as its current directory,
`--non-interactive` always first, `kill_on_drop`, and no console window on
Windows. Output is decoded lossily as UTF-8 and merged from stdout and stderr for
the error message.

## Limits

| Limit | Value |
| --- | --- |
| One `svn` call | 120 s, then `SvnError::Timeout` |
| Status cache | 3 working copies in memory, 5 snapshot files, 64 MiB |
| Status snapshot | 500 000 nodes, 16 MiB journal replay |
| Unversioned shelf entry | 2 MiB total |
| Recent working copies | 20 |

Not implemented: `propset`/`propget`/`propedit`, lock/unlock,
copy/move/branch/tag, export/import, relocate/upgrade, changelists, any depth
other than `empty`, per-hunk discard, and cancelling a running command.

The blame parser is fixed-column — SVN pads the author field to ten characters,
and a longer author makes that line be skipped. `svn diff` of an unversioned file
is synthesised with `--- (nonexistent)` and revision 0/0.

## Wiring this module into another app

1. Add `svn-core` to `src-tauri/Cargo.toml` and expose its commands from
   `invoke.rs`.
2. List all 33 commands in `build.rs` `COMMANDS` and grant `allow-<command>`;
   without the ACL entry the call fails with "not allowed by ACL".
3. Add `svn-wc-*` and `svn-diff-*` to the capability's window list.
4. Set `svn_core::store::CONFIG_DIR` in setup.
5. The frontend needs `src/pages/svn-workspace`, `src/features/svn-workspace`,
   `src/lib/svn-core` and the `svn-windows.ts` helper that computes the labels.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "svn is not installed or not on PATH" | The binary is missing; set it with `configure_svn_executable` |
| "not allowed by ACL" on any command | Missing from `build.rs` or `capabilities/default.json` |
| "the svn workspace data directory has not been initialised" | `CONFIG_DIR` was never set during setup |
| A working-copy window will not open | `svn-wc-*` is missing from the capability window list |
| The status list is stale after an external commit | Under five minutes and the inventory did not change; force a refresh |
| The list is empty right after opening | The snapshot was restored and `svn_status` is still running or failed |
| "svn operation timed out" | The 120 s cap was reached — usually a large update over a slow link |
| Commit refuses "must include all of its children" | Partial commit of a deleted or replaced directory |
| Commit refuses "copied or moved directory" | The directory has implicit children; commit the whole copy |
| A stash was created but the changes are still there | The reverse patch failed to apply; the entry is kept |
| Restoring a stash says the path already exists | The unversioned file was recreated after the stash |
| "unversioned files exceed the 2 MB stash limit" | The entry is too large to capture |
| Ignored files are still listed | `gitignoreEnabled` is off, or the pattern differs from git's semantics |
