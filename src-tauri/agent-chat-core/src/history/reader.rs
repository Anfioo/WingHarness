//! Paged transcript reading.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/ccgui-next.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! The UI opens a session and pages backwards with `before_seq`. Each call
//! re-parses the file, bounded by [`MAX_READ_BYTES`] and [`MAX_READ_LINES`], so
//! a runaway transcript cannot exhaust memory.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use serde_json::Value;

use crate::error::AgentChatError;
use crate::models::{AgentMessage, AgentSessionPage};

use super::discovery::{self, Candidate};
use super::extract;
use super::scanner;

const DEFAULT_PAGE_LIMIT: usize = 200;
const MAX_PAGE_LIMIT: usize = 2_000;
const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;
const MAX_READ_LINES: usize = 200_000;

pub(crate) fn load_session(
    engine: &str,
    session_id: &str,
    workspace: &Path,
    limit: usize,
    before_seq: Option<i64>,
) -> Result<AgentSessionPage, AgentChatError> {
    let candidate = locate(engine, session_id, workspace)?;
    let messages = read_transcript(&candidate.file_path, engine)?;
    Ok(page(&messages, clamp_page_limit(limit), before_seq))
}

/// The session id is authoritative; the workspace only disambiguates when the
/// same id exists in more than one project.
fn locate(engine: &str, session_id: &str, workspace: &Path) -> Result<Candidate, AgentChatError> {
    let mut matches: Vec<Candidate> = discovery::candidates(Some(engine), None)
        .into_iter()
        .filter(|candidate| candidate.session_id == session_id)
        .collect();
    if matches.is_empty() {
        return Err(AgentChatError::not_found(format!(
            "Session {session_id} was not found for engine {engine}."
        )));
    }
    if let Some(index) = matches
        .iter()
        .position(|candidate| scanner::paths_equal(&candidate.workspace_path, workspace))
    {
        return Ok(matches.remove(index));
    }
    matches.sort_by_key(|candidate| std::cmp::Reverse(candidate.mtime_ms));
    Ok(matches.remove(0))
}

fn read_transcript(path: &Path, engine: &str) -> Result<Vec<AgentMessage>, AgentChatError> {
    let file = File::open(path).map_err(|error| {
        AgentChatError::internal(format!("Failed to open session file: {error}"))
    })?;
    let mut reader = BufReader::new(file.take(MAX_READ_BYTES));
    let mut rows = Vec::new();
    let mut buffer = Vec::new();
    let mut lines = 0usize;

    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => {
                return Err(AgentChatError::internal(format!(
                    "Failed to read session file: {error}"
                )))
            }
        }
        lines += 1;
        if lines > MAX_READ_LINES {
            eprintln!(
                "agent-chat: session read truncated at {MAX_READ_LINES} lines: {}",
                path.display()
            );
            break;
        }
        // A line cut by the byte cap, or one that is not valid UTF-8 / JSON,
        // is skipped without failing the transcript.
        let Ok(text) = std::str::from_utf8(&buffer) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        rows.extend(extract::extract_line(engine, &value));
    }

    Ok(extract::fold_rows(rows))
}

/// `messages` is ascending by `seq`; the page is the last `limit` rows at or
/// before `before_seq`.
fn page(messages: &[AgentMessage], limit: usize, before_seq: Option<i64>) -> AgentSessionPage {
    let end = match before_seq {
        Some(before) => messages.partition_point(|message| message.seq <= before),
        None => messages.len(),
    };
    let start = end.saturating_sub(limit);
    let messages = messages[start..end].to_vec();
    let next_before = messages
        .first()
        .map(|message| message.seq)
        .filter(|seq| *seq > 1)
        .map(|seq| seq - 1);
    AgentSessionPage {
        messages,
        next_before,
    }
}

