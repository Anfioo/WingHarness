//! Claude and Codex session discovery.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/desktop-cc-gui.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! Both CLIs keep their transcripts as plain JSONL under a per-user home.
//! Discovery only enumerates those files and peeks at their head; it never
//! writes, renames or deletes anything.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::claude_encode_project_path;

/// A transcript file found on disk, with the identity peeked from its head.
#[derive(Clone, Debug)]
pub(crate) struct Candidate {
    pub engine: &'static str,
    pub session_id: String,
    pub file_path: PathBuf,
    pub workspace_path: String,
    pub size: i64,
    pub mtime_ms: i64,
}

/// A Codex `session_meta` first line can carry the full base instructions, so
/// the window is bounded by bytes first and lines second.
const HEAD_LIMIT_BYTES: u64 = 1024 * 1024;
const HEAD_LIMIT_LINES: usize = 4;
/// Codex nests rollouts as `sessions/YYYY/MM/DD/`; the guard only exists so a
/// directory symlink loop cannot hang a scan.
const MAX_CODEX_DEPTH: usize = 16;

/// Every candidate for the requested engines. Unknown engine ids yield none.
pub(crate) fn candidates(engine: Option<&str>, workspace: Option<&Path>) -> Vec<Candidate> {
    match engine {
        Some("claude") => claude_candidates(workspace),
        Some("codex") => codex_candidates(),
        None => {
            let mut out = claude_candidates(workspace);
            out.extend(codex_candidates());
            out
        }
        Some(_) => Vec::new(),
    }
}

// ==================== Claude ====================

pub(crate) fn claude_candidates(workspace: Option<&Path>) -> Vec<Candidate> {
    claude_candidates_in(&claude_projects_root(), workspace)
}

pub(crate) fn claude_candidates_in(
    projects_root: &Path,
    workspace: Option<&Path>,
) -> Vec<Candidate> {
    let dirs = match workspace {
        Some(workspace) => claude_project_dirs(projects_root, workspace),
        None => match std::fs::read_dir(projects_root) {
            Ok(entries) => entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect(),
            Err(_) => Vec::new(),
        },
    };

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") || !path.is_file() {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            // `history.jsonl` is the CLI's prompt history, not a transcript.
            if stem == "history" || !seen.insert(stem.to_string()) {
                continue;
            }
            let Some((size, mtime_ms)) = file_signature(&path) else {
                continue;
            };
            out.push(Candidate {
                engine: "claude",
                session_id: stem.to_string(),
                workspace_path: head_cwd(&path)
                    .or_else(|| dir_name(&dir))
                    .unwrap_or_default(),
                file_path: path,
                size,
                mtime_ms,
            });
        }
    }
    out
}

/// Claude stamps every transcript line with the cwd it ran in; the first one
/// wins. Files often start with queue/attachment lines, so the head window is
/// scanned rather than just the first line. The project directory name is a
/// lossy encoding, hence only a fallback.
fn head_cwd(path: &Path) -> Option<String> {
    head_json_lines(path, HEAD_LIMIT_BYTES, HEAD_LIMIT_LINES)
        .iter()
        .find_map(|line| non_empty_str(line.get("cwd")))
}

fn dir_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
}

// ==================== Codex ====================

pub(crate) fn codex_candidates() -> Vec<Candidate> {
    codex_candidates_in(&codex_home())
}

pub(crate) fn codex_candidates_in(home: &Path) -> Vec<Candidate> {
    let mut files = Vec::new();
    for root in [home.join("sessions"), home.join("archived_sessions")] {
        collect_rollouts(&root, 0, &mut files);
    }

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for path in files {
        let Some((session_id, workspace_path)) = identify_codex_head(&path) else {
            continue;
        };
        if !seen.insert(session_id.clone()) {
            continue;
        }
        let Some((size, mtime_ms)) = file_signature(&path) else {
            continue;
        };
        out.push(Candidate {
            engine: "codex",
            session_id,
            file_path: path,
            workspace_path,
            size,
            mtime_ms,
        });
    }
    out
}

fn collect_rollouts(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_CODEX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, depth + 1, out);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

/// Session id and cwd live in the `session_meta` head line. Subagent rollouts
/// reuse the parent's first user line as a title, so listing them next to the
/// parent looks like duplicate conversations.
fn identify_codex_head(path: &Path) -> Option<(String, String)> {
    for head in head_json_lines(path, HEAD_LIMIT_BYTES, HEAD_LIMIT_LINES) {
        if head.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let Some(payload) = head.get("payload") else {
            continue;
        };
        if is_subagent_source(payload.get("source"))
            || payload.get("thread_source").and_then(Value::as_str) == Some("subagent")
        {
            return None;
        }
        let id = non_empty_str(payload.get("id"))
            .or_else(|| non_empty_str(payload.get("session_id")))?;
        let cwd = non_empty_str(payload.get("cwd"))?;
        return Some((id, cwd));
    }
    None
}

fn is_subagent_source(source: Option<&Value>) -> bool {
    source
        .map(|source| {
            source
                .get("subagent")
                .map(|value| value.is_object() || value.as_bool() == Some(true))
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

// ==================== Shared helpers ====================

pub(crate) fn head_json_lines(path: &Path, max_bytes: u64, max_lines: usize) -> Vec<Value> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let mut reader = BufReader::new(file.take(max_bytes));
    let mut out = Vec::with_capacity(max_lines.min(8));
    let mut buffer = Vec::new();
    // The byte cap can leave the last segment mid-line; a partial line never
    // parses and is skipped by the JSON step.
    for _ in 0..max_lines {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(text) = std::str::from_utf8(&buffer) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            out.push(value);
        }
    }
    out
}

fn file_signature(path: &Path) -> Option<(i64, i64)> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    Some((metadata.len() as i64, mtime_ms))
}

