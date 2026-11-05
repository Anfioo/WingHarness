//! Talk to the locally installed `claude` CLI.
//!
//! Contract matches the `@ekaone/use-claude` reference (see `src/lib/use-claude/`):
//! the frontend invokes `send_to_claude` and listens for `claude-event` (one
//! NDJSON line per emit) plus a final `claude-done`. `interrupt_claude` stops a
//! turn that is still running, and ends it through the same two events.
//!
//! The turn runs in the CLI's bidirectional `--input-format stream-json` mode
//! with `--permission-prompts host`: the prompt goes in as a JSON frame, and
//! anything the CLI would otherwise render in its own TTY — a tool-permission
//! prompt, or `AskUserQuestion` — comes back as a `control_request` frame on
//! stdout. The page answers those with `respond_claude_control`, which writes the
//! matching `control_response` frame to the still-open stdin.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use crate::proc::{self, NoWindow};

/// Flags every run shares: NDJSON in and out, token-level deltas so the frontend
/// can render the answer as it arrives, and permission prompts routed to this
/// host instead of the (nonexistent) TTY.
///
/// `--permission-prompts host` only says *who* answers; the prompt surface itself
/// comes from `--permission-prompt-tool stdio`. Without it the CLI has no surface
/// to ask on and silently denies everything that would have prompted, so the two
/// flags are only useful together.
const BASE_ARGS: &[&str] = &[
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompts",
    "host",
    "--permission-prompt-tool",
    "stdio",
];

/// Terminal events we synthesize when the CLI reports none of its own: a
/// non-zero exit, and a turn the user stopped. Both close the turn on the
/// frontend, which is otherwise left waiting for a `result` that never comes.
const ERROR_RESULT: &str = r#"{"type":"result","subtype":"error"}"#;
const INTERRUPTED_RESULT: &str = r#"{"type":"result","subtype":"interrupted","is_error":false}"#;

/// Mirrors one line of CLI-bridge traffic to the page's log drawer.
///
/// `dir` is the direction: `spawn` (the command that ran), `in` (a frame written
/// to stdin), `out` (a line read from stdout), `err` (a line read from stderr),
/// `sys` (an event this side synthesized). Emit failures are dropped — losing a
/// log line must never fail the turn.
fn log_line(app: &AppHandle, dir: &str, text: &str) {
    let _ = app.emit(
        "claude-log",
        serde_json::json!({ "dir": dir, "text": text }),
    );
}

/// A turn that is currently streaming.
struct ActiveRun {
    /// Shared rather than owned by the reader thread, so `interrupt_claude` can
    /// kill the process from another thread.
    child: Arc<Mutex<Child>>,
    /// The child's stdin, held open for the whole turn because that is the
    /// channel control responses travel back on. `None` once the turn has ended
    /// (the reader thread takes it to hand the CLI its EOF), so an answer that
    /// arrives too late fails loudly instead of writing into a dead pipe.
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// Set by `interrupt_claude` and read by the reader thread once the stream
    /// ends. Without it a killed process looks like a crashed one.
    interrupted: Arc<AtomicBool>,
}

/// The in-flight turn, if any.
///
/// The `Arc` is around the slot, not just its contents: the reader thread keeps
/// a clone so it can clear exactly its own turn when it ends, and never a newer
/// one that replaced it.
#[derive(Default)]
pub struct ClaudeRuns(Arc<Mutex<Option<Arc<ActiveRun>>>>);

/// Stops the turn that is running, if there is one: the page's Stop button, and
/// the CLI's Esc.
///
/// The process is killed as a tree, not just as the direct child — `claude` is
/// usually reached through a shell shim, and killing only the shim leaves the
/// node process behind, still holding the stdout pipe. All of it goes, so the
/// reader thread sees EOF and closes the turn as usual.
///
/// Returns whether a turn was actually running.
#[tauri::command]
pub fn interrupt_claude(state: State<'_, ClaudeRuns>) -> Result<bool, String> {
    let run = state
        .0
        .lock()
        .map_err(|_| "The Claude run state is poisoned.".to_string())?
        .clone();
    let Some(run) = run else {
        return Ok(false);
    };

    // Flag first: the reader thread must not read a non-zero exit as a crash.
    run.interrupted.store(true, Ordering::SeqCst);

    let mut child = run
        .child
        .lock()
        .map_err(|_| "The Claude process state is poisoned.".to_string())?;
    proc::kill_tree(&mut child);
    Ok(true)
}

