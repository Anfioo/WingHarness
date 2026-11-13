# Scoop

The **Scoop** page installs the Windows package manager of that name and then
manages what it installed: the version, the folders, the `SCOOP` /
`SCOOP_GLOBAL` environment variables, the download proxy, and the catalog of
apps and buckets.

It is one sidebar page with two states. Until an install exists on disk it shows
the install screen only. Once Scoop is installed the tabs are **概览**
(Overview), **搜索安装** (Search & install), **桶** (Buckets) and **设置**
(Settings). A run dock at the bottom shows the exact script, its step log and the
terminal it runs in.

## Folders, the links and the environment

Scoop has two roots, and each one is named by a fixed link:

```text
<default config dir>\ScoopCurrent        →  the real `scoop` folder
<default config dir>\ScoopGlobalCurrent  →  the real `scoopg` folder
```

`<default config dir>` is the directory Tauri resolved, the one that also holds
`data-dir.txt`, so the links do not move when the user changes the data
directory. `SCOOP` holds `ScoopCurrent`; `SCOOP_GLOBAL` holds
`ScoopGlobalCurrent`.

The two real folders are chosen independently, each from the same three options:

| Option | `SCOOP` (`scoop`) | `SCOOP_GLOBAL` (`scoopg`) |
| --- | --- | --- |
| Data folder (default) | `<data dir>\scoop` | `<data dir>\scoopg` |
| User folder | `%USERPROFILE%\scoop` | `%USERPROFILE%\scoopg` |
| Custom | any absolute path | any absolute path |

Each chosen folder is reached by a directory junction (`mklink /J`) from its
fixed link. Nothing needs administrator rights: junctions and user-scope
variables are both available to a normal process. Re-applying a choice replaces
that junction. A real folder that is not empty is never deleted — the command
refuses and asks the user to choose that folder instead. If a chosen folder is
literally the link path itself, no link is created for it.

The variables are written directly to `HKCU\Environment`, then a detached
PowerShell broadcasts `WM_SETTINGCHANGE` so Explorer and new consoles reload
their environment. That broadcast waits on every top-level window, so it is not
awaited: the prepare step must never be able to freeze on a hung window.
Already-running processes cannot see the variables anyway, so the app never
relies on `PATH`: every Scoop command is invoked through the absolute path
`%SCOOP%\shims\scoop.cmd`. The page says a restart is needed, and offers one,
only so other tools and new terminals pick the variables up.

All five commands are declared with `#[tauri::command(async)]`, so Tauri runs
them on its thread pool rather than on the main thread. Without that, the
PowerShell broadcast above would deadlock against a blocked UI thread and the
window would be reported as not responding.

The overview and the settings tab show the two real folders, the two links as
`link → folder`, and each variable as `link (real path …)`, so nothing looks
like the same path repeated.

## Proxy

The proxy has a page-level mode — **follow settings, direct, custom** — and
defaults to following Settings → Proxy. The resolution mirrors the backend:

| Page mode | Effective mode |
| --- | --- |
| Follow settings | the app's `none` / `system` / `custom` setting, including the address read from Windows in system mode |
| Direct | `none`, and `NO_PROXY=*` |
| Custom | `custom`, with a bare `host:port` read as `http://host:port` |

Three things carry it to Scoop, because no single mechanism covers both the
installer and later `scoop install` runs:

1. **Environment** — `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and their
   lowercase forms are set for the child process. This is what `git` uses.
2. **Installer flags** — `install.ps1` gets `-Proxy "<url>"`, `-NoProxy`, or no
   flag at all (the system proxy answers).
3. **Scoop's own config** — Scoop's `setup_proxy` reads its `proxy` setting and
   sets `[Net.WebRequest]::DefaultWebProxy`, which is what its PowerShell
   downloads use. Before every install or search the script runs
   `scoop config proxy <address>`, `scoop config proxy none`, or
   `scoop config rm proxy`.

Scoop stores the value as `[user:pass@]host:port` and prepends `http://` itself,
so `SCOOP_PROXY_ADDRESS` is the URL with its scheme removed. A `socks5://` URL is
passed through the same way, with a warning in the log: Scoop itself only
understands HTTP proxies.

## The installer

