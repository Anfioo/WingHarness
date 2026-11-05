//! Reading the child's stdout/stderr: ANSI stripping, credential redaction,
//! level inference and the tunnel states inferred from frpc's own messages.

use std::io::{BufRead, BufReader};
use std::sync::Arc;
use std::thread;

use crate::models::{LogEntry, LogLevel, LogStream, TunnelRuntimeState, TunnelState};

use super::policy::is_permanent_failure_message;
use super::types::{ManagedProcess, MAX_LOG_LINES};
use super::ProcessRegistry;

/// Read one child stream to completion, pushing every line into the registry.
pub(crate) fn spawn_log_reader<R>(
    registry: Arc<ProcessRegistry>,
    app: tauri::AppHandle,
    profile_id: String,
    stream: LogStream,
    reader: R,
) where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines() {
            let Ok(raw) = line else { break };
            let message = sanitize_line(&raw);
            if message.is_empty() {
                continue;
            }
            registry.push_log(
                &app,
                LogEntry {
                    profile_id: profile_id.clone(),
                    stream,
                    level: infer_level(&message),
                    message,
                    timestamp: crate::process::now_epoch_millis(),
                },
            );
        }
    });
}

impl ProcessRegistry {
    /// Append one line: ring buffer, log file, tunnel/permanent-failure state,
    /// then the two events. No lock is held while a file is written or an event
    /// is emitted.
    pub(crate) fn push_log(&self, app: &tauri::AppHandle, entry: LogEntry) {
        {
            let mut guard = super::lock_guard(&self.logs);
            let buffer = guard.entry(entry.profile_id.clone()).or_default();
            buffer.push_back(entry.clone());
            while buffer.len() > MAX_LOG_LINES {
                buffer.pop_front();
            }
        }

        let prefs = self.log_prefs();
        crate::log_files::append_line(&entry, &prefs);

        let (snapshot, child_to_kill) = {
            let mut guard = super::lock_guard(&self.processes);
            match guard.get_mut(&entry.profile_id) {
                Some(process) => {
                    let tunnel_changed = apply_tunnel_state(process, &entry.message);
                    let permanent = !process.permanent_failure
                        && is_permanent_failure_message(&entry.message);
                    let mut child_to_kill = None;
                    if permanent {
                        process.permanent_failure = true;
                        process.cancel_reconnect = true;
                        process.state = crate::models::ProcessState::Failed;
                        process.last_error = Some(entry.message.clone());
                        child_to_kill = process.child.take();
                    }
                    let snapshot = if tunnel_changed || permanent {
                        Some(process.to_snapshot())
                    } else {
                        None
                    };
                    (snapshot, child_to_kill)
                }
                None => (None, None),
            }
        };

        if let Some(mut child) = child_to_kill {
            let _ = child.kill();
            // Reap it here: the exit watcher lost the handle, so nobody else will.
            let _ = child.wait();
        }
        if let Some(snapshot) = snapshot {
            if snapshot.state == crate::models::ProcessState::Failed {
                crate::orphan::clear_pid_record(&entry.profile_id);
            }
            crate::events::emit_state(app, &snapshot);
        }

        crate::events::emit_log(app, &entry);
    }

    /// Internal notices share the child's stdout channel; they are generated
    /// here, so they carry no escape sequences and need no redaction.
    pub(crate) fn push_system_log(
        &self,
        app: &tauri::AppHandle,
        profile_id: &str,
        level: LogLevel,
        message: String,
    ) {
        self.push_log(
            app,
            LogEntry {
                profile_id: profile_id.to_string(),
                stream: LogStream::Stdout,
                level,
                message,
                timestamp: crate::process::now_epoch_millis(),
            },
        );
    }
}

/// Strip ANSI escapes and redact credential-shaped values.
pub(crate) fn sanitize_line(line: &str) -> String {
    let mut output = strip_ansi(line);
    for key in ["auth.token", "secretkey", "secret_key", "token", "password", "secret"] {
        output = redact_key_value(&output, key);
    }
    output.trim_end().to_string()
}

/// Infer the level from an explicit frpc token first, then from keywords.
///
/// frpc writes `[I]`/`[W]`/`[E]`/`[D]`/`[T]` after the timestamp, and plugin
/// output may carry `level=info`; anything else falls back to keywords.
pub(crate) fn infer_level(message: &str) -> LogLevel {
    if let Some(level) = explicit_level(message) {
        return level;
    }
    let lower = message.to_ascii_lowercase();
    if lower.contains("error") || lower.contains("panic") || lower.contains("fatal") || lower.contains("failed")
    {
        LogLevel::Error
    } else if lower.contains("warn") {
        LogLevel::Warn
    } else if lower.contains("debug") {
        LogLevel::Debug
    } else if lower.contains("trace") {
        LogLevel::Trace
    } else {
        LogLevel::Info
    }
}