/// Answers a `control_request` the CLI is blocking on.
///
/// `response` is the request's own payload, passed through verbatim: for a
/// `can_use_tool` request that is `{behavior:"allow", updatedInput}` — where an
/// `AskUserQuestion` answer rides in `updatedInput.answers` — or
/// `{behavior:"deny", message}` to refuse. The CLI validates it, so reshaping it
/// here would only add a second place to get it wrong.
#[tauri::command]
pub fn respond_claude_control(
    app: AppHandle,
    state: State<'_, ClaudeRuns>,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    let run = state
        .0
        .lock()
        .map_err(|_| "The Claude run state is poisoned.".to_string())?
        .clone();
    let Some(run) = run else {
        return Err("No Claude turn is running.".to_string());
    };

    let mut stdin = run
        .stdin
        .lock()
        .map_err(|_| "The Claude input state is poisoned.".to_string())?;
    let Some(stdin) = stdin.as_mut() else {
        return Err("The Claude turn has already ended.".to_string());
    };

    let frame = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response,
        },
    });
    write_frame(Some(&app), stdin, &frame)
}

/// Writes one NDJSON frame to the CLI's stdin.
///
/// The exact text written is logged when an `app` handle is at hand, so the
/// drawer shows what was really sent rather than a re-encoding of it.
fn write_frame(
    app: Option<&AppHandle>,
    stdin: &mut ChildStdin,
    frame: &serde_json::Value,
) -> Result<(), String> {
    let mut line = serde_json::to_string(frame)
        .map_err(|error| format!("Could not encode the Claude frame: {error}"))?;
    line.push('\n');
    if let Some(app) = app {
        log_line(app, "in", line.trim_end());
    }
    stdin
        .write_all(line.as_bytes())
        .and_then(|()| stdin.flush())
        .map_err(|error| format!("Could not write to claude: {error}"))
}

/// True for the CLI's terminal `result` event, which marks the turn as over even
/// though the process stays alive waiting for the next one.
fn is_result_event(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| value.get("type")?.as_str().map(str::to_owned))
        .is_some_and(|kind| kind == "result")
}

