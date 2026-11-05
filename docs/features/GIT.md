# Git Repository

The **Git 仓库** (Git repository) page is a complete local Git client. It sits in
the sidebar under **工作台** (Workspace) and follows the same shape as the SVN
workspace: the sidebar page is a picker, and every repository opens in **its own
window**.

The engine is [`src-tauri/git-core`](../../src-tauri/git-core), a Rust crate built on
libgit2 (`git2` 0.20, vendored). Normal operations never spawn a `git` process;
the `git` binary is only probed for diagnostics. The client is adapted from
[angkorgit](https://github.com/cheat2001/angkorgit) (MIT) — the notice travels
with the code.

## Windows and routes

| Route | Renders |
| --- | --- |
| `/git-repo` | The picker: open, clone, and the recent list |
| `/git-repo-window?path=…` | One repository, frameless, in its own window |

A repository window is labelled `git-repo-` plus the FNV-1a 64-bit hash of the
normalised path (lowercased, `\` → `/`), 16 hex characters. Opening a path that
is already open focuses the existing window instead of creating a second one —
which also means two spellings of one path (case, trailing separator) produce two
windows.

| Property | Value |
| --- | --- |
| Size | 1280 × 800, minimum 1024 × 640 |
| Frame | `decorations: false`, transparent, no shadow |
| Capability prefix | `git-repo-*` in [`capabilities/default.json`](../../src-tauri/capabilities/default.json) |
| Persisted tab state | `src/features/git/repository/tabs.ts`, debounced 300 ms |

## What is in the window

Three resizable panes:

- **Rail** — Branches, Worktrees, Remotes, Tags, Stashes and Submodules, each a
  collapsible section with a filter box. When a forge account is connected a
  pull-request section joins them. Branches can be dragged onto each other to
  merge, fast-forward or rebase.
- **Centre** — a vertical split of the commit graph, the diff view, and a
  terminal. The centre also switches between the graph, the file editor, file
  history and a single-diff view, so a file opened from the working copy does not
  leave the window.
- **Inspector** — the selected commit, stash or working-copy entry: its file
  list (list or tree), the diff, blame, and per-file actions (edit, history,
  apply a file out of a stash, open externally).

A status bar along the bottom carries the ahead/behind counts, the changed-file
count, the conflict count and the "create pull request" action.

## How the frontend reaches the engine

```
page (src/pages/git-repo/*)
  └─ Zustand stores (src/features/git/*)
       └─ typed wrappers (src/commands/services/git/index.ts)
            └─ invoke("repo_open" | "stage_file" | …)
                 └─ git-core::commands::*      [libgit2, spawn_blocking]
                      └─ JSON back to the window
```

The wrappers are one-to-one with the command names, so a missing wrapper is
visible by reading the file. Optional arguments are sent as `null` rather than
omitted.

Opening a repository:

```
repository-view.tsx → open(path)
  → repo_open { path, remember: true }
       Repository::discover → RepositoryInfo
       recent list pushed to .git-repo/recent-repositories.json
  → refresh(): repo_info, repo_status, branches, tags, stashes, remotes,
               submodules, conflicts, worktrees, unpushed commits
  → watch_repo { path } and listen("repo-changed")
```

## Commands

All commands live in `git-core/src/commands.rs` and are registered through
`src-tauri/src/invoke.rs`, `build.rs` and `capabilities/default.json`.

| Area | Commands |
| --- | --- |
| Repositories | `repo_open`, `repo_clone`, `repo_info`, `repo_status`, `repo_init`, `repo_ref_fingerprint`, `repo_ignored_paths`, `repositories_scan`, `recent_*`, `state_cleanup` |
| Branches and refs | `branch_*`, `checkout_detached`, `merge_*`, `rebase_*`, `cherry_pick*`, `revert_paths`, `reset_to` |
| History | `history_*`, `history_unpushed`, `file_history`, `repo_files`, `tree_files`, `index_files`, `file_contents`, `file_blame` |
| Staging and commit | `stage_file`, `unstage_file`, `stage_all`, `unstage_all`, `stage_hunk`, `unstage_hunk`, `stage_line`, `unstage_line`, `discard_*`, `restore_from_rev`, `commit_*` |
| Diff | `diff_*`, `staged_patch`, `patch_save` |
| Conflicts | `conflict_*` (list, read, resolve) |
| Remotes and forge | `remote_*`, `pr_checkout`, `forge_request`, `http_request` |
| Stash, tag, submodule, worktree | `stash_*`, `tag_*`, `submodule_*`, `worktree_*` |
| Accounts and keys | `account_*`, `credential_*`, `ssh_*`, `ai_key_*`, `ai_cli_detect`, `ai_cli_run` |
| Terminal and watcher | `term_create`, `term_write`, `term_resize`, `term_kill`, `watch_repo` |
| Files and editors | `read_file`, `write_file`, `delete_file`, `open_path`, `reveal_path`, `paths_exist`, `editors_detect`, `editor_open` |
| Diagnostics | `git_cli_version`, `git_engine_info`, `config_get`, `config_set` |
| Small key/value store | `git_store_read`, `git_store_write`, `git_store_remove` |

`repo_open(path, remember?)` returns a `RepositoryInfo`; `repo_clone` streams
`clone-progress` events while it runs. Errors serialise as `{ code, message }`,
with `auth`, `forbidden` and `plan_limit` derived from the HTTP status that
libgit2 reports.

## Data layout

The crate writes under `<data dir>/.git-repo` (`CONFIG_DIR`, set once during app
setup):

```
<data dir>/.git-repo/
├── recent-repositories.json     # path, name, lastOpenedAt, aiInstructions (max 1000)
├── accounts.json                # forge accounts; tokens live in the OS keyring
├── <key>.json                   # small per-feature stores, key = [a-z0-9-]{1,64}
└── ai-keys.json                 # AI provider keys for review (see below)
```

Every store apart from the recent list is written atomically: a
`<nanos>.json.tmp` file is renamed over the target and the temporary is removed
if the write fails. The recent list is a plain overwrite — a crash mid-write
loses it, and the app recovers with an empty list rather than failing to start.

Forge tokens are the one thing that does **not** land in a JSON file: they go to
the OS keyring under service `AngKorGit`, keyed `acct:{host}:{username}`. Only
`http(s)` remotes are host-mapped, and every forge request checks the host
against that allowlist before a token is attached.

## Behaviour worth knowing

**Commit graph.** Layout runs in the frontend
([`graph-layout.ts`](../../src/lib/git-core/graph-layout.ts)): each commit takes the
first free lane for its expected parent, lanes are coloured per commit OID, and
merge/close/passing markers are computed per row. History is paged at 200 commits
with `Sort::TOPOLOGICAL | Sort::TIME` across all branches, remotes, tags, `HEAD`
and stashes. Short OIDs are 8 characters; searches and the unpushed list cap at
1 000 entries each.

**Refresh is fingerprint-driven.** `watch_repo` runs one debounced watcher
(400 ms) per window over `HEAD`, the index, refs and worktree pointers, ignoring
`objects/` and `*.lock`. When it fires the window compares
`repo_ref_fingerprint`: unchanged means a status refresh only, changed means the
graph is reloaded as well. Because `objects/` is ignored, a commit made by
another tool can go unnoticed until the next index or ref write — `Ctrl+R`
forces a reload.

**Staging granularity.** A file toggle uses `stage_file` / `unstage_file`
(reset to `HEAD`). Hunk and line staging build an isolated patch and apply it to
the index, so partial staging never touches the working tree. Hunk actions are
hidden while the diff panel is showing full-file or whitespace-ignoring output,
because the hunks on screen are then not the hunks that would be applied.
`unstage_all` resets the **whole index** to `HEAD` — including anything that was
staged before the window opened.

**Conflicts.** The index conflict list is read from libgit2; resolving writes the
file, then `remove_path` + `add_path`. `has_markers` checks for `<<<<<<<` so the
UI can tell an unresolved file from a staged one.

**Blame.** `file_blame` refuses files over 5 MiB and anything containing a NUL
byte, accepts an optional revision, and marks hunks that are not committed.

**Forge providers.** GitHub, GitLab and Bitbucket are implemented behind one
`forge` trait. The request goes through `forge_request`, which injects the
keyring token after the allowlist check: Bearer plus
`application/vnd.github+json` for GitHub, `private-token` for GitLab, Basic
`base64(email:token)` for Bitbucket. That is what backs the pull-request section
and `pr_checkout`.

**AI review.** Commit messages, diff explanations and reviews can be produced by
a CLI agent (`claude`, `copilot`, `codex`, `gemini`, `opencode`, `antigravity`,
`cursor`) or by an HTTP provider (`openai`, `anthropic`, `gemini`, `ollama`,
`lmstudio`). The default CLI call is `claude -p --output-format text` with the
prompt on stdin, 240 s timeout (clamped 1–600), ANSI stripped. A review is
invalidated by a signature computed over the sorted `[path, staged, unstaged]`
list, so a stale review cannot be silently reused.

**Undo/redo and rebase.** Branch-affecting actions are recorded so the toolbar's
undo can put a branch back, but only while the branch has not moved since. An
interactive rebase plan (pick / reword / squash / fixup / drop) is compiled in the
frontend and applied by the engine.

**Signing.** Committing on a signed profile requires `user.signingKey`; a missing
key is an error rather than a silent unsigned commit, and the signer has 60 s
before the commit fails.

## Limits

| Limit | Value | Where |
| --- | --- | --- |
| Editable file | 5 MiB | `MAX_EDITABLE_BYTES` |
| Blame source | 5 MiB, no NUL bytes | `MAX_BLAME_BYTES` |
| Image diff | 10 MiB | `MAX_IMAGE_BYTES` |
| Rendered diff line | 5 000 characters | `MAX_RENDERED_LINE` |
| History page | 200 commits | `PAGE_SIZE` |
| Repository scan | depth 16, 2 000 results | `SCAN_MAX_DEPTH`, `SCAN_MAX_RESULTS` |
| Recent repositories | 1 000 | `RECENT_LIMIT` |

The scan skips `node_modules`, `target`, `vendor`, `dist`, `build`, `obj`,
`venv`, `Pods`, `Library`, `bower_components`, `__pycache__` and every
dot-directory.

**SSH remotes are not usable in this build.** `git_engine_info` reports
`ssh: false` on Windows because libgit2 was not built with vendored OpenSSL;
HTTPS remotes are the supported path until that changes.

## Wiring this module into another app

1. Register the crate in `src-tauri/Cargo.toml` and expose its commands from
   `invoke.rs`.
2. Add every command to the `COMMANDS` list in `build.rs` and grant
   `allow-<command>` in `capabilities/default.json`; add `git-repo-*` to the
   capability's window list.
3. Set `git_core::accounts::CONFIG_DIR` during setup, or every command that
   touches storage fails.
4. Add the `git-repo` route pair to the page map and the sidebar.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| The window shows the welcome view instead of a repository | `?path=` missing, or `repo_open` failed — the toast carries the reason |
| A second click opens a second window | The two paths normalise differently (case or trailing separator) |
| Changes made by another tool never appear | The watcher ignores `objects/` and `*.lock`; reload with `Ctrl+R` |
| "Unstage" removes more than expected | `unstage_all` resets the entire index to `HEAD` |
| Hunk and line actions are missing | The diff panel is in full-file or ignore-whitespace mode |
| Fetch or push fails with `auth` | No keyring entry for `acct:{host}:{username}`, or the token expired |
| A forge call fails with `forbidden` or `plan_limit` | Token scope or IP allowlist; `plan_limit` is a provider-side 402 |
| Commit says the Git identity is not configured | `user.name` / `user.email` are unset in the repository config |
| Commit fails only with signing on | `user.signingKey` missing, or the signer exceeded 60 s |
| Opening a file is refused | The file is over 5 MiB |
| The AI button is disabled | No provider configured, or no CLI agent detected |
| An AI review looks out of date | Staged or unstaged content changed — the signature no longer matches |
