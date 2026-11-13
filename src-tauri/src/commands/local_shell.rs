//! Minimal local PTY (cmd.exe on Windows) wired to xterm.js over Tauri events.
//!
//! Protocol:
//!  - frontend -> backend: `local_shell_start` / `local_shell_write` / `local_shell_resize` / `local_shell_kill`
//!  - backend -> frontend: event `local-shell-output`  { sessionId, data(base64) }
//!                         event `local-shell-exit`    { sessionId, code }

use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::Engine as _;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tauri::{AppHandle, Emitter};

struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
    /// Can kill while another thread is blocked in `child.wait()`.
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    pid: Option<u32>,
}

static SESSIONS: OnceLock<Mutex<std::collections::HashMap<String, PtySession>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn sessions() -> &'static Mutex<std::collections::HashMap<String, PtySession>> {
    SESSIONS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Opens a pseudo-console.
///
/// With no `command` this is the interactive shell the terminal page uses.
/// With one it runs that command line and exits — the Scoop page uses it to
/// stream an installer, and passes the variables it needs through `env` rather
/// than writing them into a script file.
#[tauri::command]
pub fn local_shell_start(
    app: AppHandle,
    cols: u16,
    rows: u16,
    command: Option<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // On Windows launch cmd.exe; elsewhere fall back to $SHELL / /bin/sh.
    let shell = if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    };
    let mut cmd = CommandBuilder::new(shell);

    if let Some(dir) = cwd.as_deref() {
        cmd.cwd(dir);
    }
    if let Some(values) = env {
        for (key, value) in values {
            cmd.env(key, value);
        }
    }
    if let Some(line) = command.as_deref() {
        if cfg!(target_os = "windows") {
            // `/d` skips AutoRun, which could otherwise run a user's startup
            // commands before ours; `/c` runs the line and exits.
            cmd.arg("/d");
            cmd.arg("/c");
        } else {
            cmd.arg("-c");
        }
        cmd.arg(line);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave side is owned by the spawned process; drop it in the parent.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let session_id = format!("local-{id}");
    let pid = child.process_id();
    let killer = child.clone_killer();
    let child_shared: Arc<Mutex<Box<dyn portable_pty::Child + Send>>> = Arc::new(Mutex::new(child));

    sessions().lock().unwrap().insert(
        session_id.clone(),
        PtySession {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: child_shared.clone(),
            killer: Mutex::new(killer),
            pid,
        },
    );

    // Pump PTY output onto the event bus. Only a real EOF (Ok(0)) ends the
    // pump; transient read errors (common on Windows ConPTY when a TUI child
    // takes over the console) are retried instead of killing the session.
    {
        let session_id = session_id.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut consecutive_errors = 0u32;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        consecutive_errors = 0;
                        let payload = serde_json::json!({
                            "sessionId": session_id,
                            "data": STANDARD_NO_PAD.encode(&buf[..n]),
                        });
                        if app.emit("local-shell-output", payload).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        consecutive_errors += 1;
                        if consecutive_errors > 100 {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        });
    }

    // Exit watcher. ConPTY does not report EOF when the child exits, so a
    // pump that only watched the reader would block forever and `exit` would
    // never be announced. Waiting on the child is what produces the event;
    // dropping the session afterwards closes the console and unblocks the
    // pump.
    {
        let app = app.clone();
        let session_id = session_id.clone();
        let child = child_shared;
        std::thread::spawn(move || {
            let code = {
                let mut child_guard = child.lock().unwrap();
                child_guard.wait().ok().map(|status| status.exit_code())
            };
            // Let the last chunk of output reach the event bus first.
            std::thread::sleep(Duration::from_millis(150));
            sessions().lock().unwrap().remove(&session_id);
            let _ = app.emit(
                "local-shell-exit",
                serde_json::json!({ "sessionId": session_id, "code": code }),
            );
        });
    }

    Ok(session_id)
}

#[tauri::command]
pub fn local_shell_write(session_id: String, data: String) -> Result<(), String> {
    let bytes = data.into_bytes();
    let map = sessions().lock().unwrap();
    let session = map
        .get(&session_id)
        .ok_or_else(|| "no such session".to_string())?;
    let mut w = session.writer.lock().unwrap();
    w.write_all(&bytes).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn local_shell_resize(session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = sessions().lock().unwrap();
    let session = map
        .get(&session_id)
        .ok_or_else(|| "no such session".to_string())?;
    let m = session.master.lock().unwrap();
    m.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_shell_kill(session_id: String) -> Result<(), String> {
    let session = sessions().lock().unwrap().remove(&session_id);
    if let Some(session) = session {
        // The killer is independent of `child`, so this does not deadlock
        // with the exit watcher that is blocked in `wait`.
        let _ = session.killer.lock().unwrap().kill();
        if let Some(pid) = session.pid {
            let _ = crate::proc::kill_tree_of(pid);
        }
        let mut child = session.child.lock().unwrap();
        let _ = child.wait();
    }
    Ok(())
}

/// Enumerate system-installed font family names for the terminal font picker.
#[tauri::command]
pub fn local_shell_list_fonts() -> Vec<String> {
    font_kit::source::SystemSource::new()
        .all_families()
        .unwrap_or_default()
}
