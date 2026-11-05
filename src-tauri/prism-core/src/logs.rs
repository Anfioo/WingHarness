//! What the core said while it was running.
//!
//! The core writes its console output to `run/mihomo.log`, so the page reads the
//! tail of that file instead of opening the controller's streaming `/logs`
//! endpoint: the last run stays readable after the core has stopped, and no
//! second connection has to survive a hot reload.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

use crate::store;

/// Bytes read from the end of the file: a screenful of lines without loading a
/// log that has grown for hours.
const MAX_TAIL_BYTES: u64 = 256 * 1024;
const MAX_LINES: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// The timestamp as the core wrote it, e.g. `2026-10-31T12:34:56+08:00`.
    pub time: String,
    /// `debug`, `info`, `warning`, `error`, `fatal`, or `other` for a line that
    /// is not a log record at all.
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsView {
    pub lines: Vec<LogLine>,
}

pub fn tail(limit: usize) -> Result<LogsView, String> {
    let limit = limit.clamp(1, MAX_LINES);
    let path = store::core_log_path()?;
    let mut lines: Vec<LogLine> = read_tail(&path, MAX_TAIL_BYTES)?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(parse)
        .collect();
    if lines.len() > limit {
        lines.drain(..lines.len() - limit);
    }
    Ok(LogsView { lines })
}

fn read_tail(path: &Path, max: u64) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("No core log yet; start the core first ({error})"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("Cannot read the core log: {error}"))?
        .len();
    let from = length.saturating_sub(max);
    file.seek(SeekFrom::Start(from))
        .map_err(|error| format!("Cannot read the core log: {error}"))?;
    let mut bytes = Vec::new();
    file.take(max)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read the core log: {error}"))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if from == 0 {
        return Ok(text);
    }
    // The window usually starts mid-line; that fragment is not a log record.
    Ok(text
        .split_once('\n')
        .map(|(_, rest)| rest)
        .unwrap_or("")
        .to_string())
}

/// `time="..." level=info msg="..."`, as logrus prints it.
fn parse(line: &str) -> LogLine {
    let time = field(line, "time=").unwrap_or_default();
    let level = field(line, "level=")
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "other".to_string());
    let message = field(line, "msg=").unwrap_or_else(|| line.to_string());
    LogLine {
        time,
        level,
        message,
    }
}

/// The value of the first `key` that begins a token, quoted or bare.
fn field(line: &str, key: &str) -> Option<String> {
    let mut search = 0;
    while let Some(offset) = line[search..].find(key) {
        let index = search + offset;
        let boundary = index == 0 || line[..index].ends_with(' ');
        if boundary {
            return Some(value_of(&line[index + key.len()..]));
        }
        search = index + key.len();
    }
    None
}

fn value_of(rest: &str) -> String {
    let Some(inner) = rest.strip_prefix('"') else {
        return rest.split_whitespace().next().unwrap_or_default().to_string();
    };
    let mut escaped = false;
    for (index, character) in inner.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' => return unescape(&inner[..index]),
            _ => {}
        }
    }
    unescape(inner)
}

/// A message is one line in the page, so the escapes logrus adds for newlines
/// and tabs become spaces.
fn unescape(text: &str) -> String {
    text.replace("\\\"", "\"")
        .replace("\\\\", "\\")
        .replace("\\n", " ")
        .replace("\\t", " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_logrus_line() {
        let parsed = parse(
            "time=\"2026-10-31T12:34:56.7+08:00\" level=info \
             msg=\"[TCP] 127.0.0.1:1 --> example.com:443 match Match()\"",
        );
        assert_eq!(parsed.time, "2026-10-31T12:34:56.7+08:00");
        assert_eq!(parsed.level, "info");
        assert_eq!(
            parsed.message,
            "[TCP] 127.0.0.1:1 --> example.com:443 match Match()"
        );
    }

    #[test]
    fn unescapes_a_quoted_message() {
        let parsed = parse("time=\"t\" level=error msg=\"cannot dial \\\"proxy\\\"\\nretry\"");
        assert_eq!(parsed.level, "error");
        assert_eq!(parsed.message, "cannot dial \"proxy\" retry");
    }

    #[test]
    fn keeps_a_line_that_is_not_a_record() {
        let parsed = parse("panic: runtime error");
        assert_eq!(parsed.level, "other");
        assert_eq!(parsed.message, "panic: runtime error");
        assert!(parsed.time.is_empty());
    }
}
