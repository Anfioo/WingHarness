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

On the overview that card is folded into one line while both variables point at
their fixed link, which is the state a working install is in: what the page is
opened for is the list of installed apps. The line carries an **In place** badge
and the arrows open it; it opens by itself as soon as a variable is missing or
points somewhere else, because then it is the thing to look at. Its own toggle
wins over that default for as long as the page is open.

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

Bucket clones are the exception, because they do not go through Scoop: the same
address is handed to libgit2 as a full URL — the system setting is a bare
`host:port`, so it gains `http://` — and a `socks5://` proxy works there.

## The installer

The official `install.ps1` is bundled at
`src-tauri/resources/scoop/install.ps1` (Unlicense, see
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)). It is compiled into the
binary with `include_str!`, so it is available even when the app has no network,
and it is copied to `<data dir>/scoop-page/install.ps1` on every install so a
newer app build never keeps an older copy.

Nothing downloads the installer at run time. `get.scoop.sh` is only the
upstream location the file was taken from.

### Running it elevated

The installer aborts when it sees an elevated token, with
`Running the installer as administrator is disabled by default`. That is not the
same as an administrator *account*: a normal process started from such an account
carries a filtered token and installs fine. It bites when the whole session is
elevated — UAC switched off, or WingHarness itself started as administrator.

The install screen therefore carries one switch, **Run the installer as
administrator**, off by default. It appends `-RunAsAdmin` to the PowerShell call
and changes nothing else: Scoop still installs into the folders chosen above, and
the choice is remembered with the other page preferences. Which way the run went
is also a line in the run log (`Installer runs as: …`), so the terminal shows it.

## Generated scripts

`<data dir>/scoop-page/` holds the files a run needs:

| File | Purpose |
| --- | --- |
| `install.ps1` | The bundled installer, refreshed each time |
| `install.cmd` | Creates nothing itself; runs the installer and then sets the proxy |
| `run.cmd` | One `scoop install` / `scoop search` / `scoop update` / `scoop update *` / `scoop hold` / `scoop uninstall`, or the proxy sync |
| `scoop-run.ps1` | The wrapper every Scoop call goes through |

The batch files are ASCII-only. Paths and proxy values travel through the
child's environment (`%SCOOP%`, `%SCOOP_TARGET%`, `%HTTP_PROXY%`,
`%SCOOP_PROXY_ADDRESS%`, `%SCOOP_WRAPPER%`) rather than being pasted into the
file, which keeps a non-ASCII user name or folder out of `cmd.exe`'s encoding
problems. `chcp 65001` is set for readable output.

Scoop itself is PowerShell, so a call is never pure `cmd`: what the scripts pin
is the *host*. They call `powershell.exe -File "%SCOOP_WRAPPER%" …` rather than
`%SCOOP%\shims\scoop.cmd`, because that shim chooses its own host with
`where /q pwsh.exe` — the same machine would run Scoop on whichever PowerShell
is on `PATH` — and because it drops the exit code: Scoop's `exec` is
`& $path @args`, whose status only lands in `$LASTEXITCODE`, so the shim exits
`0` even after a failure. Windows PowerShell 5.1 is always present and is
already the installer's host, so the wrapper gets both: a fixed host, and the
real status.

The wrapper formats the command's output with `Out-String -Stream` before it
exits. That is what keeps a table such as `scoop bucket list` visible: a bare
`exit` ends the process while the formatter still holds the objects.

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

No `scoop list` process is needed for the overview. The page opens from two
reads: `scoop_installed` looks at the fixed folder and answers "installed" in
milliseconds, so the badge and the tab row are right from the first frame, and
`scoop_status` — which walks every bucket, every installed manifest and the
CLI's version — replaces that guess when it lands. The loading screen is drawn
in the page's own shape (tab row, the three counters, the paths and apps cards)
rather than as one block.

No `scoop list` process is needed for the overview:

