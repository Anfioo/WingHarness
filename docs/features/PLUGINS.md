# Plugins

> 中文版：[PLUGINS.zh-CN.md](./PLUGINS.zh-CN.md)

A plugin is an ordinary **Scoop app** that carries a `plugin.json` at its root. Scoop owns the lifecycle — install, update, uninstall — from a bucket, and the app adds the part Scoop has no opinion about: the settings page reads the manifest, renders the configuration it asks for, and runs the script.

The app knows nothing about any particular plugin — **installing a new one requires no frontend change and no Rust change**, only a manifest in a bucket.

## 1. Package layout and the bucket

The app is the zip's contents, with `plugin.json` at the root:

```
hello-plugin.zip
├── plugin.json
├── run.cmd
└── (anything else)
```

`scoop install hello-plugin` unpacks that into `<scoop>/apps/hello-plugin/<version>/` and points `<scoop>/apps/hello-plugin/current` at it. The app only ever looks at `current`, so if the archive wraps everything in one folder, name it in the bucket manifest's `extract_dir`.

The bucket manifest holds **standard Scoop fields only** — the plugin's own metadata stays in the package, where the app reads it:

```json
{
  "version": "1.0.0",
  "description": "Hello plugin: prints the values its config files hold.",
  "homepage": "https://github.com/you/scoop-bucket",
  "url": "https://github.com/you/scoop-bucket/releases/download/hello-plugin-1.0.0/hello-plugin-1.0.0.zip",
  "hash": "sha256:…"
}
```

Two ready-to-edit manifests live in [`examples/bucket/`](../../examples/bucket/). Copy one next to the others in your bucket, point `url` at the release zip, and fill in `hash` from `scoop hash <file>` (or let `scoop checkver`/`autoupdate` maintain the manifest for you, as for any other app).

They also show the one thing a plugin's manifest usually wants beyond the standard fields: the package ships its config files as **templates**, and a `pre_install` copies them into `$persist_dir` on the first install, so the plugin's first run finds settings where the app looks for them (§6). Without it, the files sit in `current` — which the next update replaces, and which the config window never reads.

```json
"pre_install": [
  "New-Item -ItemType Directory -Force -Path $persist_dir | Out-Null",
  "$files = @('.env', 'cfg.json')",
  "foreach ($name in $files) {",
  "  $source = Join-Path $dir $name;",
  "  $target = Join-Path $persist_dir $name;",
  "  if ((Test-Path $source) -and -not (Test-Path $target)) { Copy-Item $source $target }",
  "}"
]
```

## 2. plugin.json

```jsonc
{
  "name": "Hello Plugin",           // display name; falls back to the app name
  "version": "1.0.0",               // optional, shown as a badge next to the name
  "description": "One line",        // optional
  "entry": "run.cmd",               // required; the script that starts the plugin
  "stopScript": "stop.cmd",         // optional; the script that stops it, see §5a
  "ui": "http://127.0.0.1:{PORT}/", // optional; the page this plugin serves, see §4
  "configFiles": [ /* sources, see below */ ]
}
```

> The block above is **jsonc** for the sake of comments; a real `plugin.json` must not contain any.

There is no `id`. **A plugin is named by its Scoop app**, which is also its folder name and the key the app stores its enabled flag under, so the two can never disagree. A `plugin.json` that was written for an older version and still carries an `id` is read fine — the key is ignored, not an error.

`ui` is the address of the page the plugin serves itself. A `{key}` inside it stands for the current value of that config key, so a plugin whose port is a setting can still point at its own page. Only `http://` and `https://` are accepted. Leaving `ui` out is normal: the plugin simply has no page of its own. See §4.

### Config files

A plugin ships its settings **as real files**, and declares them in `configFiles`. Each entry is one **source**: one file on disk, and one block in the config window.

| Field | Meaning |
| --- | --- |
| `type` | `env`, `json` or `yaml` — which adapter reads and writes the file |
| `path` | Relative to the app's **persist folder**, `<scoop>/persist/<app>` — not to the plugin folder, see §6. Same safety checks as `entry`, so it cannot walk out with `..` or an absolute path |
| `absolute` | Optional. `true` = `path` is used as written, for a file the plugin keeps outside its own data (never created by the app) |
| `startmust` | Boolean. `true` = a run is refused while the file is missing |
| `fields` | The keys the app may edit, in declaration order |