fn explicit_level(message: &str) -> Option<LogLevel> {
    let bytes = message.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'[' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let Some(close) = message[start..].find(']') else {
            break;
        };
        let token = &message[start..start + close];
        if let Some(level) = level_token(token) {
            return Some(level);
        }
        index = start + close + 1;
    }

    let lower = message.to_ascii_lowercase();
    let marker = lower.find("level=")?;
    let value = lower[marker + "level=".len()..].trim_start_matches([' ', '"', '\'']);
    let value = value
        .split(|character: char| character.is_whitespace() || character == '"' || character == ',')
        .next()
        .unwrap_or_default();
    level_token(value)
}

fn level_token(token: &str) -> Option<LogLevel> {
    let token = token.trim();
    if token.eq_ignore_ascii_case("info") || token == "I" || token == "i" {
        return Some(LogLevel::Info);
    }
    if token.eq_ignore_ascii_case("warn")
        || token.eq_ignore_ascii_case("warning")
        || token == "W"
        || token == "w"
    {
        return Some(LogLevel::Warn);
    }
    if token.eq_ignore_ascii_case("error")
        || token.eq_ignore_ascii_case("fatal")
        || token.eq_ignore_ascii_case("panic")
        || token == "E"
        || token == "e"
    {
        return Some(LogLevel::Error);
    }
    if token.eq_ignore_ascii_case("debug") || token == "D" || token == "d" {
        return Some(LogLevel::Debug);
    }
    if token.eq_ignore_ascii_case("trace") || token == "T" || token == "t" {
        return Some(LogLevel::Trace);
    }
    None
}

/// Update one tunnel's state from `[name] start proxy success` / `start error`.
/// Returns whether anything changed.
pub(crate) fn apply_tunnel_state(process: &mut ManagedProcess, message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    let Some(name) = extract_proxy_name(message) else {
        return false;
    };
    let next = if lower.contains("start error") || lower.contains("start proxy error") {
        TunnelState::Error
    } else if lower.contains("start proxy success")
        || lower.contains("proxy added")
        || lower.contains("start success")
    {
        TunnelState::Online
    } else {
        return false;
    };

    let next_message = if next == TunnelState::Error {
        Some(message.trim().to_string())
    } else {
        None
    };
    match process.tunnel_states.get(&name) {
        Some(current) if current.state == next && current.message == next_message => false,
        _ => {
            process.tunnel_states.insert(
                name.clone(),
                TunnelRuntimeState {
                    name,
                    state: next,
                    message: next_message,
                },
            );
            true
        }
    }
}

/// The proxy name frpc wraps in `[...]`, skipping level and source markers.
fn extract_proxy_name(message: &str) -> Option<String> {
    let start = message.find('[')?;
    let end = message[start + 1..].find(']')?;
    let name = message[start + 1..start + 1 + end].trim();
    if name.is_empty() || name.len() > 64 {
        return None;
    }
    if level_token(name).is_some() {
        return None;
    }
    if name.contains('/') || name.contains(':') || name.contains(' ') {
        return None;
    }
    Some(name.to_string())
}

/// Remove terminal color / style escape sequences so the UI shows plain text.
fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != 0x1b {
            let character = input[index..].chars().next().expect("valid UTF-8 slice");
            output.push(character);
            index += character.len_utf8();
            continue;
        }
        index += 1;
        if index >= bytes.len() {
            break;
        }
        match bytes[index] {
            b'[' => {
                // CSI: ESC [ ... final byte in @-~
                index += 1;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            b']' => {
                // OSC: ESC ] ... BEL or ST (ESC \)
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == 0x07 {
                        index += 1;
                        break;
                    }
                    if bytes[index] == 0x1b && index + 1 < bytes.len() && bytes[index + 1] == b'\\' {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            }
            b'(' | b')' => {
                index += 1;
                if index < bytes.len() {
                    index += 1;
                }
            }
            _ => index += 1,
        }
    }
    output
}

/// Replace the value after `key =`, `key:` or `"key":` with `***`.
///
/// Handles TOML (`token = "x"`), prose (`password: x`) and JSON (`"token":"x"`).
fn redact_key_value(input: &str, key: &str) -> String {
    let mut output = input.to_string();
    let mut search_from = 0;
    while let Some(relative) = output[search_from..].to_ascii_lowercase().find(key) {
        let key_end = search_from + relative + key.len();
        let mut offset = key_end + leading_space(&output[key_end..]);
        // A JSON key is quoted: `"token":`.
        if output[offset..].starts_with('"') {
            offset += 1;
        }
        offset += leading_space(&output[offset..]);
        let Some(separator) = output[offset..].chars().next() else {
            break;
        };
        if separator != '=' && separator != ':' {
            search_from = key_end;
            continue;
        }
        offset += separator.len_utf8();
        offset += leading_space(&output[offset..]);

        let value = &output[offset..];
        let consumed = if let Some(unquoted) = value.strip_prefix('"') {
            unquoted.find('"').map(|length| length + 2).unwrap_or(value.len())
        } else if let Some(unquoted) = value.strip_prefix('\'') {
            unquoted.find('\'').map(|length| length + 2).unwrap_or(value.len())
        } else {
            value
                .find(|character: char| {
                    character.is_whitespace()
                        || character == ','
                        || character == '}'
                        || character == ']'
                })
                .unwrap_or(value.len())
        };
        if consumed == 0 {
            search_from = key_end;
            continue;
        }

        let replacement = if value.starts_with('"') { "\"***\"" } else { "***" };
        output.replace_range(offset..offset + consumed, replacement);
        search_from = offset + replacement.len();
    }
    output
}

