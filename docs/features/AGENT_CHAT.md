# Agent Chat

**Agent Chat** is a main-window page under the **Agent** group. It talks to the
local coding CLIs Claude Code, Codex and Qoder from one place: every tab is an
independent conversation, replies stream in, and tool calls, thinking, questions
and permission requests are handled on one timeline. The sidebar lists the
native sessions the CLIs already keep on disk.

The page is a port of
[desktop-cc-gui](https://github.com/zhukunpenglinyutong/desktop-cc-gui)
(`ccgui-next` 1.2.2, MIT). The engine and history layer lives in the
`src-tauri/agent-chat-core` crate and keeps its attribution headers; the React
front-end was rewritten against this repository's component system. No SDK is
called anywhere: every request goes through a CLI that is already installed.

## Page structure

```
┌─ sidebar ────────┬─ tab strip ──────────────────────────┐
│ search / new     │ Claude │ Codex │ +                   │
│ Today            ├──────────────────────────────────────┤
│ Yesterday        │ transcript (virtualised)             │
│ Earlier          │   user · assistant · thinking        │
│                  │   tool · question · grant · error    │
│                  ├──────────────────────────────────────┤
│                  │ composer: engine model permission cwd│
└──────────────────┴──────────────────────────────────────┘
```

- **Sidebar** — sessions grouped by Today / Yesterday / Earlier, with a search
  box and a refresh button. Clicking a row opens it in a new tab.
- **Tabs** — one independent conversation per tab, keyed by a local `tabId`
  (not by the native session id). Up to 8 tabs. Closing a tab interrupts its
  run first. The active tab, open tabs and per-engine preferences are restored
  on the next launch.
- **Transcript** — virtualised list of user, assistant, thinking, tool,
  question, grant and error rows. Thinking and tool cards collapse; the view
  follows the newest row until the user scrolls up, then offers a "scroll to
  bottom" button. The first page is 200 messages; "Load earlier" asks the
  backend for the page before it.
- **Composer** — engine, model, permission and working-directory controls plus
  the prompt box. Enter sends, Shift+Enter inserts a newline; while a run is
  active the send button becomes Stop. The engine may only be switched in place
  while the tab is still empty; switching on a conversation with messages opens
  a new tab. Changing the working directory behaves the same way.

## Engines

### Claude Code

| Aspect | Value |
| --- | --- |
| Transport | `child` — one `claude -p` process per turn, newline-delimited `stream-json` |
| Executable | `claude` resolved from `PATH` (and `PATHEXT` on Windows, so an npm `.cmd`/`.ps1` shim is run through `cmd /C`) |
| Session file | `<home>/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`; `CLAUDE_CONFIG_DIR` overrides `<home>/.claude` |
| Question channel | CLI `control_request` on stdin; the answer is written back as `control_response`. `AskUserQuestion` becomes a question card |

The process is started with `--print --input-format stream-json
--output-format stream-json --verbose --include-partial-messages`, plus
`--permission-prompt-tool stdio`, the chosen `--permission-mode`, and
`--resume <sessionId>` once the native session id is known. The prompt goes on
stdin, never in argv. Permission modes: `auto`, `manual`, `plan`, `bypass`.

### Codex

| Aspect | Value |
| --- | --- |
| Transport | `own` — one `codex app-server` child per turn speaking JSON-RPC over stdio (`initialize` → `thread/new` or `thread/resume` → `turn/start`) |
| Executable | `codex` resolved from `PATH`/`PATHEXT` |
| Session file | `<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, plus `archived_sessions`; `CODEX_HOME` overrides `<home>/.codex` |
| Question channel | app-server `item/tool/requestUserInput` notification → question card → `agent_answer` writes the response frame; the turn stays parked until it is answered |

`codex exec` is not used. Reasoning effort is passed as
`-c model_reasoning_effort=…`. Permission modes: `auto`, `manual`, `bypass`.

### Qoder

| Aspect | Value |
| --- | --- |
| Transport | `own` — one `qodercli --acp` child per turn speaking the Agent Client Protocol (JSON-RPC over stdio) |
| Executable | `qodercli` (the `qoder` binary is the IDE launcher and speaks no ACP) |
| Session file | none — ACP sessions are not scanned; the history list covers Claude and Codex only |
| Question channel | none — a headless ACP turn starts in bypass and any `session/request_permission` is auto-allowed |

The driver handshakes with `initialize`, then `session/new` or `session/resume`,
optionally `session/set_model` and `session/set_config_option`, and finally
`session/prompt`. Only the `bypass` permission mode is reported because the
other modes cannot be honoured headlessly. The CN distribution (`qoderclicn`,
`~/.qoder-cn`) shares the driver but is not registered as an engine.

## Commands

| Command | Parameters | Returns |
| --- | --- | --- |
| `agent_list_engines` | — | `AgentEngineInfo[]` — label, availability, binary, permissions, transport |
| `agent_send` | `input: AgentSendInput` | `AgentSendResult { runId, sessionId? }` |
| `agent_interrupt` | `runId` | `true` when a live run was killed |
| `agent_live_runs` | `runIds: string[]` | the subset still alive |
| `agent_answer` | `runId`, `requestId`, `answers: Value \| null` | — |
| `agent_list_sessions` | `engine?`, `workspacePath?`, `limit?` | `AgentSessionMeta[]` |
| `agent_load_session` | `engine`, `sessionId`, `workspacePath`, `limit?`, `beforeSeq?` | `AgentSessionPage { messages, nextBefore }` |
| `agent_ui_get` | — | `AgentUiState` |
| `agent_ui_set` | `state: AgentUiState` | — |

`AgentSendInput` carries `engine`, `workspacePath`, `prompt`, and optionally
`sessionId`, `model`, `effort`, `permission`, `additionalDirs` (Claude
`--add-dir`) and a frontend-generated `runId`. The backend rejects an empty
prompt, a missing working directory, an unknown engine and a missing CLI before
it reserves a run slot.

## Events

One channel, `agent:event`, carries a **JSON array** of events. The backend
batches for at most 16 ms or 64 KiB, so a streaming turn costs one IPC message
per frame rather than one per token.

| Field | Meaning |
| --- | --- |
| `runId` | Routes the event to the tab that started the run |
| `sessionId` | Native session id, once known; `null` before that |
| `engine` | `claude` \| `codex` \| `qoder` |
| `seq` | Monotonic per run; the page drops anything that arrives after `done` |
| `kind` | One of the sixteen kinds below |
| `data` | Kind-specific payload |
| `ts` | Unix milliseconds at emit time |

| `kind` | `data` |
| --- | --- |
| `delta` / `thinking` / `warn` | `string` |
| `message` | `{ role, text, path?, args?, result?, toolCallId?, patch? }` |
| `session` | native session id (`string`) |
| `usage` | the engine's raw usage object (stored, not rendered) |
| `model` / `effort` | `string` |
| `retry` | `{ attempt, max, message }` |
| `compaction` | `{ active, reason }` |
| `permission_denied` | `{ tool?, path?, message, toolUseId? }` |
| `question` | `{ requestId, toolUseId?, input }` |
| `question_settled` | `{ requestId }` |
| `error` | `string` |
| `done` | `{ usage?, sessionId? }` |
| `turn_resumed` | `null` |

Every failure is an `AgentChatError` shaped as `{ code, message, detail? }`,
with kebab-case codes: `not-found`, `invalid-input`, `engine-unavailable`,
`not-running`, `conflict`, `unsupported`, `internal`, `not-implemented`. The
page maps the code to an i18n string; `message` is only a fallback.

## Data layout

```
<data dir>/agent-chat/ui.json                 # tabs, active tab, prefs, grants, recent workspaces
<data dir>/agent-chat/ui.json.bak-<unix>      # copy of an unreadable ui.json
<home>/.claude/projects/<encoded-cwd>/<id>.jsonl   # Claude Code's own store — read only
<home>/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl  # Codex's own store — read only
```

`ui.json` is written atomically (temporary file, `sync_all`, rename). A file
that cannot be parsed is copied aside as `ui.json.bak-<unix seconds>` and the
page starts from defaults. Open tabs are clamped to 20 and recent workspaces
to 10, with duplicates removed. Nothing is stored in `localStorage`.

History is read-only. Discovery enumerates candidate JSONL files and peeks at
their head; summaries are cached in-process by `(path, size, mtime)`, so an
unchanged file is not re-parsed. Session content is paged backwards: the page
returns the newest `limit` messages plus `nextBefore = first.seq - 1`, which the
next call passes as `beforeSeq`.

## Limits

| Limit | Value |
| --- | --- |
| Concurrent runs | 3 — the fourth send returns `conflict` |
| Tabs per page | 8 |
| Tabs persisted in `ui.json` | 20 |
| Recent workspaces | 10 |
| Sessions per scan | 200 default, 1 000 max |
| Messages per page | 200 default, 2 000 max |
| Session file read | 64 MiB / 200 000 lines |
| Summary cache | 2 048 entries |
| Event batch | 16 ms / 64 KiB |

## Relationship to the Claude pages

The existing **Claude 对话**, **Claude 历史** and **Claude 工作流** pages stay.
Agent Chat is a separate, multi-engine page and does not replace or extend them:
it does not clone or fork sessions, does not write to the Claude store, and
does not draw a workflow tree. Both pages read the same Claude JSONL files
read-only, so a conversation started in either one appears in both.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| An engine shows "Not installed" | Its CLI is not on `PATH`. Install it (`npm install -g @anthropic-ai/claude-code`, `npm install -g @openai/codex`, `npm install -g @qoder-ai/qodercli`) and refresh |
| The session list is empty | No sessions exist under the CLI's home, or the CLI uses a non-default home. `CLAUDE_CONFIG_DIR` / `CODEX_HOME` are honoured; Qoder sessions are not scanned |
| A question card never appears | Qoder runs headless with auto-allowed permissions; an older Codex app-server may not send `requestUserInput`; a Claude ask that is not `AskUserQuestion` becomes a permission-denied card instead |
| The fourth parallel send is rejected | The concurrency cap is 3. Stop one run first |
| "Grant and retry" does not make the directory writable | Only Claude consumes granted directories (`additionalDirs` / `--add-dir`) |
| A tab is missing after a restart | `ui.json` was corrupt or the session file could not be read; look for `ui.json.bak-*` in the data directory |
| Closing the app left an engine process | Should not happen: `RunEvent::Exit` kills every live run and closing a tab interrupts its run. If it does, record the command line and report it |
