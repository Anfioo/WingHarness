//! Native session history.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! Claude and Codex session files are read-only; this module only discovers,
//! summarizes and pages them. A0 freezes `list_sessions` / `load_session` and
//! the shared text helpers below; B4 fills discovery, extraction, the summary
//! cache and paging.

pub mod discovery;
pub mod extract;
pub mod reader;
pub mod scanner;

use std::path::Path;

use serde_json::Value;

use crate::error::AgentChatError;
use crate::models::{AgentSessionMeta, AgentSessionPage};

/// Lists native sessions, newest first.
pub fn list_sessions(
    engine: Option<&str>,
    workspace: Option<&Path>,
    limit: usize,
) -> Result<Vec<AgentSessionMeta>, AgentChatError> {
    let _ = (engine, workspace, limit);
    Err(AgentChatError::not_implemented())
}

/// Reads one page of a native session transcript.
pub fn load_session(
    engine: &str,
    session_id: &str,
    workspace: &Path,
    limit: usize,
    before_seq: Option<i64>,
) -> Result<AgentSessionPage, AgentChatError> {
    let _ = (engine, session_id, workspace, limit, before_seq);
    Err(AgentChatError::not_implemented())
}

/// Parse a timestamp that is either Unix seconds/milliseconds or RFC3339.
pub fn parse_ts_ms_str(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = trimmed.parse::<i64>() {
        return Some(if value.abs() < 10_000_000_000 {
            value * 1000
        } else {
            value
        });
    }
    rfc3339_ms(trimmed)
}

/// Minimal RFC3339 parse without a chrono dependency: handles
/// `YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`.
fn rfc3339_ms(text: &str) -> Option<i64> {
    let (date_part, rest) = text.split_once('T')?;
    let mut date = date_part.split('-');
    let year: i64 = date.next()?.parse().ok()?;
    let month: i64 = date.next()?.parse().ok()?;
    let day: i64 = date.next()?.parse().ok()?;

    let (time_part, offset_part) = match rest.find(['Z', '+']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => match rest.rfind('-') {
            Some(index) if index > 0 => (&rest[..index], &rest[index..]),
            _ => (rest, "Z"),
        },
    };
    let mut time = time_part.split('.').next()?.split(':');
    let hour: i64 = time.next()?.parse().ok()?;
    let minute: i64 = time.next()?.parse().ok()?;
    let second: i64 = time.next().unwrap_or("0").parse().ok()?;

    let offset_minutes = if offset_part.starts_with('Z') || offset_part.is_empty() {
        0
    } else {
        let sign = if offset_part.starts_with('-') { -1 } else { 1 };
        let mut offset = offset_part[1..].split(':');
        let offset_hour: i64 = offset.next()?.parse().ok()?;
        let offset_minute: i64 = offset.next().unwrap_or("0").parse().ok()?;
        sign * (offset_hour * 60 + offset_minute)
    };

    Some(civil_to_epoch_ms(year, month, day, hour, minute, second) - offset_minutes * 60_000)
}

/// Days-from-civil algorithm (Howard Hinnant), no external deps.
fn civil_to_epoch_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let year_of_era = y - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000
}

/// Extract display text from a message `content` value that may be a string
/// or an array of typed parts.
pub fn content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| {
                let kind = part.get("type").and_then(Value::as_str);
                kind == Some("text") || kind.is_none()
            })
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.as_str())
            })
            .collect::<Vec<_>>()
            .join(""),
        Some(Value::Object(map)) => {
            if let Some(parts) = map.get("parts").and_then(Value::as_array) {
                parts
                    .iter()
                    .filter_map(|part| {
                        part.get("text")
                            .and_then(Value::as_str)
                            .or_else(|| part.as_str())
                    })
                    .collect::<Vec<_>>()
                    .join("")
            } else {
                map.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            }
        }
        _ => String::new(),
    }
}

pub fn truncate_chars(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    trimmed.chars().take(max).collect()
}

/// Envelopes the CLIs prepend to a turn; they are runtime context, not typed
/// input.
const INJECTED_LEADING_TAGS: &[&str] = &[
    "user_info",
    "system-reminder",
    "ide_selection",
    "opened_file",
    "workspace_path",
];

/// Strip the injected runtime envelopes from a user turn and unwrap a
/// `<user_query>` body.
pub fn clean_user_turn(text: &str) -> String {
    let mut rest = text.trim_start();
    loop {
        let previous_len = rest.len();
        for tag in INJECTED_LEADING_TAGS {
            let open = format!("<{tag}>");
            if rest.starts_with(&open) {
                rest = strip_leading_named_block(rest, tag);
            }
        }
        if rest.len() == previous_len {
            break;
        }
    }
    unwrap_user_query(rest)
}

fn unwrap_user_query(text: &str) -> String {
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";
    let trimmed = text.trim_start();
    if let Some(inner) = trimmed.strip_prefix(OPEN) {
        let body = match inner.find(CLOSE) {
            Some(end) => &inner[..end],
            None => inner,
        };
        return body.trim().to_string();
    }
    trimmed.trim().to_string()
}

/// Strip one leading `<tag>...</tag>`. An unterminated block is left intact.
fn strip_leading_named_block<'a>(text: &'a str, tag: &str) -> &'a str {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let Some(rest) = text.strip_prefix(&open) else {
        return text;
    };
    match rest.find(&close) {
        Some(end) => rest[end + close.len()..].trim_start(),
        None => text,
    }
}

pub fn same_or_child(candidate: &Path, workspace: &Path) -> bool {
    candidate == workspace || candidate.starts_with(workspace)
}

/// Claude encodes a workspace path: every non-alphanumeric except '-' becomes
/// '-'.
pub fn claude_encode_project_path(path: &str) -> String {
    path.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unix_seconds_and_millis() {
        assert_eq!(parse_ts_ms_str("1700000000"), Some(1_700_000_000_000));
        assert_eq!(parse_ts_ms_str("1700000000000"), Some(1_700_000_000_000));
    }

    #[test]
    fn parses_rfc3339_with_fraction_and_offset() {
        assert_eq!(
            parse_ts_ms_str("2023-11-14T22:13:20Z"),
            Some(1_700_000_000_000)
        );
        assert_eq!(
            parse_ts_ms_str("2023-11-15T06:13:20.000+08:00"),
            Some(1_700_000_000_000)
        );
    }

    #[test]
    fn strips_injected_envelopes_and_unwraps_user_query() {
        let turn = "<system-reminder>ctx</system-reminder>\n<user_query>hello</user_query>";
        assert_eq!(clean_user_turn(turn), "hello");
    }

    #[test]
    fn truncates_on_char_boundaries() {
        assert_eq!(truncate_chars("  abcdef  ", 3), "abc");
        assert_eq!(truncate_chars("中文测试", 2), "中文");
    }
}