`fields[]` is exactly the old `config` field shape, so the render logic is unchanged:

| Field | Meaning |
| --- | --- |
| `key` | Required. **What it names depends on `type`** — see below |
| `label` | Shown above the input; falls back to `key` |
| `type` | `string` (default), `number`, `boolean`, `select` or `textarea` |
| `default` | The value used when the file holds no value yet — **this is where a plugin ships its defaults** |
| `hint` | Optional small print under the label |
| `options` | The field's choices, as `{ value, label }` objects — see below |
| `trueValue` | `boolean` with options only: which option's `value` means "on" |
| `min` / `max` | `number` only |

They render as: `string` → single-line input, `number` → number input, `boolean` → on/off button, `select` → dropdown, `textarea` → multi-line input.

#### `options` and `trueValue` — choice fields

`options` fixes a field's accepted values as a list of objects, each a `value` (what the file stores) and a `label` (what the UI shows, falling back to `value` when blank):

```json
"options": [
  { "value": "blue", "label": "蓝" },
  { "value": "green", "label": "绿" }
]
```

It is allowed on `select` and `boolean`; on any other type it would be silently ignored, so a manifest with one is rejected. A value off the list is refused on save.

**`select` — a dropdown of N choices.** This is what `options` always was; any number of entries. A `select` with no `options` is a free-text field.

**`boolean` — a two-state toggle.** With options, it takes exactly **two** (a third is refused: a two-state toggle has nowhere to render it) and a **`trueValue`** naming which one is "on" — the value must match one of the options, and without it a boolean with options is an error. The button shows the current state's `label` and fills in when it is the `trueValue` one, and stores that option's `value`; so a file that spells its states `1`/`0` keeps `1`/`0` verbatim rather than a translated bool.

```json
{
  "key": "SYSTEM_PROXY", "type": "boolean", "default": "1", "trueValue": "1",
  "options": [ { "value": "1", "label": "开启" }, { "value": "0", "label": "关闭" } ]
}
```

`trueValue` is forbidden on every other type (it means nothing there, so writing one is a typo worth catching). A `boolean` with **no** `options` is the plain on/off button and stores a real boolean in json/yaml (`true`/`false` in an `.env`).

A choice field with no `default`: a `boolean` falls to the state that is **not** `trueValue` (a toggle is always one thing or the other), while a `select` reads as unset and shows the dropdown's placeholder.

**`key` addresses:**

- `env` — a **flat key**. `WEB_PORT` matches the `WEB_PORT=` line; a dot in the name is a literal dot, not a path.
- `json` / `yaml` — a **dotted path**, `a.b.c`. An all-numeric segment is an array index: `schedule.checkin_hours.0` is the first element.

A `configFiles` entry with an empty `fields` array is legal and simply offers nothing to edit. A plugin with no `configFiles` at all has nothing to configure, and its page (if any) works as before.

#### A complete manifest

Every key in one block, so you can copy it and delete what you do not need. This declares one `env` file and one `json` file, covering all five field types, a `select`, and a `boolean` toggle:

```json
{
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "One line shown on the settings card.",
  "entry": "run.cmd",
  "stopScript": "stop.cmd",
  "ui": "http://127.0.0.1:{MY_PORT}/",
  "configFiles": [
    {
      "type": "env",
      "path": ".env",
      "startmust": true,
      "fields": [
        { "key": "MY_HOST", "label": "Listen address", "type": "string", "default": "127.0.0.1" },
        { "key": "MY_PORT", "label": "Port", "type": "number", "default": 8080, "min": 1024, "max": 65535 },
        { "key": "MY_THEME", "label": "Color scheme", "type": "select", "default": "auto",
          "options": [ { "value": "auto", "label": "Auto" },
                       { "value": "light", "label": "Light" },
                       { "value": "dark", "label": "Dark" } ] },
        { "key": "MY_PROXY", "label": "System proxy", "type": "boolean", "default": "0",
          "trueValue": "1",
          "options": [ { "value": "1", "label": "On" }, { "value": "0", "label": "Off" } ] }
      ]
    },
    {
      "type": "json",
      "path": "cfg.json",
      "fields": [
        { "key": "app.accent", "label": "Accent", "type": "select", "default": "blue",
          "options": [{ "value": "blue", "label": "Blue" }, { "value": "green", "label": "Green" }] },
        { "key": "app.note", "label": "Note", "type": "textarea", "default": "" },
        { "key": "app.retries", "label": "Retries", "type": "number", "default": 3 },
        { "key": "features.enabled", "label": "Enable feature", "type": "boolean", "default": true },
        { "key": "features.weights.0", "label": "First weight", "type": "number", "default": 100 }
      ]
    }
  ]
}
```

