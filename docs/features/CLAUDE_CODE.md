# Claude

Three pages in the sidebar under **Agent** work on Claude Code: **Claude 对话**
(chat), **Claude 历史** (history) and **Claude 工作流** (workflow). None of them
opens a window of its own — they are main-window pages.

They fit together like this: **chat** drives the locally installed `claude` CLI
and produces real sessions; **history** reads the sessions Claude Code already
keeps and derives new ones from them (clone, fork); **workflow** draws the family
tree that history created.

The chat behaviour is a port of
[jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui) (MIT)
and the transcript hook is vendored from
[use-claude](https://github.com/ekaone/use-claude) (MIT). There is no SDK call
anywhere: everything goes through the CLI that is already installed.

## Claude chat

```
useClaudeCode()  (src/lib/use-claude)
  └─ ClaudeSession ── invoke ──▶ claude_chat commands
       └─ StateManager   event "claude-event" (one NDJSON line) → transcript items
                         event "claude-log"   (spawn | in | out | err | sys)
                         event "claude-done"  (process exited)

stdin  ◀── {"type":"user", …}          per turn
stdout ──▶ one event per line          stream-json
control_request ──▶ ask dialog ──▶ respond_claude_control ──▶ stdin
```

| Command | Parameters | Returns |
| --- | --- | --- |
| `send_to_claude` | `prompt`, `cwd`, `model`, `resume`, `permissionMode` | — (streams) |
| `interrupt_claude` | — | `true` if a turn was running |
| `respond_claude_control` | `requestId`, `response` | — |

The CLI is started with:

```
--print --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --permission-prompts host --permission-prompt-tool stdio
[--model <id>] [--permission-mode <manual|acceptEdits|auto|dontAsk|plan|bypassPermissions>]
[--mcp-config <data dir>/claude-mcp.json]   # enabled MCP Hub servers only
[--resume <sessionId>]
```

The prompt goes on **stdin**, never in argv. `--continue` is never used: the
session id from the CLI's `system`/`init` event is remembered and passed back as
`--resume` on the next turn, which is what keeps one conversation coherent.

Stream parsing turns `stream_event` deltas into live text, thinking and tool
cards, then reconciles them against the authoritative `assistant` and `user`
events when the turn completes. A `result` event adds the closing item with
duration and cost. A tool call that needs permission arrives as a
`control_request`, which blocks on the inline dialog and is answered over stdin.
A prompt that nobody answers is auto-answered after 120 s so the turn cannot hang
forever.

**One turn at a time.** There is a single run slot; sending while it is occupied
returns "A Claude turn is already running." Stop is Esc, which kills the process
tree (`taskkill /T /F` on Windows).

The working directory defaults to the working copy from `Settings → 项目`,
is editable in the toolbar, and changing it starts a fresh conversation. The
transcript drawer reopens earlier sessions; the CLI log drawer shows the raw
traffic.

## Claude history

A read-only browser over what Claude Code itself stores —
`%USERPROFILE%\.claude\projects\<slug>\<sessionId>.jsonl`, where the slug is the
working directory with every non-alphanumeric character replaced by `-`
(`M:\dev\app` → `M--dev-app`). Sub-agent transcripts (`agent-*.jsonl`),
`journal.jsonl` and side-chain files are excluded.

| Command | Returns |
| --- | --- |
| `list_claude_projects` | projects with session counts |
| `list_claude_project_sessions` | sessions for one project |
| `load_claude_project_session` | records, branches, metadata |
| `list_claude_sessions`, `load_claude_session` | the same, scoped to one working directory |
| `clone_claude_session` | a new session id — every record copied |
| `fork_claude_session` | a new session id — records up to a chosen message |
| `list_claude_families`, `load_claude_family` | the clone/fork tree for the workflow page |
| `save_text_file` | Markdown export |

A session opens either as a node view — one card per message, tool and thinking
counts folded in — or as the full transcript, with tool calls collapsible.

**Clone and fork are the only writes**, and they never touch an existing file:
the new session is written to a temporary name and renamed into place, with the
original `uuid`/`parentUuid` values kept and only `sessionId` replaced. A trailing
`custom-title` row carries the title.

Forking copies the conversation chain up to and including the chosen message,
plus any tool-result rows that immediately follow it — without those the API would
see a tool call that was never answered. A message that is no longer on the chain
(for example after a compaction) cannot be forked.

## Claude workflow

The rail lists sessions that have clones or forks; the canvas draws the family:
one node per turn (your question plus the last reply of that turn), top-down, one
column per leaf. A fork merges into the line it came from before its fork point
and diverges after it; a clone starts a new line; a fork taken from a clone hangs
off that line. An empty fork still gets a node, so a branch that was created but
never used is visible rather than silently missing.

Turns are paired in the backend (`turns_of`): every user message with the last
assistant text before the next user message, clipped to 600 characters, newest
500 turns.

## Data layout

```
%USERPROFILE%/.claude/projects/<slug>/<sessionId>.jsonl    # Claude Code's own store — read only
<data dir>/.claude-history/forks/<rootSessionId>-fork.json  # this app's lineage record
```

The lineage file is `{ rootSessionId, rootProject, copies: [{ kind, sessionId,
title, project, sourceProject, sourceSessionId, forkUuid?, createdMs }] }`. It is
best-effort: if it is missing or unreadable the workflow page shows nothing, but
the sessions themselves are untouched. The `custom-title` append on a parent
session is the one non-atomic write in the module.

## Limits

| Limit | Value |
| --- | --- |
| Transcript rows loaded | newest 2 000 records / 20 000 lines |
| Head/tail scan window | 64 KiB |
| Workflow turns | 500, 600 characters each |
| Turns shown initially | 3, then +5 per "load earlier" |
| CLI log drawer | 300 entries × 8 000 characters |
| Permission dialog | auto-answered after 120 s |
| Canvas zoom | 0.2–1.6 |

Chat itself stores nothing: the conversation lives in Claude Code's JSONL, so a
session started here is indistinguishable from one started in a terminal.

## Wiring this module into another app

1. Add `commands/claude_chat.rs`, `claude_history.rs` and `claude_fork.rs`, and
   register all twelve commands through `invoke.rs`, `build.rs` and
   `capabilities/default.json`.
2. The `claude` binary is resolved from `PATH` (and `PATHEXT` on Windows, so a
   `.cmd` shim is run through `cmd /C`). Nothing else has to be configured.
3. Copy `src/lib/use-claude` with its attribution header and the three pages.
4. If MCP Hub is ported too, point `--mcp-config` at its exported configuration;
   otherwise drop the flag.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Could not start claude…" | The CLI is not on `PATH`, or a `.cmd` shim could not be run |
| The history list is empty but sessions exist | The working-directory slug differs — the session was recorded elsewhere |
| "A Claude turn is already running." | The previous turn is still alive; interrupt it |
| Only tool cards appear, no text | The CLI build ignores `--include-partial-messages`; only final `assistant` events arrive |
| A permission dialog never closes | Nothing answered it and stdin was already closed |
| Fork fails with "not part of this session's conversation" | The message is no longer on the chain (compaction or rewind) |
| The workflow page is empty | No lineage file — nothing has been cloned or forked by this app |
| A session shows no title | It has no `customTitle`, `aiTitle`, `lastPrompt` or first prompt |
| `--resume` fails | The stored session id belongs to a different working directory |
