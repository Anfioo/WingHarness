# AI Config Sync

The **AI 配置同步** (AI config sync) page keeps one git repository as the source
of truth for skills, rules, commands, subagents and MCP server definitions, and
translates that store into the layout each AI coding agent expects. It sits in
the sidebar under **Agent**.

The project scope works on the project chosen at the top of the page: the picker
lists the projects that have been opened, and every agent's project files are
read and written in the one it names.

Editing is done once, in the store. Each agent then gets a *plan* — the files
that would be written and deleted — which is shown before anything is written.
The reverse direction exists too: an agent's local files can be pulled back into
the store.

The engine is [`src-tauri/shaic-core`](../../src-tauri/shaic-core), vendored from
[shaic](https://github.com/dariocurr/shaic) v0.3.0 (MIT; see the crate's
`UPSTREAM.md`). The upstream TUI is replaced by a Tauri command layer and this
page; the store, adapters and materialiser are upstream logic.

## The store

```
~/.shaic/store/                 # a git repository; requires .git
├── .shaic-store.toml           # schema_version = 1
├── skills/<name>/SKILL.md
├── rules/<name>.md
├── commands/<name>.md
├── subagents/<name>.md
└── mcp/<name>.toml
```

Every item is YAML frontmatter plus a body:

```yaml
---
name: fix-lint
description: …
applies_to: …
tags: []
scope: []
agents: []
tools: []
native: {}
---
```

Machine-local state sits outside the store and is never synced:

```
<config dir>/shaic/config.toml          # remote, enabled_agents, projects
~/.shaic/state/<agent>-<scope>.toml     # per-agent manifest: path → whole:<sha> | region:<sha>
```

The manifest is how the page knows what it wrote last time. A file is only ever
deleted when its content still matches the digest recorded there, which is what
makes a manual edit safe: the page will stop managing the file rather than
overwrite the edit.

## Which agents, and where things go

| Id | Display name | Scopes | What it writes |
| --- | --- | --- | --- |
| `claude-code` | Claude Code | global, project | `skills/`, `commands/`, `CLAUDE.md`, `agents/` under `~/.claude` or `<project>/.claude` |
| `cursor` | Cursor | project | `.cursor/rules/<n>.mdc` (or `.cursorrules`), `.cursor/agents/<n>.md` |
| `windsurf` | Windsurf | project | `.windsurf/rules/<n>.md` (or `.windsurfrules`), `.windsurf/workflows/` |
| `copilot` | GitHub Copilot | project | `.github/copilot-instructions.md`, `instructions/`, `prompts/` |
| `codex` | OpenAI Codex CLI | global, project | `skills/` under `~/.codex` or `.codex`, `AGENTS.md`, `.codex/agents/*.toml` |
| `opencode` | OpenCode | global, project | `~/.config/opencode`, `AGENTS.md` |
| `gemini` | Google Gemini CLI | global, project | `GEMINI.md` |
| `cline` | Cline | project | `.clinerules/` or `.clinerules` |
| `antigravity` | Google Antigravity | project | discover only — experimental, read-only |