The same, fully commented and with a runnable script beside it, is [`examples/plugin-showcase/`](../../examples/plugin-showcase/).

## 3. Install, update, uninstall, run

The settings page drives Scoop; it does not reimplement it.

1. **Install** — press **Install plugin** and type the app's name. It must come from a bucket you have already added on the **Scoop** page. The app runs `scoop install <app>`, streams Scoop's output into the panel, and the plugin arrives **disabled**.
2. **Enable** — in Settings → Plugins, flip its "Disabled" button to "Enabled".
3. **Configure** — press the card's "Configure" button to open the config window (§4a).
4. **Run** — press the plugin's "Run", or "Run all" at the top to run every enabled plugin in turn. Output streams into the panel below.
5. **Update** — the card's **Update** button runs `scoop update <app>` and streams it the same way.
6. **Uninstall** — the bin icon runs `scoop uninstall <app>`. The plugin's **settings survive**: they live in the persist folder, which Scoop keeps (§6).

Why a name and not a file: a drag-and-dropped zip was an install step the app had to own — unpack it, check where it landed, keep a record of it. Scoop already owns all of that for every app on the machine, so a plugin is simply one that brought a `plugin.json`.

The other controls: "Open plugins folder" opens `<scoop>/apps` in File Explorer, the folder icon on a card opens that plugin's own `current` folder, and the file icon opens its run log (§5b).

A plugin whose manifest will not parse is still listed, with the reason on its card, so the failure is visible rather than the plugin silently missing.

**Copies from the old zip installer** are listed too, marked "Installed by the old zip installer". They are not migrated — Scoop never installed them, so `scoop update` and `scoop uninstall` would both fail on them. Install the app from the bucket, then press the old card's bin icon to delete the leftover folder.

## 4. The plugin page

A plugin that serves a web page can say so with `ui`, and the app embeds that page in the sidebar's **插件** section — no browser, no switching windows.

What the page does for every enabled plugin that declares a `ui`:

- **One tab per plugin.** Only enabled plugins with a `ui` get a tab, and the first is selected on opening. A plugin with no `ui` gets none, so a batch of plain scripts adds no clutter.
- **Nothing starts on its own.** Opening a tab does not launch anything: press **Start**, and the pane waits until something answers on that address before showing the page. Opening a plugin's server — and holding its port — is the user's decision, not a side effect of looking at a tab.
- **Running means the page answers** — not "the app started it". A plugin serving from an instance this app never launched (one left over from an earlier run, or started by hand) is running as far as the app is concerned, and the pane shows its live page instead of claiming it is stopped. This is why closing and reopening the app does not make a running plugin look stopped: nothing needs to be remembered, the address is simply asked. Start is never pressed over a live page either, so no second copy is launched to fail on a port already in use.
- **Keeps the page alive** once opened. Switching tabs does not reload it, so whatever is on the page survives.
- **One button starts and stops it.** The toolbar button reads **Start** while the plugin is down and **Stop** while it is up; pressing it again stops the plugin — its `stopScript` if it declares one, otherwise the process tree the app started (see §5a). Closing the app stops everything it started, so no plugin server is left holding a port.
- **Both screens read the same truth.** The settings card's Run/Stop and the pane's Start/Stop both come from the same reachability check, so starting a plugin in one place shows it as running in the other, and stopping it there is reflected back. On the settings card, "Run" streams the plugin's output into the panel below; a plugin that serves a page streams for as long as it runs, which is why that stream is *not* what decides whether the card is busy. Another card's plugin runs and stops without locking this one.

A `{key}` that no config field fills leaves the plugin with no page rather than with a broken address; its card in Settings then says which key it was.