- **apps** — `apps/*/current/scoop-manifest.json` (version, description,
  homepage) plus `scoop-install.json` (bucket), read from both `scoop` and
  `scoopg`; apps from the global folder carry a global badge. `current` is a
  junction, which is followed transparently. Those are the names a current Scoop
  writes; an install made by an older one still carries `manifest.json` and
  `install.json`, so each read falls back to the bare name and both vintages show
  their version. An app whose name starts with `wingharness-` gets a
  **WingHarness plugin** badge beside it — the name is the only marker a plugin
  has (see [PLUGINS.md](./PLUGINS.md#1a-the-name-wingharness-name)).
- **buckets** — `buckets/*/bucket/*.json` under `scoop`, counted per bucket.
- **local search** — file names under the same bucket folders, with the matched
  manifest parsed for version and description. Only cloned buckets are searched,
  which is why the empty state explains it. A hit whose name carries the plugin
  prefix is badged the same way, so a plugin is recognisable before it is
  installed.
- **online search** — a normal run of `scoop search <term>`, streamed into the
  terminal.

The install input accepts `7zip`, `scoop install 7zip`, `scoop install
extras/vscode git`, and the same forms for search. Tokens are restricted to
`A-Z a-z 0-9 . - _ + / @`, because the result is expanded by `cmd.exe` and a
shell metacharacter would be an injection.

## The details sheet

A row that names something can be clicked open: a package from the overview or
from a local search hit, a bucket from its own row. The sheet comes in from the
right with what the manifest or the clone actually says, so the list keeps its
place, and it fills in when the read answers rather than holding the click.

- **A package** — `scoop_package_info` looks the name up in the cloned buckets
  first and falls back to `apps/<name>/current/scoop-manifest.json`, so a bucket
  that was updated shows what the next install would get while an app installed
  earlier still shows its own copy. It returns the version, the installed
  version, the bucket, the description, the homepage, the licence in either
  shape (`"MIT"` or `{identifier, url}`), the notes, `depends`, `suggests`, the
  commands `bin` installs, the manifest path and its raw text. **Details** shows
  the parsed form; **Manifest** shows the file untouched, which is where
  anything the parsed form does not understand still is. A package that is not
  installed gets an **Install** button in the footer.
- **A bucket** — `scoop_bucket_info` lists the `bucket/*.json` names of that
  clone and the `RepoSummary` `git-core` reads from it: remote, branch, short
  hash, committer time and the first line of the last commit. Every name in the
  list is filterable and opens its own package sheet on top, with a back button
  in the header.

The sheet keeps its own trail of one to two entries, seeded from the row that
was clicked, so a bucket and then one of its packages are one sheet rather than
two stacked dialogs. A response that lands after the sheet closed or moved on is
dropped, and the overview's `global` flag travels with the row, so a global
app's installed version is read from `scoopg`.

## Cloning a bucket

A bucket is a git clone under `<scoop>/buckets/<name>` — that folder *is* the
registration, which is why `scoop bucket add` is only a `git clone` with three
parity checks in front of it. The **Buckets** tab therefore clones the bucket
itself, through the bundled `git-core` (`git2`, with libgit2 vendored in): no
PowerShell, no `git.exe` for the user to install, and the page's proxy actually
applies. The one input line takes any of these, and the leading words are
optional:

| Input | Result |
| --- | --- |
| `extras` | `extras` cloned from `https://github.com/ScoopInstaller/Extras` — the built-in table of official buckets |
| `extras https://github.com/ScoopInstaller/Extras` | the same, from the address given |
| `https://github.com/ScoopInstaller/Extras` | the name is the repository name, lowercased |
| `scoop bucket add extras https://github.com/ScoopInstaller/Extras` | the same, read the way it is typed in a terminal |
| `extras/7zip` | `scoop install extras/7zip`, from a bucket that is already cloned |
| `scoop install extras/7zip` | the same |

A bare `owner/repo` is deliberately an install, not a clone: that is how
`scoop install` reads it, and the URL form is how a bucket is cloned without
naming it. The frontend parses the line and `scoop_add_bucket` parses it again;
both are restricted to what a bucket name and a git URL can contain.

`SCOOP`, `SCOOP_GLOBAL` and a `.cmd` script play no part in a clone, so the run
dock shows the log and its progress rather than a terminal: `scoop_add_bucket`
emits `scoop-bucket-progress` and the page logs every quarter of it, so a big
bucket does not bury the log in percentages. The bucket list is refreshed when the clone returns. The
checks Scoop makes before cloning are kept: an existing folder, or another
bucket already pointing at the same repository (compared without scheme,
trailing slash or `.git`), is refused with a message, and a clone that fails
half-way is deleted again so no empty bucket is left behind. Installing
`<bucket>/<manifest>` from a bucket that is not cloned yet is refused with a
message instead of run: Scoop would ask whether to add it, and the terminal has
no input path.

### Removing a bucket

The trash button on a bucket's row asks for confirmation and then runs
`scoop_remove_bucket`, which deletes the clone under `<scoop>/buckets/<name>`.
The name is limited to letters, digits, dots, dashes and underscores before the
recursive delete, and the result is checked to sit inside `buckets` first. Apps
installed from that bucket stay installed and stay listed, but the bucket's
manifests are gone, so a local search no longer offers new apps from it. The
confirmation says so, because that is the part that surprises.

One bucket at a time, and any bucket can go, `main` included — Scoop itself
allows that, and the page follows it.

## Updating the catalog and the apps

Two buttons cover updating, one per tab, and each is one Scoop command:

| Button | Where | Command | What it refreshes |
| --- | --- | --- | --- |
| **Update all buckets** | Buckets tab header | `scoop update` | Scoop itself and every cloned bucket |
| **Update all apps** | Overview, installed apps header | `scoop update *` | every user-scope app |
| **Update**, on a row | Overview, installed apps | `scoop update <app>` | that one app |

A bucket is a git clone under `<scoop>/buckets/<name>`, and Scoop has no
per-bucket update, so a single bucket is not offered — `scoop update` is the
command, and it takes all of them.

When the global root holds an app, the update-all run appends
`scoop update -g *` to the same script and stops before it if the user-scope
pass failed. Scoop requires an elevated window for that pass, so a run started
from an ordinary window reports its refusal in the terminal and leaves the
global apps alone. A global app's row carries `-g` too.

### Pinning a version

**Pin** on a row runs `scoop hold <app>`; **Unpin** runs `scoop unhold <app>`.
Scoop records the pin as `hold: true` in the app's own install info
(`scoop-install.json`, or `install.json` on an older install), and every later
`scoop update *` skips it — the skip is Scoop's own, so the page does not filter
anything itself. The row then shows a **Pinned** badge and its **Update** button
is disabled: Scoop refuses to update a held app, so the way through is to unpin
it first, which is one click away.

The page reads the flag from that file rather than from a `scoop` process, so
the badge is right the moment the status lands, and it flips when the hold run
exits with 0 (the run refreshes the status).

## Uninstalling an app

The trash button on an installed app's row asks for confirmation and then runs
`scoop uninstall <app>`, with `-g` for a global app. One app per run, and a
WingHarness plugin uninstalls the same way, because a plugin is an ordinary Scoop
app.

Scoop keeps the app's `<scoop>/persist/<app>` folder by default — that is where
the app's own settings live, and a reinstall finds them again. The confirmation
dialog offers **Delete the persist folder too**, which appends `-p` for a clean
removal. The choice is per run and resets every time the dialog opens, so the
destructive option is never the one left checked.

The dialog lists the persist behaviour in its body, and the run log repeats it,
so what a run does is visible before and after it starts.

`scoop uninstall scoop` would remove Scoop itself and every app with it, so
`scoop_plan_run` refuses that name outright instead of offering it as a target.

## Commands

| Command | Parameters | Returns |
| --- | --- | --- |
| `scoop_installed` | — | whether the install folder holds a Scoop, from the fixed link alone |
| `scoop_status` | — | install state, version, paths, user environment, proxy, apps, buckets |
| `scoop_search` | `query` | local hits with bucket, version, description, installed flag |
| `scoop_apply_location` | `request` | points both links and variables at the chosen folders; returns the new status |
| `scoop_prepare_install` | `request` | creates both folders and links, writes the variables, writes `install.cmd`; returns the plan |
| `scoop_plan_run` | `request` | writes `run.cmd` for install, search, a proxy sync, `scoop update`, `scoop update *`, one app's update, a hold / unhold, or an uninstall |
| `scoop_add_bucket` | `request` | clones the bucket into `<scoop>/buckets/<name>` through `git-core`, with the page's proxy; returns its name, folder and log |
| `scoop_remove_bucket` | `spec` | deletes `<scoop>/buckets/<name>`; returns its name, folder and log |
| `scoop_package_info` | `name`, `bucket`, `global` | one manifest read from the cloned bucket, or from the installed app: versions, licence, notes, depends, suggests, commands, path and raw text |
| `scoop_bucket_info` | `name` | the bucket's `bucket/*.json` names plus the clone's remote, branch, commit, committer time and last commit subject |

`local_shell_start` gained optional `command`, `cwd` and `env`; with them it runs
a line and exits instead of opening an interactive shell.

## Limits

- **Windows only.** `SCOOP` is a Windows package manager; the commands return an
  error elsewhere.
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
