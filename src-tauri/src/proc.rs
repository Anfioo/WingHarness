//! Small process helpers shared by the shell runners.

use std::io::{BufReader, Read};
use std::process::Child;
#[cfg(windows)]
use std::process::{Command, Stdio};
use std::sync::mpsc::Sender;
use std::thread;

/// Which pipe a line of output came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Keeps a spawned helper's console window hidden.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// How to launch a configured `command` on this platform.
///
/// `program` is what goes to `Command::new`; `prefix` is inserted before the
/// caller's args (e.g. `cmd /C` for a batch shim).
pub struct SpawnPlan {
    pub program: String,
    pub prefix: Vec<String>,
}

/// Decide how to launch `command`.
///
/// On Windows `CreateProcess` only ever appends `.exe` when resolving a bare
/// name against `PATH`. Tools installed through npm/pip are `.cmd` shims with
/// no `.exe` at all (`codegraph`, `npx`, `claude`, …), so `Command::new(name)`
/// fails with "program not found" even though `where name` finds it. Those have
/// to go through `cmd.exe /C`, which does honour `PATHEXT`.
pub fn spawn_plan(command: &str) -> SpawnPlan {
    #[cfg(not(target_os = "windows"))]
    {
        SpawnPlan {
            program: command.to_string(),
            prefix: Vec::new(),
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::path::Path;

        let as_cmd = |program: &str| SpawnPlan {
            program: "cmd".to_string(),
            prefix: vec!["/C".to_string(), program.to_string()],
        };

        // A path (contains a separator) or an explicit extension is taken at
        // face value: real executables run directly, batch shims via cmd.
        if command.contains(['\\', '/']) || Path::new(command).extension().is_some() {
            let ext = Path::new(command)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            return match ext.as_deref() {
                Some("cmd") | Some("bat") => as_cmd(&format!("\"{command}\"")),
                _ => SpawnPlan {
                    program: command.to_string(),
                    prefix: Vec::new(),
                },
            };
        }

        // Bare name: prefer a real executable, else fall back to a `.cmd`/`.bat`
        // shim found on PATH (routed through cmd, which resolves it itself).
        let pathext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let exts: Vec<String> = pathext
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase())
            .collect();

        let mut shim_found = false;
        if let Ok(path) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path) {
                for ext in &exts {
                    if !dir.join(format!("{command}{ext}")).is_file() {
                        continue;
                    }
                    match ext.as_str() {
                        ".exe" | ".com" => {
                            return SpawnPlan {
                                program: command.to_string(),
                                prefix: Vec::new(),
                            }
                        }
                        ".cmd" | ".bat" => shim_found = true,
                        _ => {}
                    }
                }
            }
        }
        if shim_found {
            return as_cmd(command);
        }

        // Nothing matched: let CreateProcess try and surface its own error.
        SpawnPlan {
            program: command.to_string(),
            prefix: Vec::new(),
        }
    }
}

/// Spawns a child without letting Windows give it a console window.
///
/// The packaged app is a GUI binary with no console of its own, so Windows
/// creates a fresh one for every console child — a black window flashing up on
/// each command. Every spawn goes through this trait rather than repeating the
/// flag, because forgetting it is silent and only shows up in a release build.
pub trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl NoWindow for std::process::Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(windows))]
impl NoWindow for std::process::Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        self
    }
}