/// Writes the MCP Hub's server list out in the shape `--mcp-config` consumes and
/// returns the path, or `None` when there is nothing to inject.
///
/// The Hub keeps its own bookkeeping (`settings`, and a per-server `disabled`
/// flag) in the same file, so the servers are re-emitted as a plain
/// `{"mcpServers": …}` document: the CLI gets the servers it can use and none of
/// the Hub state it would misread, and a disabled server stays disabled.
fn mcp_config_file() -> Option<String> {
    let config = crate::mcphub::config::read_config_value();
    let servers = config
        .get("mcpServers")
        .or_else(|| config.get("servers"))?
        .as_object()?;

    let enabled: serde_json::Map<String, serde_json::Value> = servers
        .iter()
        .filter(|(_, entry)| entry.get("disabled").and_then(|flag| flag.as_bool()) != Some(true))
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect();
    if enabled.is_empty() {
        return None;
    }

    let path = crate::mcphub::paths::base_dir().join("claude-mcp.json");
    let payload = serde_json::json!({ "mcpServers": enabled });
    let body = serde_json::to_vec_pretty(&payload).ok()?;
    std::fs::write(&path, body).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Waits for a child to exit, without holding its lock while it does.
///
/// `Child::wait` under the mutex would deadlock against `interrupt_claude`: the
/// interrupt needs the same lock to kill the process, and a `wait` that can only
/// end when that kill happens never gives it up. Polling keeps the lock held for
/// the instant of the check. This runs after stdout has closed, so the first
/// check has almost always already seen the exit.
fn reap(child: &Mutex<Child>) -> bool {
    loop {
        match child.lock() {
            Ok(mut guard) => match guard.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) => {}
                Err(_) => return false,
            },
            Err(_) => return false,
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Runs one Claude turn, streaming its NDJSON output as `claude-event` lines.
///
/// The prompt is written to the child's stdin rather than passed as an argument:
/// on Windows `claude` is often an npm `.cmd` shim launched through `cmd /C`,
/// where a long prompt in argv would be open to shell quoting.
///
/// `resume` is the session id from a previous turn; supplying it continues that
/// conversation instead of starting a fresh one.
///
/// `permission_mode` mirrors the CLI's Shift+Tab selector — `manual`,
/// `acceptEdits`, `auto`, `dontAsk`, `plan` or `bypassPermissions`. It is
/// forwarded only when it names one of those, so an unexpected value leaves the
/// CLI default. Anything that mode would still prompt for reaches the page
/// instead of being auto-denied, because the prompts are routed to this host.
///
/// Synchronous on purpose: spawning is quick and returns immediately, while the
/// blocking stdout/stderr reads run on a plain thread — an `async` body would
/// instead hold a runtime worker for the whole stream.
#[tauri::command]
pub fn send_to_claude(
    app: AppHandle,
    state: State<'_, ClaudeRuns>,
    prompt: String,
    cwd: String,
    model: String,
    resume: String,
    permission_mode: String,
) -> Result<(), String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Empty prompt.".to_string());
    }

    // One turn at a time. The page disables Send while one is streaming, and a
    // second process would be unreachable by Stop — only one run is tracked.
    let slot = Arc::clone(&state.0);
    if slot
        .lock()
        .map_err(|_| "The Claude run state is poisoned.".to_string())?
        .is_some()
    {
        return Err("A Claude turn is already running.".to_string());
    }

    let cwd = if cwd.trim().is_empty() {
        ".".to_string()
    } else {
        cwd.trim().to_string()
    };
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("Working directory does not exist: {cwd}"));
    }

    let plan = proc::spawn_plan("claude");

    // Collected up front rather than pushed onto the Command, so the drawer can
    // show the exact invocation the turn runs.
    let mut args: Vec<String> = plan.prefix.clone();
    args.extend(BASE_ARGS.iter().map(|arg| (*arg).to_string()));

    let model = model.trim();
    if !model.is_empty() {
        args.push("--model".to_string());
        args.push(model.to_string());
    }

    // Only pass the flag for a known mode; anything else keeps the CLI default.
    let permission_mode = permission_mode.trim();
    if matches!(
        permission_mode,
        "manual" | "acceptEdits" | "auto" | "dontAsk" | "plan" | "bypassPermissions"
    ) {
        args.push("--permission-mode".to_string());
        args.push(permission_mode.to_string());
    }

    // MCP Hub's servers, so the page can call the same tools the Hub manages.
    if let Some(mcp_config) = mcp_config_file() {
        args.push("--mcp-config".to_string());
        args.push(mcp_config);
    }

    let resume = resume.trim();
    if !resume.is_empty() {
        args.push("--resume".to_string());
        args.push(resume.to_string());
    }

    log_line(
        &app,
        "spawn",
        &format!("[{}] {} {}", cwd, plan.program, args.join(" ")),
    );

    let mut command = Command::new(&plan.program);
    command.args(&args);
    let mut child = command
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags_no_window()
        .spawn()
        .map_err(|error| format!("Could not start claude in {cwd}: {error}"))?;

    // Send the prompt as a user frame. stdin deliberately stays open: it is the
    // channel the CLI's permission and AskUserQuestion prompts come back on.
    let Some(mut child_stdin) = child.stdin.take() else {
        return Err("Could not open claude's input.".to_string());
    };
    let user_frame = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": prompt }],
        },
        "parent_tool_use_id": serde_json::Value::Null,
    });
    write_frame(Some(&app), &mut child_stdin, &user_frame)?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Publish the turn so `interrupt_claude` and `respond_claude_control` can
    // reach it. The child is shared rather than moved into the reader thread, and
    // the slot is cleared by whichever turn still owns it when it ends.
    let child = Arc::new(Mutex::new(child));
    let stdin = Arc::new(Mutex::new(Some(child_stdin)));
    let interrupted = Arc::new(AtomicBool::new(false));
    let run = Arc::new(ActiveRun {
        child: Arc::clone(&child),
        stdin: Arc::clone(&stdin),
        interrupted: Arc::clone(&interrupted),
    });
    *slot
        .lock()
        .map_err(|_| "The Claude run state is poisoned.".to_string())? = Some(Arc::clone(&run));

    std::thread::spawn(move || {
        // stderr can run long on a failure; drain it on its own thread so a full
        // pipe buffer cannot stall the process. It goes to the log drawer only:
        // it is plain text, which the transcript parser discards anyway.
        if let Some(stderr) = stderr {
            let stderr_app = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log_line(&stderr_app, "err", &line);
                }
            });
        }

        if let Some(stdout) = stdout {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log_line(&app, "out", &line);
                let _ = app.emit("claude-event", &line);
                // The turn is over. Closing stdin is what gets the CLI to exit;
                // the loop keeps draining stdout until it does, or a full pipe
                // buffer would stall the very exit we are waiting on.
                if is_result_event(&line) {
                    if let Ok(mut stdin) = stdin.lock() {
                        drop(stdin.take());
                    }
                }
            }
        }

        // Release the input handle even on a stream that ended without a result.
        if let Ok(mut stdin) = stdin.lock() {
            drop(stdin.take());
        }

        let succeeded = reap(&child);
        let was_interrupted = interrupted.load(Ordering::SeqCst);

        // A turn that ends without a terminal `result` event would leave the
        // frontend waiting forever, so synthesize one for it to render.
        if was_interrupted {
            log_line(&app, "sys", INTERRUPTED_RESULT);
            let _ = app.emit("claude-event", INTERRUPTED_RESULT);
        } else if !succeeded {
            log_line(&app, "sys", ERROR_RESULT);
            let _ = app.emit("claude-event", ERROR_RESULT);
        }
        log_line(
            &app,
            "sys",
            if succeeded {
                "claude exited"
            } else if was_interrupted {
                "claude was stopped"
            } else {
                "claude exited with an error"
            },
        );

        // Release the slot, unless a later turn has already taken it.
        if let Ok(mut slot) = slot.lock() {
            let ours = slot
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &run));
            if ours {
                *slot = None;
            }
        }

        let _ = app.emit("claude-done", "");
    });

    Ok(())
}