The page is shown in a **native webview**, not an `<iframe>`. That is not a preference — it is the only thing that works. Almost every real web app sends `X-Frame-Options: DENY` and a CSP `frame-ancestors 'none'` to stop clickjacking (the reference plugin does), and a browser refuses to render such a page inside a frame at all. An iframe is also cross-origin, so the app could never read its address, and there would be no address bar or history.

So a `ui` plugin gets a webview of its own with a small browser chrome above it: **back / forward / reload / a editable address bar / open in the system browser**, plus, in a dev build, a **developer tools** button. The address follows the page — including a client-side router's route changes, which is why it stays correct inside an SPA.

The inspector is the only window into the page the app cannot see into: the page is a native view, so its cookies, local storage, session storage and IndexedDB are reachable only through the browser runtime's own *Application* panel. That button is therefore absent from a release build unless it was packaged with `BUILD_DEV=1` (`scripts/build.ps1 -DevBuild`), which is what turns on the `devtools` feature.

Two consequences worth knowing:

- The page is an OS-level view drawn over the app. It is hidden when its tab is not the selected one, and it is closed when you leave the plugin page, so it never lingers over another screen.
- Anything the plugin's page loads is its own business, as before — but the address bar only accepts addresses on the plugin's own origin, and so does the app. A plugin cannot use it to reach the app itself.

### 4a. The config window

The card carries no fields of its own. Its **Configure** button opens a dedicated window showing **one block per source**, each with the source's `type`, its `path` (relative to the persist folder), a "required at start" badge when `startmust` is set, and an "Open file" button that hands the file to the OS.

- Editing a field writes **straight into that file**. Nothing is cached in the app: the file is the truth, so an edit made in a text editor shows up on the next open, and the two never disagree.
- Only declared keys are touched. In an `.env`, comment lines, blank lines, other keys, inline ` # comments` and the file's own line endings all survive byte-for-byte.
- A file that does not exist yet shows "File not on disk yet"; saving a field **creates** it, using the declared defaults for the other keys. This is how a plugin that generates its own `.env` on first boot still has editable settings before that boot.
- Saving is automatic, a beat after the last keystroke, with a toast if it fails. A value outside a `min`/`max`, a `select` value not on the list, or a number that will not parse is refused and reported — the file is left alone.
- `json` and `yaml` are rewritten whole, so unusual original formatting (indentation, and **comments in yaml**) is not preserved. JSON has no comments, and an `.env` keeps everything.

## 5. How a script receives its configuration

**Nothing is injected.** The app sets three variables:

| Variable | Value |
| --- | --- |
| `PLUGIN_ID` | the plugin's id — its Scoop app name |
| `PLUGIN_DIR` | the plugin's `current` folder on disk |
| `PLUGIN_PERSIST` | the plugin's persist folder, `<scoop>/persist/<app>` |

Everything else is a file the script reads itself, from `%PLUGIN_PERSIST%`. That is the same file the config window edits, so what the user sees is what the script gets — no merge step, no `.runtime/config.json`, no `PLUGIN_<KEY>` variables.

Reading only `%PLUGIN_DIR%` is the trap to avoid: that folder is replaced wholesale on the next `scoop update`, so anything the user wrote into it is gone. The persist folder is the one Scoop keeps.