The official `install.ps1` is bundled at
`src-tauri/resources/scoop/install.ps1` (Unlicense, see
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)). It is compiled into the
binary with `include_str!`, so it is available even when the app has no network,
and it is copied to `<data dir>/scoop-page/install.ps1` on every install so a
newer app build never keeps an older copy.

Nothing downloads the installer at run time. `get.scoop.sh` is only the
upstream location the file was taken from.

## Generated scripts

`<data dir>/scoop-page/` holds the files a run needs:

| File | Purpose |
| --- | --- |
| `install.ps1` | The bundled installer, refreshed each time |
| `install.cmd` | Creates nothing itself; runs the installer and then sets the proxy |
| `run.cmd` | One `scoop install` / `scoop search` / proxy sync |

The batch files are ASCII-only. Paths and proxy values travel through the
child's environment (`%SCOOP%`, `%SCOOP_TARGET%`, `%HTTP_PROXY%`,
`%SCOOP_PROXY_ADDRESS%`) rather than being pasted into the file, which keeps a
non-ASCII user name or folder out of `cmd.exe`'s encoding problems. `chcp 65001`
is set for readable output.

`scoop.cmd` is invoked with `call`: without it a batch file transfers control
and `exit /b` inside the shim would end the script before the second command or
the exit-code line.

Each script

- echoes the proxy and both links with their real folders before doing anything;
- runs the work;
- stores `%ERRORLEVEL%`, prints it, and returns it, so the PTY's exit event
  carries the real status to the page.

The page streams the script through the existing pseudo-console
(`local_shell_start` with `command` / `cwd` / `env`), so the terminal UI is the
same xterm surface the Terminal page uses. There is exactly one run at a time:
`run.cmd` is a single file.

## Reading the catalog

No `scoop list` process is needed for the overview:

- **apps** — `apps/*/current/manifest.json` (version, description, homepage)
  plus `install.json` (bucket), read from both `scoop` and `scoopg`; apps from
  the global folder carry a global badge. `current` is a junction, which is
  followed transparently.
- **buckets** — `buckets/*/bucket/*.json` under `scoop`, counted per bucket.
- **local search** — file names under the same bucket folders, with the matched
  manifest parsed for version and description. Only cloned buckets are searched,
  which is why the empty state explains it.
- **online search** — a normal run of `scoop search <term>`, streamed into the
  terminal.

The install input accepts `7zip`, `scoop install 7zip`, `scoop install
extras/vscode git`, and the same forms for search. Tokens are restricted to
`A-Z a-z 0-9 . - _ + / @`, because the result is expanded by `cmd.exe` and a
shell metacharacter would be an injection.

## Commands

| Command | Parameters | Returns |
| --- | --- | --- |
| `scoop_status` | — | install state, version, paths, user environment, proxy, apps, buckets |
| `scoop_search` | `query` | local hits with bucket, version, description, installed flag |
| `scoop_apply_location` | `request` | points both links and variables at the chosen folders; returns the new status |
| `scoop_prepare_install` | `request` | creates both folders and links, writes the variables, writes `install.cmd`; returns the plan |
| `scoop_plan_run` | `request` | writes `run.cmd` for install, search or a proxy sync |

`local_shell_start` gained optional `command`, `cwd` and `env`; with them it runs
a line and exits instead of opening an interactive shell.

## Limits

- **Windows only.** `SCOOP` is a Windows package manager; the commands return an
  error elsewhere.
- **No uninstall, update or bucket management.** The page installs, searches and
  reports. `scoop uninstall` and `scoop update` would be easy to add as more
  `scoop_plan_run` kinds.
- **The links cannot be re-pointed after install from this page.** Changing
  `SCOOP` or `SCOOP_GLOBAL` underneath an existing install hides its apps; the
  Settings tab shows the paths read-only and says to migrate or uninstall first.
- **Local search only sees cloned buckets.** A bucket that was never cloned is
  found by **Search online**, which clones on demand.
- **One run at a time**, and no input: the scripts are non-interactive.
- **System mode uses whatever Windows reports**, including a PAC URL, which
  Scoop's HTTP proxy setting cannot honour as an address.

## Updating the bundled installer

1. Replace `src-tauri/resources/scoop/install.ps1` with the current upstream
   file, unmodified.
2. Record its new SHA-256 in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)
   and the inventory in [UPSTREAM_PROJECTS.md](../UPSTREAM_PROJECTS.md).
3. Nothing else: the Rust module embeds the file at compile time.
