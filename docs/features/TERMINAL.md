# Local Terminal

The **终端** (Terminal) page is a real pseudo-console in the webview. It sits in
the sidebar under **高级生态** (Ecosystem), and it is the only place in the app
that gives you a raw shell — the Git repository window has its own terminal for
running commands next to a diff, but this page is the standalone one.

The terminal is first-party: xterm in the frontend, `portable-pty` in Rust. There
is no upstream project to attribute and no shell integration installed — the
prompt you get is the one the shell already prints.

## How it works

```
TerminalTab ── invoke ──▶ local_shell_start { cols, rows } ──▶ "local-1"
   xterm onData   ──▶ local_shell_write { sessionId, text }        (UTF-8, not base64)
   xterm onResize ──▶ local_shell_resize { sessionId, cols, rows }

event "local-shell-output" { sessionId, data: base64 } ──▶ xterm.write(bytes)
event "local-shell-exit"   { sessionId, code: number | null }

tab closed / page unmounts ──▶ local_shell_kill { sessionId }
```

- **Sessions** live in a `OnceLock<Mutex<HashMap<String, PtySession>>>` in the
  Rust process. Ids are `local-<n>` from an `AtomicU64`, so they are stable
  within a run and meaningless across runs.
- **Spawn** opens a pty with `NativePtySystem::openpty` at the size the xterm
  grid reports. On Windows `portable-pty` uses ConPTY. The shell is `COMSPEC` or
  `cmd.exe` on Windows and `$SHELL` or `/bin/sh` elsewhere, started with **no
  arguments, no working-directory override and no environment changes** — the
  child inherits exactly what the app process has.
- **Output** is read in 8 KiB chunks by one thread per session, and each read
  becomes one `local-shell-output` event with standard (unpadded) base64.
  There is no coalescing, no acknowledgement and no backpressure: a command that
  prints a lot produces a lot of events. A transient read error is retried after
  10 ms; only 100 consecutive errors or a clean EOF stop the pump.
- **Exit** is emitted after `child.wait()`, so `code` is the real exit status.
  Output can arrive after the last `local-shell-output` and before
  `local-shell-exit`; the tab treats exit as final.
- **Kill** removes the session, kills the child and reaps it. Closing a tab and
  navigating away both go through it, so no shell outlives its tab.

## The page

Tabs across the top, one terminal per tab. A tab is `tab-<timestamp>-<seq>` and
exists only in memory. All panes stay mounted and hidden rather than being
unmounted, because an xterm instance cannot survive a remount with its buffer
intact — the cost is that a hidden pane has zero size, which the xterm host
tolerates by ignoring resize observations while `clientWidth` or `clientHeight`
is zero.

A boot generation counter guards against a superseded mount starting a second
shell, which also covers React's development-mode double mount.

## Commands and events

| Command | Parameters | Returns |
| --- | --- | --- |
| `local_shell_start` | `cols`, `rows` | session id |
| `local_shell_write` | `sessionId`, `data` (UTF-8 text) | — |
| `local_shell_resize` | `sessionId`, `cols`, `rows` | — |
| `local_shell_kill` | `sessionId` | — |
| `local_shell_list_fonts` | — | installed family names |

| Event | Payload |
| --- | --- |
| `local-shell-output` | `{ sessionId, data }`, base64 |
| `local-shell-exit` | `{ sessionId, code }`, `code` null if unknown |

`local_shell_list_fonts` feeds the Settings font picker through `font-kit`, so
the terminal and the editor offer the same font list.

## Preferences

Terminal preferences are a `localStorage` key, `local-terminal-prefs`, edited in
**Settings → 终端**:

| Key | Default |
| --- | --- |
| `fontFamily` | `Consolas` |
| `fontSize` | 14 |
| `tabStopWidth` | 4 |
| `autoWrap` | on |
| `highlightCurrentLine` | on |

They live in `localStorage` rather than the data directory on purpose: they are
view state, not feature data, and the page reacts to the cross-window `storage`
event so a change in Settings applies without a reload. Auto-wrap is implemented
by sending xterm's DECAWM sequence, so a shell that turns wrapping off is not
overridden.

## Theme

The terminal has no palette of its own. `terminalThemeFromTokens()` reads the
app's CSS custom properties (`--card`, `--foreground`, `--primary`,
`--muted-foreground`, `--accent`, `--destructive`, `--success`, `--info`, and the
graph colours) and builds an xterm theme from them, accepting `hsl` triplets,
`oklch` and hex. A `MutationObserver` on the `<html>` class re-derives the theme,
so switching light/dark recolours an open terminal immediately. Hardcoded
fallbacks exist for the case where a token cannot be parsed.

## Limits

- **Nothing is persisted.** Tabs, scrollback, layout and the running shell die
  with the page. There is no session restore.
- **`cmd.exe` only on Windows.** No PowerShell, no WSL, no profiles, no
  working-directory choice, no shell arguments.
- **No flow control.** Heavy output floods the event bus instead of being
  throttled; scrollback is xterm's 5 000 lines, which bounds memory but not the
  event rate.
- **No maximum tab count** and no split panes.
- stdout and stderr are merged by the pty, so the terminal cannot tell them
  apart — which is what a real console does too.

## Wiring this module into another app

1. Add `portable-pty`, `base64` and `font-kit` to `src-tauri/Cargo.toml`.
2. Register the five `local_shell_*` commands through `invoke.rs`, `build.rs`
   and `capabilities/default.json`.
3. The frontend needs `src/components/terminal/xterm-host.tsx`
   (`@xterm/xterm` + `@xterm/addon-fit`), `src/lib/terminal/theme.ts` and the
   page itself.
4. Windows needs no extra dependency — ConPTY ships with the OS — but the app
   must not be built for a Windows version older than 10 1809.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| The tab is blank and no prompt appears | `local_shell_start` failed, or the shell in `COMSPEC` does not exist |
| Output appears but keystrokes do nothing | The session id in the write call no longer matches a live session |
| Text arrives garbled | The shell writes a non-UTF-8 codepage (`chcp 65001` fixes it) |
| The window freezes while a command runs | The command is printing megabytes — there is no throttling |
| A closed tab leaves an orphan process | The child ignored the kill, or the app was terminated before `local_shell_kill` ran |
| The font list is empty | `font-kit` found no system fonts; the picker falls back to `Consolas` |
| Colours are wrong after a theme change | The theme token was an unsupported colour form and the fallback palette was used |