fn leading_space(value: &str) -> usize {
    value.len() - value.trim_start().len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process::types::LaunchSpec;
    use std::path::PathBuf;

    fn launch() -> LaunchSpec {
        LaunchSpec {
            profile_id: "p1".into(),
            runtime_id: "rt".into(),
            runtime_version: "0.61.0".into(),
            runtime_path: PathBuf::from("frpc"),
            config_path: PathBuf::from("frpc.toml"),
            work_dir: PathBuf::from("."),
            reconnect_enabled: true,
            server_endpoint: "127.0.0.1:7000".into(),
            config_revision: 0,
        }
    }

    #[test]
    fn redacts_token_assignments() {
        let line = r#"auth.token = "super-secret" login ok"#;
        let redacted = sanitize_line(line);
        assert!(redacted.contains("***"), "{redacted}");
        assert!(!redacted.contains("super-secret"));
    }

    #[test]
    fn redacts_secret_key_and_password() {
        assert!(!sanitize_line(r#"secretKey="abc123" role=server"#).contains("abc123"));
        assert!(!sanitize_line(r#"secretKey: abc123"#).contains("abc123"));
        assert!(!sanitize_line("password= hunter2 done").contains("hunter2"));
        assert!(!sanitize_line(r#"{"token":"tok-1","other":1}"#).contains("tok-1"));
    }

    #[test]
    fn keeps_unrelated_text_intact() {
        let line = "start proxy success for [ssh]";
        assert_eq!(sanitize_line(line), line);
    }

    #[test]
    fn strips_ansi_color_codes() {
        let colored = "\u{1b}[1;34mINFO\u{1b}[0m [sub/root.go:194] start frpc service";
        let sanitized = sanitize_line(colored);
        assert_eq!(sanitized, "INFO [sub/root.go:194] start frpc service");
        assert!(!sanitized.contains('\u{1b}'));
    }

    #[test]
    fn infers_level_from_frpc_markers() {
        assert_eq!(infer_level("2026/11/04 12:00:00 [I] [root.go:1] hi"), LogLevel::Info);
        assert_eq!(infer_level("2026/11/04 12:00:00 [W] [root.go:1] hmm"), LogLevel::Warn);
        assert_eq!(infer_level("2026/11/04 12:00:00 [E] [root.go:1] bad"), LogLevel::Error);
        assert_eq!(infer_level("2026/11/04 12:00:00 [D] [root.go:1] detail"), LogLevel::Debug);
        assert_eq!(infer_level("2026/11/04 12:00:00 [T] [root.go:1] trace"), LogLevel::Trace);
    }

    #[test]
    fn infers_level_from_keywords_when_no_marker() {
        assert_eq!(infer_level("connection failed"), LogLevel::Error);
        assert_eq!(infer_level("something looks off, warning"), LogLevel::Warn);
        assert_eq!(infer_level("plain line"), LogLevel::Info);
        // A tunnel name in brackets must not be mistaken for a level marker.
        assert_eq!(infer_level("[ssh] start proxy success"), LogLevel::Info);
    }

    #[test]
    fn marks_tunnels_online_and_error_from_log_lines() {
        let mut process = ManagedProcess::placeholder("p1", launch(), 1, crate::models::ProcessState::Running);

        assert!(apply_tunnel_state(&mut process, "[ssh] start proxy success"));
        let state = process.tunnel_states.get("ssh").expect("ssh tracked");
        assert_eq!(state.state, TunnelState::Online);

        // Repeating the same line is not a change.
        assert!(!apply_tunnel_state(&mut process, "[ssh] start proxy success"));

        assert!(apply_tunnel_state(&mut process, "[web] start error: port already used"));
        let web = process.tunnel_states.get("web").expect("web tracked");
        assert_eq!(web.state, TunnelState::Error);
        assert!(web.message.is_some());

        assert!(!apply_tunnel_state(&mut process, "[web] unrelated line"));
        assert!(!apply_tunnel_state(&mut process, "no bracket here"));
    }

    #[test]
    fn ignores_source_and_level_brackets_for_tunnel_names() {
        let mut process = ManagedProcess::placeholder("p1", launch(), 1, crate::models::ProcessState::Running);
        assert!(!apply_tunnel_state(&mut process, "[I] [root.go:12] start proxy success"));
        assert!(!apply_tunnel_state(&mut process, "[sub/root.go:194] start proxy success"));
        assert!(process.tunnel_states.is_empty());
    }
}