fn clamp_page_limit(limit: usize) -> usize {
    if limit == 0 {
        return DEFAULT_PAGE_LIMIT;
    }
    limit.min(MAX_PAGE_LIMIT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "agent-chat-reader-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn write_claude_session(root: &Path, count: usize) -> PathBuf {
        let file = root.join("session.jsonl");
        let mut body = String::new();
        for index in 1..=count {
            body.push_str(&format!(
                "{{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"message\":{{\"role\":\"user\",\"content\":\"turn {index}\"}}}}\n"
            ));
            body.push_str(&format!(
                "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":\"answer {index}\"}}}}\n"
            ));
        }
        fs::write(&file, body).expect("write fixture");
        file
    }

    fn messages(limit: usize, before_seq: Option<i64>) -> AgentSessionPage {
        let mut rows = Vec::new();
        for index in 1..=10 {
            let value: Value = serde_json::json!({
                "type": "user",
                "message": {"role": "user", "content": format!("turn {index}")}
            });
            rows.extend(extract::extract_line("claude", &value));
        }
        page(&extract::fold_rows(rows), limit, before_seq)
    }

    #[test]
    fn first_page_returns_the_tail_and_a_cursor() {
        let first = messages(4, None);
        let seqs: Vec<i64> = first.messages.iter().map(|message| message.seq).collect();
        assert_eq!(seqs, [7, 8, 9, 10]);
        assert_eq!(first.next_before, Some(6));
    }

    #[test]
    fn earlier_page_uses_before_seq_and_stops_at_the_start() {
        let second = messages(4, Some(6));
        let seqs: Vec<i64> = second.messages.iter().map(|message| message.seq).collect();
        assert_eq!(seqs, [3, 4, 5, 6]);
        assert_eq!(second.next_before, Some(2));

        let third = messages(4, Some(2));
        let seqs: Vec<i64> = third.messages.iter().map(|message| message.seq).collect();
        assert_eq!(seqs, [1, 2]);
        assert_eq!(third.next_before, None);
    }

    #[test]
    fn out_of_range_before_seq_returns_an_empty_page() {
        let empty = messages(4, Some(0));
        assert!(empty.messages.is_empty());
        assert_eq!(empty.next_before, None);
    }

    #[test]
    fn read_transcript_skips_bad_lines_and_folds_tools() {
        let root = temp_dir("read");
        let file = root.join("session.jsonl");
        fs::write(
            &file,
            concat!(
                "not json\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Read\",\"input\":{\"path\":\"/a\"}}]}}\n",
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"bytes\"}]}}\n",
            ),
        )
        .expect("write fixture");

        let messages = read_transcript(&file, "claude").expect("read transcript");
        let roles: Vec<&str> = messages
            .iter()
            .map(|message| message.role.as_str())
            .collect();
        assert_eq!(roles, ["user", "tool"]);
        assert_eq!(messages[1].result.as_ref().unwrap(), "bytes");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unknown_engine_reports_not_found() {
        let error = load_session("qoder", "missing", Path::new("C:\\ws"), 200, None)
            .expect_err("unknown engine has no transcript");
        assert_eq!(error.code, crate::error::AgentChatErrorCode::NotFound);
    }

    #[test]
    fn limit_is_clamped_to_the_documented_maximum() {
        assert_eq!(clamp_page_limit(0), DEFAULT_PAGE_LIMIT);
        assert_eq!(clamp_page_limit(10_000), MAX_PAGE_LIMIT);
    }

    #[test]
    fn real_transcript_pages_without_duplicates() {
        let root = temp_dir("paging");
        let file = write_claude_session(&root, 6);
        assert!(fs::metadata(&file).expect("fixture exists").len() > 0);

        let all = read_transcript(&file, "claude").expect("read");
        assert_eq!(all.len(), 12);
        let first = page(&all, 5, None);
        assert_eq!(first.next_before, Some(7));
        let previous = page(&all, 5, first.next_before);
        let mut seqs: Vec<i64> = first.messages.iter().map(|message| message.seq).collect();
        seqs.extend(previous.messages.iter().map(|message| message.seq));
        let unique: std::collections::HashSet<i64> = seqs.iter().copied().collect();
        assert_eq!(unique.len(), seqs.len());

        fs::remove_dir_all(&root).ok();
    }
}