```bat
@echo off
rem A .cmd script has no env/JSON/yaml parser, so it reads what it needs.
rem `chcp 65001` is not optional: cmd reads the file in the console code page
rem (GBK on a Chinese Windows) while the config window writes UTF-8, and a
rem non-ASCII comment would otherwise swallow the newline after it and glue the
rem next key onto the comment. `eol=#` skips the comments.
chcp 65001 >nul
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%PLUGIN_PERSIST%\.env") do (
  if /i "%%a"=="GREETING" set "GREETING=%%b"
)
echo Greeting is %GREETING%
```

A script that wants the values in a richer form is free to parse its own `cfg.json` (Python's `json`, PowerShell's `ConvertFrom-Json`, `jq`, …). The app takes no position on how a plugin reads its files — that is the plugin's business.

The working directory is the plugin's `current` folder, so relative paths to the script's own resources just work. stdin is connected to the null device, so a script cannot block on a prompt. The exit code is shown on the settings page; a non-zero one counts as a failure in the "Run all" summary but **does not stop the plugins after it**.

Before a run, every `startmust: true` source must exist **in the persist folder**. If one is missing the run is refused with the file's name in the error: the plugin is telling the user it needs a file the user has not created. Sources with `startmust: false` are left alone — generating your own config on first boot is a normal pattern, not an error.

### 5a. Starting and stopping

Start and stop are one button everywhere, and the manifest names both halves: `entry` starts the plugin, `stopScript` stops it.

**If the plugin declares a `stopScript`, that is the whole of stopping.** The app runs it and does nothing else. It runs with the plugin's `current` folder as its working directory and `PLUGIN_ID` / `PLUGIN_DIR` / `PLUGIN_PERSIST` set, exactly like `entry`, and its output goes into the same run log. It gets 60 seconds; a script still running after that is killed, and the stop is reported as failed.

The app deliberately does **not** also kill the process tree when there is a script. The script is the plugin's own shutdown — it knows what to end, including daemons the app never started — and a second, cruder mechanism running behind its back can only cut a shutdown short.

**With no `stopScript`, the app kills the process tree it started.** That is all there is to end such a plugin with, and it covers the common case of a script that keeps everything in its own process.

Either way, what the UI shows afterwards is whether the page still answers (§4): a stop that did not work stays visible as a running plugin rather than being reported as success.

Both halves matter for a bundle like `workbuddy-manager`, whose `start-all.cmd` starts an upstream daemon next to the panel: `entry` is `start-all.cmd`, and `stopScript` is `stop-all.cmd`, which finds the panel by port and stops the upstream.

**The stop script also runs when the app did not start the plugin.** Since "running" is decided by whether the address answers, Stop has to be able to end an instance the process table knows nothing about — and the declared stop script is the only thing that can. That is exactly the "some old copy still holds port 7864" case: press Stop and the script ends it, however the plugin's own script does that (the reference one finds its panel by port — that is the plugin's choice, not something the app does). A plugin that declares no stop script can only be stopped if the app started it; otherwise Stop reports that nothing was done.

Writing a stop script that works when the app runs it:

- **Do not wait for input.** stdin is the null device, so a script ending in `pause` (as hand-written bundles often do) returns immediately instead of hanging. Keep it that way — a script that blocks on its own logic will be killed at the 60-second mark.
- Exit `0` for success. A non-zero exit is reported to the user as the stop script failing.
- It must not try to stop *this* app, and it must be safe to run twice: the app will already have killed its own child if the script finished the job first.

`Update` and `Uninstall` stop the plugin first, because Scoop is about to replace or remove the files it is running from.

Closing the app stops each running plugin the same way the Stop button does — its stop script if it has one, otherwise the process tree — with a shorter 10-second budget, so quitting does not leave a plugin's own daemons behind. Because the app is on its way out, failures there are recorded in the log and not shown.

### 5b. The run log

Every run is written to a durable log, separate from the output panel — which lives in a window and is gone once the app closes. The log records each line of the script's output tagged with the stream it came from, and the markers around it:

```
2026-09-29 18:20:31 === start run.cmd ===
2026-09-29 18:20:31 [stdout] [plugin-showcase] created generated.yml on first boot
2026-09-29 18:20:31 [stdout] [plugin-showcase] serving   : http://127.0.0.1:8123/
2026-09-29 18:20:39 [stdout] [plugin-showcase] stopped.
2026-09-29 18:21:02 === stopped ===
```

It is plain text, so it stays readable with any editor, or from a terminal, with the app neither running nor installed. Files live in `logs/plugins/` under the app config directory (see §6), one per plugin, named after its id, rotated at 4 MB and keeping five archives (`<id>.log`, `<id>.1.log`, …).

Each card in Settings has an **Open run log** button (the file icon) that highlights the file in its folder, and the plugin page's toolbar has the same button. The file is created on demand, so the button always opens something.

## 6. Where the files live

Three folders, each owned by whoever needs it:

```
<scoop>/apps/<app>/<version>/     the plugin's own files, unpacked by Scoop
<scoop>/apps/<app>/current/       a junction to the installed version, replaced on update
<scoop>/persist/<app>/            the plugin's settings — kept by update and uninstall
```

`current` is the folder the app runs and reads `plugin.json` from. It does not survive an update, which is why **the config files the user edits live in the persist folder**: `configFiles[].path` is resolved against `<scoop>/persist/<app>`, and `PLUGIN_PERSIST` points a script at the same place. An `absolute` source is the exception — it is used as written, and it belongs to whichever program owns that path.

Scoop's own `scoop uninstall` keeps the persist folder, so reinstalling the same app brings the user's settings back. Nothing in the app has to remember them, and there is nothing to drift.

In the app config directory (`%APPDATA%\com.anfioo.mabangprojectsworkflows\`), next to `config.json`:

```
plugins.json        the enabled flag of each installed plugin
logs/plugins/       one durable run log per plugin, see §5b
plugins/            leftover folders from the old zip installer, listed until removed
```

`plugins.json` holds **only whether each plugin is on**. It stores no configuration values and no install record: what is installed is whatever `scoop list` would say, so uninstalling from Scoop itself simply makes the card disappear.

## 7. Security

**A plugin script is arbitrary code running as you, with no sandbox.** It can read and write your files, reach the network, and run any command. Therefore:

- Plugins install **disabled**; nothing is executed until you enable one.
- Only install apps from buckets you trust. The bucket manifest is code too: Scoop runs its `install`/`post_install` steps, and its `url`/`hash` decide what gets unpacked.
- A plugin is plain text — read `plugin.json` and `run.cmd` in the installed folder before enabling it.
- The config window only ever writes the **declared** `configFiles` paths, each resolved and checked to stay inside the persist folder, and only the keys the manifest declares within them. The one way out is an `absolute` source the plugin itself declared.

A plugin's page (§4) is still arbitrary web content, now rendered by a real webview rather than a sandboxed frame. It is confined to its own origin — neither the plugin's page nor the address bar can reach the app's own address — and the app's commands are not reachable from it. But a page a plugin serves is only as trustworthy as the plugin.

## 8. Examples

Both live under [`examples/`](../../examples/) in this repo, with their own `plugin.json`, scripts and config files, plus a bucket manifest for each in [`examples/bucket/`](../../examples/bucket/).

### Full showcase: `examples/plugin-showcase/`

The **complete** reference: one manifest exercising every capability at once. Read it top to bottom when writing your own.

- **Three formats** — `env`, plus `json` and `yaml`.
- **All five field types** — `string`, `number` (with `min`/`max`), `boolean`, `select` and `textarea`.
- **A dropdown and a toggle** — a `select` with three choices, and a `boolean` with `options` + `trueValue` (its two states spelled `1`/`0`) beside a plain on/off `boolean`, so the difference is visible side by side.
- **Dotted and array-index keys** — `app.name`, `features.weights.0`.
- **Both `startmust` values** — three required files and one (`generated.yml`) the script creates on first boot.
- **A `ui` with placeholders** — `http://{SHOWCASE_HOST}:{SHOWCASE_PORT}/`.

