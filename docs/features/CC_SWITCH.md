# CC Switch

The **CC Switch** page manages providers for the AI coding CLIs. It sits in the
sidebar under **Agent**; the list of enabled apps, their version checks and their
config-directory overrides live in **Settings → 应用配置**.

A provider is one endpoint — a base URL, a key, a default model — and switching
means writing it into the CLI's own configuration file. Nothing here is a proxy:
after a switch the CLI talks to the provider directly, which is why the config
file, and not this app, is the source of truth at runtime.

The module reads the same SQLite schema as
[cc-switch](https://github.com/farion1231/cc-switch) (MIT) and can import from its
database. It writes inside `~/.cc-switch` only when the optional sync below is
switched on.

## Supported apps

| Id | Display name | Config written | Mode |
| --- | --- | --- | --- |
| `claude` | Claude Code | `~/.claude/settings.json` (JSON) | Floor + apply |
| `codex` | Codex | `~/.codex/config.toml` (TOML), `~/.codex/auth.json` | Floor + apply |
| `gemini` | Gemini CLI | `~/.gemini/settings.json`, `~/.gemini/.env` | Floor + apply |
| `grokbuild` | Grok Build | `~/.grok/config.toml` (TOML) | Floor + apply |
| `opencode` | OpenCode | `~/.config/opencode/opencode.jsonc` or `.json` | Additive |
| `openclaw` | OpenClaw | `~/.openclaw/openclaw.json` | Additive |
| `hermes` | Hermes | `~/.hermes/config.yaml` (YAML) | Additive |
| `pi` | Pi | `~/.pi` (no fixed file) | Advanced editor only |
| `mcode` | MiniMax Code | `~/.minimax` | Advanced editor only |

The first five are visible by default; the rest start hidden and are switched on
in Settings. A config-directory override in Settings applies to detection,
writing and the browse dialog alike.

**Floor + apply** means the switch first removes the keys that describe a
connection or credentials from the existing file — for Claude, every `env` key
prefixed `ANTHROPIC_`, `AWS_` or `VERTEX_REGION_`, the `CLAUDE_CODE_*` selectors,
and top-level `apiKeyHelper` / `apiBaseUrl` / `model` / `fallbackModel` and
friends; for Codex, `model_provider`, `openai_base_url`, `model`, the reasoning
effort keys and the whole `[model_providers.custom]` table — and then writes the
provider's values. Without that step the previous provider's token would linger
and could still be picked up by the CLI.

**Additive** apps only write their own node (`provider.<id>`,
`models.providers.<id>`) and leave everything else alone.

Writes are atomic (temporary file + rename) but **nothing is backed up**: there
is no "switch back" archive, only the next switch. If a hand edit matters, make it
in git.

## A provider

```json
{ "id": "…", "name": "work", "settingsConfig": { … }, "websiteUrl": "…",
  "category": "…", "sortIndex": 0, "notes": "…",
  "meta": { "providerType": "…", "apiKeyField": "…" }, "icon": "…", "iconColor": "…" }
```

`settingsConfig` is shaped per app:

| App | Shape |
| --- | --- |
| Claude | `{ env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL } }` |
| Codex | `{ config: "<config.toml text>", auth: { OPENAI_API_KEY } }` |
| Gemini | `{ env: { GOOGLE_GEMINI_BASE_URL, GEMINI_API_KEY, GEMINI_MODEL }, authType, model: { name } }` |
| Grok Build | `{ models: { default }, model: { <id>: { base_url, api_key } } }` |
| OpenCode / OpenClaw | `{ providerId, baseURL, apiKey, model }` |
| Hermes / Pi / MiniMax Code | free-form, advanced editor only |

The form is generated from a per-app schema (`form-schema.ts`), with a dedicated
form for Claude, one for Codex (TOML) and a generic JSON/YAML one for the rest,
so a provider that the schema cannot describe is still editable as text.

**Codex specifics.** The provider's `OPENAI_API_KEY` is written into
`[model_providers.custom].experimental_bearer_token`, because Codex no longer
reads third-party keys from `auth.json`. `auth.json` is written whole only when
the provider carries official-login state instead of a key.

## Importing

| Source | What it does |
| --- | --- |
| **Live config** | Reads the app's current config into one provider named "默认（本机配置）". Claude and Codex only |
| **cc-switch database** | Opens `~/.cc-switch/cc-switch.db` read-only (or a picked `.db`) and reads its `providers` table, which shares this schema |
| **JSON** | Accepts `{ data: { <app>: { list: [...] } } }`, a bare array, or a single object; preview marks each entry as new or update |

On first run the app seeds an empty store from the live config and adds a
`claude-official` entry once (marker file `official-seeded`).

Duplicate copies a provider with a new UUID, the name suffixed " Copy", and at
the end of the order. Editing a provider keeps its primary key, so `is_current`
and the sort position survive; editing the current provider re-applies it
immediately.

## Model lists and version checks

`ccs_fetch_models` asks the provider's base URL for its model list. The candidate
URLs are derived from the base: a `/vN` suffix yields `{base}/models` (and
`{base}/v1/models` when N is not 1), everything else yields `{base}/v1/models`,
and known Anthropic-compatible suffixes additionally try the root. An explicit
`modelsUrl` in `settingsConfig` wins. The auth header follows the
`apiFormat` — `Authorization: Bearer` by default, `x-api-key` for
`anthropic-messages`, `x-goog-api-key` for `google-generative-ai`. 15 s timeout;
404/405 falls through to the next candidate. Only Claude and Codex support this.

`ccs_get_tool_versions` runs `<command> --version` for each enabled app
concurrently with a 10 s timeout and extracts a semver from whatever it prints.
A command that runs but prints nothing parseable is reported as installed but
broken, which is a different state from "not installed".

## Data layout

```
<data dir>/ccs/
├── ccs.db                 # SQLite; providers table (id, app_type, …, is_current)
├── providers.json.migrated# former JSON store, renamed once
└── official-seeded        # one-time seed marker
```

The `providers` table matches official cc-switch field for field, which is what
makes importing from its database a straight read. App-level settings (visible
apps, config directories) are stored in the app's own `config.json` under `ccs`.

## Syncing with official cc-switch

Settings → CC Switch → Application configuration has two independent switches
that keep the current provider in step with the official cc-switch database
(`~/.cc-switch/cc-switch.db`). Both are disabled while that default database is
missing; `ccs_get_ccswitch_db` reports its path and whether it exists. Only the
default path is supported.

**Sync to CC Switch on switch** (`syncCcSwitchDb`) — every switch in this app
also flips the `is_current` flag in the official database and points
`~/.cc-switch/settings.json` at the same provider. cc-switch keeps its
device-level current provider in that file under `currentProvider<App>`
(`currentProviderClaude`, `currentProviderCodex`, …) and reads it before the
database column, so writing the column alone changes nothing it displays. The
write is skipped when the database has no provider with the same id for the app,
since flipping the flag blind would clear its current selection; a missing
`settings.json` is left alone for the same reason — cc-switch then falls back to
the column.

**Adopt the CC Switch selection on open** (`syncFromCcSwitch`) — when the
provider page opens, or the app tab changes, the app reads the official side's
current provider — the `settings.json` pointer while that id still exists in the
database, otherwise the `is_current` column — and, if it differs and this app has
a provider with the same id, switches to it and writes the CLI config file. This
direction wins over the local selection: it overwrites this app's current
provider.

Both directions are best-effort. A failed write is logged and otherwise ignored;
switching inside cc-switch reaches this app only when the second switch is on
and the page is opened again.

## Commands

| Group | Commands |
| --- | --- |
| Providers | `ccs_get_providers`, `ccs_get_current_provider`, `ccs_add_provider`, `ccs_update_provider`, `ccs_delete_provider`, `ccs_duplicate_provider`, `ccs_switch_provider`, `ccs_sync_from_ccswitch`, `ccs_update_sort_order` |
| Import | `ccs_import_live_config`, `ccs_import_preview`, `ccs_import_save`, `ccs_pick_import_file` |
| Apps and settings | `ccs_get_tool_versions`, `ccs_get_visible_apps`, `ccs_set_app_visible`, `ccs_get_settings`, `ccs_save_settings`, `ccs_get_config_dir`, `ccs_set_config_dir`, `ccs_browse_directory`, `ccs_get_resolved_dirs`, `ccs_get_ccswitch_db`, `ccs_set_sync_ccswitch_db`, `ccs_set_sync_from_ccswitch` |
| Editors and extras | `ccs_editor_base`, `ccs_editor_delta`, `ccs_fetch_models`, `ccs_get_claude_switches`, `ccs_set_skip_onboarding`, `ccs_set_plugin_integration`, `ccs_get_codex_switches`, `ccs_set_codex_session_compression` |

`ccs_switch_provider` returns the provider that was applied and the config file
that was written, which is the fastest way to see whether the override sent the
write somewhere unexpected.

## Limits

- **No backup and no rollback.** A switch overwrites the connection keys in the
  real config file.
- Providers for Hermes, Pi and MiniMax Code are free-form text; the app cannot
  validate them.
- Deleting a provider clears the node only for OpenCode and OpenClaw; the other
  additive apps need a manual edit.
- With a config-directory override the CLI may be reading a different file than
  the one that was written.
- The cc-switch sync only targets the default paths; a running cc-switch can hold
  the database write lock, and the sync is then silently skipped. It also keeps
  its settings in memory, so a switch made here reaches a running cc-switch only
  after it restarts, and its next save can overwrite the pointer.

## Wiring this module into another app

1. Add the `ccs` module (and its embedded SQLite schema) to `src-tauri` and
   expose the commands from `invoke.rs`, `build.rs` and
   `capabilities/default.json`.
2. Copy `src/pages/cc-switch`, including `app-meta.ts` and `form-schema.ts` —
   they are the single source of the app list in the frontend.
3. Add the app configuration section to Settings.
4. If the icon set from cc-switch is carried over, keep its attribution in
   `THIRD_PARTY_NOTICES`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Switching succeeds but the CLI still uses the old endpoint | The config-directory override points elsewhere; compare `ccs_get_resolved_dirs` with what the CLI reads |
| The previous provider's token is still in `settings.json` | The key is not on the floor list — only known connection keys are cleared |
| Codex authentication fails after a switch | The key went to `[model_providers.custom].experimental_bearer_token`; `model_provider` must be `custom` |
| Importing from cc-switch fails | `~/.cc-switch/cc-switch.db` is missing, or cc-switch has it locked |
| A version shows as installed but broken | The command ran but printed nothing parseable, or timed out at 10 s |
| The model list is empty | A non-Claude/Codex app, a missing or misnamed key field, or every candidate URL returned 404 |
| Deleting a provider leaves a stale node | Only OpenCode and OpenClaw nodes are cleaned automatically |
