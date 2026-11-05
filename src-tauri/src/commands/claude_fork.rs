//! Clone and fork Claude Code sessions — the history viewer's two write
//! operations, and the only place this app writes inside `~/.claude`.
//!
//! Both always write a **new** file: the id is a fresh uuid, so a copy can never
//! land on an existing session and the original is only ever read.
//!
//! * a **clone** is the whole file copied, so the branches the CLI left behind
//!   (a message rewound past, a compacted prefix) come with it;
//! * a **fork** keeps only the conversation up to one message, so the copy ends
//!   where the branch does and the next thing typed resumes it as a new branch.
//!
//! Either way the copied rows keep their original `uuid` / `parentUuid` links —
//! the conversation is replicated, not renumbered — and only `sessionId` is
//! swapped for the new one. That is what makes the result a session the CLI can
//! list and `--resume` like any other.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use crate::commands::claude_history::{
    conversation_upto, off_thread, projects_root, read_head_tail, record_origin, root_for,
    title_from_lines, validate_key, OriginRecord,
};

/// A session file this app just wrote.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    /// The new session's id, which is also its file name.
    pub session_id: String,
    /// The project directory it was written to.
    pub project: String,
    /// How many stored rows were carried over.
    pub lines: usize,
}

/// Copies a whole session to a new session id.
#[tauri::command]
pub async fn clone_claude_session(
    project: String,
    session_id: String,
    title: Option<String>,
) -> Result<NewSession, String> {
    off_thread(move || copy("clone", project, session_id, None, title)).await
}

/// Branches a session at one of its messages: the new session keeps the
/// conversation up to and including that message, and ends there.
#[tauri::command]
pub async fn fork_claude_session(
    project: String,
    session_id: String,
    fork_uuid: String,
    title: Option<String>,
) -> Result<NewSession, String> {
    off_thread(move || copy_at(project, session_id, fork_uuid, title)).await
}

fn copy_at(
    project: String,
    session_id: String,
    fork_uuid: String,
    title: Option<String>,
) -> Result<NewSession, String> {
    let fork_uuid = fork_uuid.trim();
    if fork_uuid.is_empty() {
        return Err("A fork needs the message it branches from.".to_string());
    }
    copy(
        "fork",
        project,
        session_id,
        Some(fork_uuid.to_string()),
        title,
    )
}

/// The shared body of both commands: read the source, keep the rows the kind
/// calls for, write them under a fresh id, and record where the copy came from.
fn copy(
    kind: &str,
    project: String,
    session_id: String,
    fork_uuid: Option<String>,
    title: Option<String>,
) -> Result<NewSession, String> {
    let project = validate_key(&project, "project")?;
    let id = validate_key(&session_id, "session")?;
    let dir = projects_root().join(&project);
    let source = dir.join(format!("{id}.jsonl"));
    let rows = read_rows(&source)?;

    let rows = match fork_uuid.as_deref() {
        Some(fork_uuid) => {
            let kept: HashSet<String> = {
                let values: Vec<&serde_json::Value> = rows.iter().filter_map(row_value).collect();
                conversation_upto(values, fork_uuid)
                    .ok_or("That message is not part of this session's conversation.")?
                    .into_iter()
                    .collect()
            };
            // Rows outside the conversation (titles, summaries) carry no uuid and
            // are kept; a message the conversation does not walk is one the CLI
            // rewound past, and dropping it is what makes this a fork.
            rows.into_iter()
                .filter(|row| match row {
                    Row::Json(value) => value
                        .get("uuid")
                        .and_then(|uuid| uuid.as_str())
                        .map(|uuid| kept.contains(uuid))
                        .unwrap_or(true),
                    Row::Raw(_) => true,
                })
                .collect()
        }
        None => rows,
    };

    let marker = if kind == "fork" { "branch" } else { "copy" };
    let label = resolve_label(&title, &source, marker);
    // The copy is filed under the conversation the whole family came from, not
    // under the one it was taken from, so forking a fork stays in one picture.
    let (root_session_id, root_project) = root_for(&id, &project);
    let new_id = uuid::Uuid::new_v4().to_string();
    let lines = rows.len();
    write_session(&dir, &new_id, &rows, &label)?;
    record_origin(
        &root_session_id,
        &root_project,
        &OriginRecord {
            kind: kind.to_string(),
            session_id: new_id.clone(),
            title: label,
            project: project.clone(),
            source_project: project.clone(),
            source_session_id: id,
            fork_uuid,
            created_ms: now_ms(),
        },
    );

    Ok(NewSession {
        session_id: new_id,
        project,
        lines,
    })
}

/// One stored line: parsed when it is valid JSON, kept as text when it is not.
enum Row {
    Json(serde_json::Value),
    Raw(String),
}

fn row_value(row: &Row) -> Option<&serde_json::Value> {
    match row {
        Row::Json(value) => Some(value),
        Row::Raw(_) => None,
    }
}

/// Every line of a session file. Session files are UTF-8; a stray byte is
/// replaced rather than failing the copy, and a line that does not parse is
/// carried over as text instead of being dropped.
fn read_rows(path: &Path) -> Result<Vec<Row>, String> {
    let bytes =
        std::fs::read(path).map_err(|error| format!("Could not read the session file: {error}"))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();

    let mut rows = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(value) => rows.push(Row::Json(value)),
            Err(_) => rows.push(Row::Raw(trimmed.to_string())),
        }
    }
    Ok(rows)
}

/// Writes the rows as a new session file, atomically: it appears whole or not at
/// all, so an interrupted write cannot leave half a session behind.
///
/// The copy is also named with a `custom-title` row, the way the CLI's own
/// rename does, so it is not listed under the name of the session it came from.
fn write_session(dir: &Path, new_id: &str, rows: &[Row], label: &str) -> Result<(), String> {
    let target = dir.join(format!("{new_id}.jsonl"));
    if target.exists() {
        return Err("A session with that id already exists.".to_string());
    }

    let mut text = String::new();
    for row in rows {
        match row {
            Row::Json(value) => {
                let mut value = value.clone();
                if let Some(map) = value.as_object_mut() {
                    map.insert(
                        "sessionId".to_string(),
                        serde_json::Value::String(new_id.to_string()),
                    );
                }
                text.push_str(&value.to_string());
            }
            // A row that never parsed has no `sessionId` to swap.
            Row::Raw(line) => text.push_str(line),
        }
        text.push('\n');
    }
    text.push_str(
        &serde_json::json!({
            "type": "custom-title",
            "customTitle": label,
            "sessionId": new_id,
        })
        .to_string(),
    );
    text.push('\n');

    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Could not create the session directory: {error}"))?;
    let temp = dir.join(format!(".{new_id}.jsonl.tmp"));
    std::fs::write(&temp, text.as_bytes())
        .map_err(|error| format!("Could not write the session: {error}"))?;
    std::fs::rename(&temp, &target).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("Could not write the session: {error}")
    })
}

/// The name to give a copy: what the caller asked for, else the source's own
/// title with a marker, so a copy is never listed as the source.
fn resolve_label(requested: &Option<String>, source: &Path, marker: &str) -> String {
    if let Some(title) = requested
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        return title.to_string();
    }
    let (head, tail) = read_head_tail(source);
    let base = title_from_lines(&head, &tail)
        .map(|entry| entry.0)
        .unwrap_or_else(|| "Session".to_string());
    format!("{base} ({marker})")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}