/// Kills `child` and everything it spawned.
///
/// `Child::kill` only reaches the direct child. The shells we start fan out —
/// `cmd` → `scoop.cmd` → PowerShell, or `bash` → `svn` — and the grandchildren
/// inherit the pipes, so they have to go too or the reader threads never see
/// EOF and the pipes stay open.
#[cfg(windows)]
pub fn kill_tree(child: &mut Child) {
    if !kill_tree_of(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// [`kill_tree`] for a process already known by pid.
///
/// A plugin started for the page it serves outlives the call that launched it,
/// so the app keeps only its pid; by the time it is stopped there is no `Child`
/// left to hand over. Returns false when the tree could not be killed.
#[cfg(windows)]
pub fn kill_tree_of(pid: u32) -> bool {
    Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags_no_window()
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Nothing to kill without Windows' `taskkill`.
#[cfg(not(windows))]
pub fn kill_tree_of(_pid: u32) -> bool {
    false
}

#[cfg(not(windows))]
pub fn kill_tree(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Reads `reader` to EOF on its own thread and pushes every line to `sender`.
///
/// Bytes are decoded lossily instead of with `BufRead::lines`, which returns an
/// error on the first non-UTF-8 byte and would silently cut the rest of the
/// output off — a plugin's script can emit non-UTF-8 bytes on a GBK console.
/// Both `\n` and `\r` end a line, because many CLIs repaint progress with a
/// bare `\r`.
pub(crate) fn forward<R: Read + Send + 'static>(
    reader: R,
    stream: Stream,
    sender: Sender<(Stream, String)>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut pending = Vec::new();
        let mut chunk = [0u8; 4096];

        loop {
            let read = match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };

            for &byte in &chunk[..read] {
                if byte != b'\n' && byte != b'\r' {
                    pending.push(byte);
                    continue;
                }

                if pending.is_empty() {
                    continue;
                }
                let text = String::from_utf8_lossy(&pending).into_owned();
                pending.clear();

                if sender.send((stream, text)).is_err() {
                    return;
                }
            }
        }

        // Flush a trailing line that arrived without a separator.
        if !pending.is_empty() {
            let text = String::from_utf8_lossy(&pending).into_owned();
            let _ = sender.send((stream, text));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{forward, spawn_plan, Stream};
    use std::io::Cursor;
    use std::sync::mpsc;

    fn collect(input: &[u8]) -> Vec<String> {
        let (sender, receiver) = mpsc::channel();
        forward(Cursor::new(input.to_vec()), Stream::Stdout, sender);
        receiver.into_iter().map(|(_, line)| line).collect()
    }

    #[test]
    fn forwarding_survives_invalid_utf8() {
        // 0xFF and 0xFE are never valid UTF-8. `BufRead::lines` returns an
        // error on the first one, which would abandon the rest of the pipe.
        let lines = collect(b"first\n\xFF\xFE broken\nthird\n");
        assert_eq!(lines, vec!["first", "\u{FFFD}\u{FFFD} broken", "third"]);
    }

    #[test]
    fn carriage_returns_start_new_lines() {
        let lines = collect(b"Receiving 10%\rReceiving 20%\rdone\n");
        assert_eq!(lines, vec!["Receiving 10%", "Receiving 20%", "done"]);
    }

    #[test]
    fn flushes_a_trailing_line_without_separator() {
        assert!(collect(b"no newline").eq(&["no newline".to_string()]));
        // Consecutive separators must not emit empty lines.
        assert!(collect(b"a\n\n\nb\n").eq(&["a".to_string(), "b".to_string()]));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn cmd_shim_routes_through_cmd() {
        // `cmd` is a real .exe; a bare name must resolve to it directly.
        let plan = spawn_plan("cmd");
        assert_eq!(plan.program, "cmd");
        assert!(plan.prefix.is_empty());
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn explicit_cmd_path_is_wrapped() {
        let plan = spawn_plan("C:\tools\thing.cmd");
        assert_eq!(plan.program, "cmd");
        assert_eq!(plan.prefix, vec!["/C", "\"C:\tools\thing.cmd\""]);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn explicit_exe_path_runs_directly() {
        let plan = spawn_plan("C:\tools\thing.exe");
        assert_eq!(plan.program, "C:\tools\thing.exe");
        assert!(plan.prefix.is_empty());
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn bare_name_runs_directly_on_unix() {
        let plan = spawn_plan("npx");
        assert_eq!(plan.program, "npx");
        assert!(plan.prefix.is_empty());
    }
}