MCP targets exist for Claude (`.mcp.json`, `~/.claude.json`), Cursor
(`.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), Copilot
(`.vscode/mcp.json`), Codex (`.codex/config.toml` `[mcp_servers]`) and OpenCode
(`opencode.json`). Gemini, Cline and Antigravity have none.

An adapter declares its id, display name, supported scopes and kinds, a
`root(scope, project_root)` that returns `None` when the agent has no location in
that scope (never a guessed path), a renderer, a discovery function, and — for
single-file agents — a managed region.

**Single-file targets are spliced, not replaced.** Content is written between
`<!-- shaic:begin -->` and `<!-- shaic:end -->` markers, and any marker mentioned
in the content itself is escaped, so the splicing stays reversible. That is how a
`CLAUDE.md` or `AGENTS.md` that the user also edits by hand keeps its other
sections.

## Drift, plan, apply

```
page → shaic_dashboard()        one row per agent, worst state across scopes
     → shaic_agent_detail(a)    per scope, per axis (content, MCP)
     → shaic_plan(a, scope, mcp?)   read-only: writes, deletes, warnings
     → shaic_apply(a, scope, mcp?)  performs it
```

Status is computed by building the plan and looking at it:

| Status | Meaning |
| --- | --- |
| `in-sync` | The plan is empty — what is on disk is what would be written |
| `drift` | The plan has work to do |
| `unconfirmed` | The agent cannot be inspected (read-only or experimental adapters) |
| `error` | Building the plan failed |

The row shows the worst of its axes: `error` > `drift` > `unconfirmed` >
`in-sync`. An agent switched off in Settings produces no row at all.

Applying writes first and deletes only afterwards; a failed write leaves the
deletes unexecuted. Every write revalidates its path immediately before the
rename, and the manifest is saved even after a partial failure so the next run
knows what exists. There are no `.bak` files — the store and the agent's own
version control are the recovery plan.

## Pulling an agent back

`shaic_import_scope(agent, scope)` reads the agent's files, parses them into
canonical items and saves them to the store. It preserves `description`, `tags`,
`applies_to` and `agents` when the on-disk format cannot carry them, skips items
that are identical, and refuses to overwrite an existing subagent (the UI never
asks for a forced overwrite). Import does **not** then write back to the agents —
a plan and an Apply are separate steps.

`shaic_pull` and `shaic_push` are the git side: pull is fast-forward only and
refuses on a dirty store, push fetches and merges fast-forward before pushing, and
neither of them touches agent files.

## Security

- **Path guard.** No `..`, no absolute override, no symlink in the middle, and a
  re-check before every directory creation and rename.
- **Secret scan.** A regex tripwire for AWS/GitHub/OpenAI/Stripe/Google/Slack
  keys, JWTs, private-key headers, credential-bearing URLs and generic
  `secret|token|password` assignments runs on item save, on MCP save, on the
  staged push diff and on the outgoing commit range. A hit blocks the operation
  until it is explicitly overridden.
- **Frontmatter limits.** 64 KiB maximum, and YAML anchors, aliases and merge
  keys are rejected before parsing.
- **Secrets are references.** An MCP `EnvValue::Secret` holds no value; the value
  lives in the OS keychain under service `shaic-mcp`.
- **Git is invoked defensively.** `env_clear`, `GIT_TERMINAL_PROMPT=0`,
  `BatchMode=yes`, and remote URLs limited to https/ssh/git/file/local paths with
  no embedded credentials.

## Commands

| Group | Commands |
| --- | --- |
| Store | `shaic_status`, `shaic_init`, `shaic_push`, `shaic_pull` |
| Inspection | `shaic_dashboard`, `shaic_agent_detail` |
| Materialise | `shaic_plan`, `shaic_apply`, `shaic_import_scope` |
| Items | `shaic_list_items`, `shaic_item_template`, `shaic_item_source`, `shaic_save_item`, `shaic_remove_item` |

`shaic_remove_item` is the only item command that fans out to agents
immediately; everything else waits for a plan and an Apply.

The inspection, materialise and remove commands take an optional `root`: the
page passes the project its picker selected, so the project scope reads and
writes that project's files. With no root the crate falls back to inferring one
from the working directory, which is only what non-page callers get.

## Limits

- Antigravity is discover-only. Gemini only takes rules. Codex global rules are
  best-effort. Cursor, Windsurf and Cline do not cover every kind.
- Several agents are project-scope only, so their global row does not exist.
- There is no MCP editing UI or command — MCP appears as a planned axis and in
  the store, not as an editable form.
- Item names are single path components; renaming means delete and re-add.
- Two items can render to the same path (skill/rule collapse, Cursor agent
  shadowing); the first wins deterministically with a warning.
- The project scope is the project the page's picker selects; every project is
  inspected through the same store.
- `git` must be on `PATH`.

## Wiring this module into another app

1. Add `shaic-core` to `src-tauri/Cargo.toml`, keep its `UPSTREAM.md`, and expose
   the commands through `invoke.rs`, `build.rs` and `capabilities/default.json`.
2. Copy `src/pages/ai-config` and the `shaic` command wrappers.
3. Add the `aiConfig.enabledAgents` setting (absent means all agents enabled).
4. Pass the project scope's root to the commands from whatever "the current
   working copy" means in the new app; the crate falls back to inferring it when
   the argument is absent.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| The page shows the setup wizard | `~/.shaic/store` has no `.git`; initialise it |
| "no remote configured" | The store was initialised without a remote |
| "initialize failed: RemoteAlreadySet" | The store already has a different origin |
| An agent has no row at all | It is switched off in Settings |
| A status is `unconfirmed` | The agent is read-only or experimental |
| Apply is rejected for one agent | The agent is switched off in settings |
| "path escapes" or "refusing to write through symlink" | A symlinked agent directory or store entry |
| "potential secret detected: line N" | The secret scan hit; fix the content or continue deliberately |
| "frontmatter contains a disallowed YAML anchor" | Anchors, aliases and merge keys are refused |
| "has diverged from origin" | Local and remote histories split; resolve with plain git |
| Pull refuses with "uncommitted changes" | Commit or discard the store first |
| Pull or Apply changed nothing on disk | Pull only updates the store; run a plan and Apply |
| Files the page wrote were never cleaned up | The manifest was lost — it degrades to "nothing is deletable" |