fn non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn claude_projects_root() -> PathBuf {
    cli_home("CLAUDE_CONFIG_DIR", ".claude").join("projects")
}

fn codex_home() -> PathBuf {
    cli_home("CODEX_HOME", ".codex")
}

/// The CLIs honor their own home override; pinning `~/.claude` would lose the
/// history of users who relocate it.
fn cli_home(env_key: &str, default_dir: &str) -> PathBuf {
    if let Some(path) = std::env::var_os(env_key).filter(|value| !value.is_empty()) {
        return PathBuf::from(path);
    }
    home_dir().join(default_dir)
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// Candidate `<projects>/<encoded>` dirs for one workspace. Windows terminals
/// disagree on drive-letter case, slash direction and trailing separators, so
/// the raw spelling, a trimmed one and the canonicalized path are all tried.
fn claude_project_dirs(base: &Path, workspace: &Path) -> Vec<PathBuf> {
    fn push(out: &mut Vec<PathBuf>, seen: &mut HashSet<String>, base: &Path, spelling: &str) {
        if !spelling.is_empty() && seen.insert(spelling.to_string()) {
            out.push(base.join(claude_encode_project_path(spelling)));
        }
    }

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let raw = workspace.to_string_lossy().to_string();
    let trimmed = raw.trim_end_matches(['/', '\\']).to_string();
    push(&mut out, &mut seen, base, &raw);
    push(&mut out, &mut seen, base, &trimmed);
    for spelling in [&raw, &trimmed] {
        if let Ok(canonical) = std::fs::canonicalize(spelling) {
            let canonical = canonical.to_string_lossy().to_string();
            let canonical = strip_verbatim_prefix(&canonical);
            push(&mut out, &mut seen, base, canonical);
        }
    }
    out
}

/// Strip the `\\?\` verbatim prefix Windows `canonicalize` adds; the CLI
/// encodes the plain path.
fn strip_verbatim_prefix(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "agent-chat-discovery-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn claude_candidates_read_cwd_and_skip_history() {
        let root = temp_dir("claude");
        let project = root.join("E--ws-agent");
        fs::create_dir_all(&project).expect("create project dir");
        fs::write(
            project.join("s1.jsonl"),
            concat!(
                "{\"type\":\"queue-operation\",\"operation\":\"enqueue\"}\n",
                "{\"type\":\"user\",\"cwd\":\"E:\\\\ws-agent\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
            ),
        )
        .expect("write session");
        fs::write(project.join("history.jsonl"), "{}\n").expect("write history");

        let found = claude_candidates_in(&root, None);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].session_id, "s1");
        assert_eq!(found[0].workspace_path, "E:\\ws-agent");
        assert_eq!(found[0].engine, "claude");

        let filtered = claude_candidates_in(&root, Some(Path::new("E:\\ws-agent")));
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].session_id, "s1");

        let missing = claude_candidates_in(&root, Some(Path::new("E:\\other")));
        assert!(missing.is_empty());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn claude_candidates_fall_back_to_project_dir_name() {
        let root = temp_dir("claude-fallback");
        let project = root.join("E--ws-agent");
        fs::create_dir_all(&project).expect("create project dir");
        fs::write(project.join("s2.jsonl"), "{}\n").expect("write session");

        let found = claude_candidates_in(&root, None);
        assert_eq!(found[0].workspace_path, "E--ws-agent");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn codex_candidates_read_session_meta_and_skip_subagents() {
        let home = temp_dir("codex");
        let day = home.join("sessions").join("2026").join("01").join("02");
        fs::create_dir_all(&day).expect("create day dir");
        fs::write(
            day.join("rollout-parent.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"sess-parent\",\"cwd\":\"C:\\\\ws\",\"source\":\"vscode\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\"}}\n",
            ),
        )
        .expect("write rollout");
        fs::write(
            day.join("rollout-child.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"sess-child\",\"cwd\":\"C:\\\\ws\",\"source\":{\"subagent\":{\"other\":\"guardian\"}}}}\n",
            ),
        )
        .expect("write subagent rollout");
        fs::write(day.join("rollout-broken.jsonl"), "not json\n").expect("write broken rollout");

        let archived = home.join("archived_sessions");
        fs::create_dir_all(&archived).expect("create archived dir");
        fs::write(
            archived.join("rollout-old.jsonl"),
            "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"sess-old\",\"cwd\":\"D:\\\\old\"}}\n",
        )
        .expect("write archived rollout");

        let found = codex_candidates_in(&home);
        let ids: Vec<&str> = found.iter().map(|item| item.session_id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"sess-parent"));
        assert!(ids.contains(&"sess-old"));
        assert!(!ids.contains(&"sess-child"));
        let parent = found
            .iter()
            .find(|item| item.session_id == "sess-parent")
            .expect("parent present");
        assert_eq!(parent.workspace_path, "C:\\ws");

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn head_reader_stops_at_the_line_cap() {
        let root = temp_dir("head");
        let file = root.join("many.jsonl");
        let mut body = String::new();
        for index in 0..50 {
            body.push_str(&format!("{{\"index\":{index}}}\n"));
        }
        fs::write(&file, body).expect("write head fixture");

        let lines = head_json_lines(&file, HEAD_LIMIT_BYTES, 4);
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[3]["index"], 3);

        fs::remove_dir_all(&root).ok();
    }
}