Its page renders every file back, so a change in the config window is visible on reload. It is served by `server.ps1` (PowerShell 5.1, no dependencies) which reads the same files the config window writes, from the persist folder.

### Minimal: `examples/hello-plugin/`

[`examples/hello-plugin/`](../../examples/hello-plugin/) is a minimal working plugin. It declares two sources — an `.env` for its scalar settings and a `cfg.json` for a free-text note — and prints what it finds.

To try either one:

1. Copy its bucket manifest into a bucket on the Scoop page, and point `url` at a zip of the folder (with `plugin.json` at the zip's root) — or install the app straight from a local source.
2. Press **Install plugin** on the Plugins page and type the app name.
3. Press "Configure" and change the fields. Watch the file in `<scoop>/persist/<app>` change on disk — comments intact.
4. Press "Run" (or open the plugin's tab) to see what the script read back.

Both scripts fall back to their own folder when `PLUGIN_PERSIST` is unset, so they can also be run by hand outside the app.

## 9. Troubleshooting

**"…is installed, but it is not a plugin: …"**
The app installed, but its `current` folder has no readable `plugin.json` at the root. Either the zip wraps everything in one folder (set `extract_dir` in the bucket manifest) or the manifest is invalid — the rest of the message says which.

**"'xxx' is already installed."**
The app is already there. Press **Update** on its card instead; to reinstall from scratch, uninstall it first.

**"scoop install xxx exited with code 1."**
Scoop's own message is in the output panel right above it — usually an unknown app (no bucket provides it, or the bucket list is stale: refresh it on the Scoop page), a download failure, or a hash mismatch.

**"scoop … stopped responding and was killed."**
Scoop printed nothing for five minutes. Something is waiting on input it will never get, or on a hung download; run it once from a terminal to see where it stops.

**A card says the manifest could not be read**
`plugin.json` is missing, is not valid JSON, its `entry` is an absolute path or contains `..`, or a `configFiles` entry has a `path` like that. The parenthesised part is the specific reason. Fix the app, publish a new version, and update it.

**"declares options, but its type is 'xxx'"**
`options` was put on a field whose type is not `boolean` or `select`. Move the choices to a `select`, or drop `options` and render by `type`.

**"is a boolean with options, so it must set trueValue…"** / **"trueValue '…' is not one of its option values"**
A `boolean` with `options` needs `trueValue` naming which option means "on". Add it, and make sure its value matches one of the options. A `boolean` with options but no `trueValue` is rejected, as is a `trueValue` that matches nothing.

**"declares trueValue, but only a boolean with options uses it"**
`trueValue` was put on a `select`, a plain `boolean` with no options, or a non-choice field. It only means something on a `boolean` that has `options`; remove it elsewhere.

**Nothing happens, or it fails immediately**
Read the output panel. "Entry script not found" means the `entry` path is wrong. An `echo %PLUGIN_DIR%` in the script confirms the working directory.

**"Missing config: xxx does not exist"**
A source declared `startmust: true` has no file **in the persist folder**. Saving any of its fields in the config window creates it, or set `startmust` to `false` if the plugin is meant to generate it on first boot.

**The settings vanished after an update**
The plugin is reading or writing its config from `%PLUGIN_DIR%` instead of `%PLUGIN_PERSIST%`. `current` is replaced on every update; the persist folder is the one that survives.

**Stop reports "Stop script not found: …"**
`stopScript` names a file the app does not contain. The plugin is still stopped — the process tree is killed either way — but fix the path or drop the key.

**Stop reports "Stop script '…' timed out"**
The script ran longer than 60 seconds. It was killed and the process tree was killed with it. Usually the script is waiting for input it will never get (see §5a), or waiting on a process that is not shutting down.

**Stop reports "Stop script '…' exited with code N"**
The script ran and failed. Its own output is in the run log right above the error, which is normally where the reason is.

**A card says "Installed by the old zip installer"**
That copy predates the move to Scoop and cannot be updated or uninstalled through it. Install the app from your bucket, then press the old card's bin icon to remove the leftover folder.

**Uninstalling left a folder behind**
`<scoop>/persist/<app>` is kept on purpose: it holds the user's settings, so reinstalling the same app brings them back. Delete the folder by hand to start clean.

**A plugin has no tab on the 插件 page**
A plugin gets a tab only when it is **enabled** and its manifest declares a `ui`. Check both; if the address contains a `{key}`, the Settings card says so when no field fills it.

**The 插件 page keeps waiting for a page that never answers**
The script started but nothing is listening on the declared address — usually a port the plugin failed to bind, or a server that only prints its URL without serving. Press the plugin's "Run" in Settings to see the script's own output, which names the reason.

**The config window shows a stale value**
Close and reopen it. The window reads the files once when it opens; an edit made in another editor afterwards is picked up on the next open.

**A yaml file lost its comments**
By design in this version. The yaml adapter re-serializes the document, and comment-preserving yaml needs a much larger parser. If the comments matter, keep them in an `.env` (which is preserved byte-for-byte) or in a file the config window does not touch.

**Mojibake output**
The console code page is GBK by default. Add `chcp 65001 >nul` at the top of the script to switch to UTF-8.

**A `.env` key after a Chinese comment is missing from a `.cmd`'s output**
Same root cause: cmd reads the file in the GBK code page while the config window writes UTF-8, so a non-ASCII comment line decodes to bytes that swallow the following newline and glue the next key onto the comment — where `eol=#` then skips it. `chcp 65001 >nul` before the `for /f` fixes it. See the snippet in §5.

**Works under `tauri dev`, flashes a black window when packaged**
Plugin scripts go through the same "create no console window" path as the app's other shells and should not flash. If one does, check whether the script itself `start`s another console program.
