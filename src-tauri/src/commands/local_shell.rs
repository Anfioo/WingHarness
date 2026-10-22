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
}

static SESSIONS: OnceLock<Mutex<std::collections::HashMap<String, PtySession>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn sessions() -> &'static Mutex<std::collections::HashMap<String, PtySession>> {
    SESSIONS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

#[tauri::command]
pub fn local_shell_start(app: AppHandle, cols: u16, rows: u16) -> Result<String, String> {
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
    let cmd = CommandBuilder::new(shell);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave side is owned by the spawned process; drop it in the parent.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let session_id = format!("local-{id}");
    let child_shared: Arc<Mutex<Box<dyn portable_pty::Child + Send>>> = Arc::new(Mutex::new(child));

    // Pump PTY output onto the event bus. Only a real EOF (Ok(0)) ends the
    // pump; transient read errors (common on Windows ConPTY when a TUI child
    // takes over the console) are retried instead of killing the session.
    {
        let session_id = session_id.clone();
        let child = child_shared.clone();
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

            // Wait for the child process to actually exit before broadcasting
            // exit. The pipe may see EOF while cmd.exe is still alive.
            let code = {
                let mut child_guard = child.lock().unwrap();
                child_guard.wait().ok().map(|status| status.exit_code())
            };
            let _ = app.emit(
                "local-shell-exit",
                serde_json::json!({ "sessionId": session_id, "code": code }),
            );
        });
    }

    sessions().lock().unwrap().insert(
        session_id.clone(),
        PtySession {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: child_shared,
        },
    );

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
    let mut map = sessions().lock().unwrap();
    if let Some(session) = map.remove(&session_id) {
        let mut child = session.child.lock().unwrap();
        let _ = child.kill();
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
