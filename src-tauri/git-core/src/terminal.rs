use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
#[cfg(not(target_os = "windows"))]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
#[cfg(not(target_os = "windows"))]
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalSessions {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: AtomicU32,
}

#[derive(Default)]
pub struct TerminalState(Arc<TerminalSessions>);

impl TerminalState {
    pub fn sessions(&self) -> Arc<TerminalSessions> {
        Arc::clone(&self.0)
    }
}

#[derive(Serialize, Clone)]
struct TermData {
    data: String,
}

#[cfg(not(target_os = "windows"))]
const ENV_MARK: &str = "__ANGKORGIT_ENV__";
#[cfg(not(target_os = "windows"))]
const ENV_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(not(target_os = "windows"))]
const ENV_SKIP: [&str; 6] = ["TERM", "_", "SHLVL", "PWD", "OLDPWD", "TERM_PROGRAM"];
#[cfg(not(target_os = "windows"))]
const DEFAULT_UTF8_LOCALE: &str = "en_US.UTF-8";

fn default_shell() -> CommandBuilder {
    #[cfg(target_os = "windows")]
    {
        CommandBuilder::new("powershell.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        let login = login_shell_env();
        for (key, value) in login {
            cmd.env(key, value);
        }
        let lang = login
            .get("LANG")
            .cloned()
            .or_else(|| std::env::var("LANG").ok());
        cmd.env("LANG", utf8_locale(lang.as_deref()));
        let lc_all = login
            .get("LC_ALL")
            .cloned()
            .or_else(|| std::env::var("LC_ALL").ok());
        if let Some(lc_all) = lc_all {
            if !is_utf8_locale(&lc_all) {
                cmd.env("LC_ALL", utf8_locale(Some(&lc_all)));
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd
    }
}

#[cfg(not(target_os = "windows"))]
fn login_shell_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| probe_login_shell_env().unwrap_or_default())
}

#[cfg(not(target_os = "windows"))]
fn probe_login_shell_env() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").ok()?;
    let mut command = crate::proc::hidden(&shell);
    command
        .args(["-ilc", &format!("echo {ENV_MARK}; env; echo {ENV_MARK}")])
        .current_dir(std::env::var("HOME").unwrap_or_else(|_| "/".to_string()));
    let captured = crate::ai_cli::capture(command, "", ENV_PROBE_TIMEOUT).ok()?;
    Some(parse_marked_env(&captured.stdout))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn parse_marked_env(stdout: &str) -> HashMap<String, String> {
    let Some(start) = stdout.find(ENV_MARK) else {
        return HashMap::new();
    };
    let body = &stdout[start + ENV_MARK.len()..];
    let Some(end) = body.rfind(ENV_MARK) else {
        return HashMap::new();
    };
    body[..end]
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(key, _)| !key.is_empty() && !ENV_SKIP.contains(key))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn is_utf8_locale(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.ends_with(".utf-8") || lower.ends_with(".utf8")
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn utf8_locale(current: Option<&str>) -> String {
    let value = current.map(str::trim).unwrap_or("");
    if value.is_empty() || value.eq_ignore_ascii_case("c") || value.eq_ignore_ascii_case("posix") {
        return DEFAULT_UTF8_LOCALE.to_string();
    }
    if is_utf8_locale(value) {
        return value.to_string();
    }
    let (body, modifier) = match value.split_once('@') {
        Some((body, modifier)) => (body, format!("@{modifier}")),
        None => (value, String::new()),
    };
    let language = body.split('.').next().unwrap_or(body);
    format!("{language}.UTF-8{modifier}")
}

pub fn create(
    app: &AppHandle,
    state: &Arc<TerminalSessions>,
    cwd: &str,
    cols: u16,
    rows: u16,
) -> AppResult<u32> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::other(format!("failed to open pty: {e}")))?;

    let mut cmd = default_shell();
    cmd.cwd(cwd);
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::other(format!("failed to spawn shell: {e}")))?;
    let killer = child.clone_killer();

    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::other(format!("failed to clone pty reader: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| AppError::other(format!("failed to take pty writer: {e}")))?;

    state.sessions.lock().unwrap().insert(
        id,
        PtySession {
            writer,
            master: pair.master,
            killer,
        },
    );

    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_handle.emit(&format!("term-data-{id}"), TermData { data });
                }
            }
        }
    });

    let exit_app = app.clone();
    let exit_sessions = Arc::clone(state);
    std::thread::spawn(move || {
        let _ = child.wait();
        exit_sessions.sessions.lock().unwrap().remove(&id);
        let _ = exit_app.emit(&format!("term-exit-{id}"), ());
    });

    Ok(id)
}

pub fn write(state: &TerminalSessions, id: u32, data: &str) -> AppResult<()> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| AppError::other("terminal session not found"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(AppError::from)?;
    session.writer.flush().ok();
    Ok(())
}

pub fn resize(state: &TerminalSessions, id: u32, cols: u16, rows: u16) -> AppResult<()> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&id)
        .ok_or_else(|| AppError::other("terminal session not found"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::other(format!("resize failed: {e}")))?;
    Ok(())
}

pub fn kill(state: &TerminalSessions, id: u32) -> AppResult<()> {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&id) {
        session.killer.kill().ok();
    }
    Ok(())
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;

    #[test]
    fn marked_env_ignores_profile_chatter_and_keeps_equals_in_values() {
        let out = format!(
            "Welcome back!\n{ENV_MARK}\nPATH=/opt/homebrew/bin:/usr/bin\nFOO=a=b\nTERM=screen\nSHLVL=2\nEMPTY=\n{ENV_MARK}\ntrailing noise\n"
        );
        let env = parse_marked_env(&out);
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(env.get("FOO").map(String::as_str), Some("a=b"));
        assert_eq!(env.get("EMPTY").map(String::as_str), Some(""));
        assert!(!env.contains_key("TERM"));
        assert!(!env.contains_key("SHLVL"));
        assert!(!env.contains_key("Welcome back!"));
    }

    #[test]
    fn marked_env_without_marks_is_empty() {
        assert!(parse_marked_env("PATH=/usr/bin\n").is_empty());
        assert!(parse_marked_env(&format!("{ENV_MARK}\nPATH=/usr/bin\n")).is_empty());
    }

    #[test]
    fn locale_keeps_utf8_and_upgrades_the_rest() {
        assert_eq!(utf8_locale(Some("zh_CN.UTF-8")), "zh_CN.UTF-8");
        assert_eq!(utf8_locale(Some("en_US.utf8")), "en_US.utf8");
        assert_eq!(utf8_locale(Some("zh_CN")), "zh_CN.UTF-8");
        assert_eq!(utf8_locale(Some("de_DE.ISO8859-1")), "de_DE.UTF-8");
        assert_eq!(
            utf8_locale(Some("ca_ES.ISO8859-15@euro")),
            "ca_ES.UTF-8@euro"
        );
        assert_eq!(utf8_locale(Some("C")), "en_US.UTF-8");
        assert_eq!(utf8_locale(Some("POSIX")), "en_US.UTF-8");
        assert_eq!(utf8_locale(Some("")), "en_US.UTF-8");
        assert_eq!(utf8_locale(None), "en_US.UTF-8");
    }
}
