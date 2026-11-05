//! Read Claude Code's own session history off disk.
//!
//! Behaviour port of jetbrains-cc-gui (MIT),
//! https://github.com/zhukunpenglinyutong/jetbrains-cc-gui. Copyright (c) 2026
//! zhukunpenglinyutong. See `THIRD_PARTY_NOTICES.md`.
//!
//! The CLI keeps one JSONL file per session at
//! `<home>/.claude/projects/<slug>/<sessionId>.jsonl`, where `<slug>` is the
//! session's working directory with every non-alphanumeric character replaced by
//! `-`. There is no index, so listing is a directory scan and the full record set
//! is only read when a session is opened.
//!
//! Nothing is addressed by path: the directory comes from a working directory or
//! from a project name this module itself derived, and every name a caller
//! supplies is checked, so the frontend cannot ask it to read a file outside the
//! history tree. Writing a copy of a session lives in [`super::claude_fork`].
//!
//! [`super::claude_fork`] also writes this module's own lineage files
//! (`<config>/.claude-history/forks/<root>-fork.json`, one per conversation
//! family), which is what [`SessionOrigin`], [`SessionBranch`] and the workflow
//! canvas are read out of.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Bytes read from each end of a session file to build a list entry. The middle
/// of a large file is skipped: a title and a timestamp never need more than this.
/// This is the CLI's own `LITE_READ_BUF_SIZE`, so the list shows what the CLI
/// (and the JetBrains client) shows for the same file.
const LIST_WINDOW_BYTES: u64 = 64 * 1024;
/// Upper bound on the records returned for one session; newest are kept.
const LOAD_MAX_RECORDS: usize = 2000;
/// Upper bound on the parsed lines held while building the chain. Most rows carry
/// no records at all, so the record cap alone would let a bookkeeping-heavy file
/// grow without limit.
const LOAD_MAX_LINES: usize = 20_000;
/// Longest first prompt kept for a tooltip: the reference caps it at 200
/// characters plus an ellipsis. Titles themselves are stored in full and clamped
/// to two lines by the drawer, so they are never cut here.
const FIRST_PROMPT_MAX_CHARS: usize = 200;
/// Longest text carried for one workflow node. The workflow canvas draws the
/// shape of a conversation rather than reading it, so a turn travels clipped;
/// the transcript itself stays on disk and is read by the history viewer.
const WORKFLOW_TEXT_MAX_CHARS: usize = 600;
/// Most turns carried per session, newest kept. A canvas is drawn to show where
/// a conversation branched, and no view can show more turns than this at once.
const WORKFLOW_MAX_TURNS: usize = 500;

/// One row in the history drawer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    /// First real user message, for a fuller tooltip than the title.
    pub preview: String,
    pub modified_ms: i64,
    /// Present only when this app made the session, in which case the drawer
    /// says which conversation it was copied from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<SessionOrigin>,
}

/// Where a session came from, for the copies this app writes.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionOrigin {
    /// `clone` for a copy of the whole session, `fork` for a branch taken at one
    /// of its messages.
    pub kind: String,
    pub source_session_id: String,
    pub source_project: String,
    /// The message the branch was taken at. Absent for a clone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_uuid: Option<String>,
    /// The name the copy was given.
    pub title: String,
}

/// A session copied out of the one being viewed: one message becoming two.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionBranch {
    pub session_id: String,
    pub project: String,
    pub title: String,
    /// The message this branch leaves from, when it is a fork.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_uuid: Option<String>,
    pub created_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListView {
    pub sessions: Vec<SessionSummary>,
    /// The directory scanned, so the UI can explain an empty list.
    pub dir: String,
}

/// One project directory under `~/.claude/projects`, as the viewer's navigator
/// lists it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    /// The directory name, which is what the other project commands take.
    pub slug: String,
    /// The working directory the sessions ran in, when one is recorded;
    /// otherwise the slug, which is that path with its separators flattened.
    pub path: String,
    pub session_count: usize,
    pub modified_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListView {
    pub projects: Vec<ProjectSummary>,
    /// The directory scanned, so the UI can explain an empty list.
    pub root: String,
}

/// One project's sessions, loaded when the navigator expands it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionView {
    pub project: String,
    /// The working directory the sessions ran in, for the panel's header.
    pub path: String,
    pub sessions: Vec<SessionSummary>,
}

/// One transcript entry, neutral with respect to the frontend's item model.
///
/// `kind` is `user` / `assistant` / `thinking` / `tool`. A tool result is not a
/// record of its own: it is carried on the `tool` record it belongs to, in
/// `resultContent` (raw, so the frontend can render it the same way it renders a
/// live result) and `isError`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub kind: String,
    pub uuid: String,
    pub text: String,
    pub parent_tool_use_id: Option<String>,
    /// The row's own ISO-8601 timestamp, for the viewer's node captions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_content: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedSession {
    pub session_id: String,
    pub records: Vec<HistoryRecord>,
    /// Sessions copied out of this one, so the viewer can show the message a
    /// branch leaves from as two.
    pub branches: Vec<SessionBranch>,
}

/// One turn of a conversation as the workflow canvas draws it: what the user
/// asked, and the last thing the CLI said before the next question.
///
/// The message in between — the thinking and the tool calls — is not carried:
/// the canvas shows the shape of a conversation, not its plumbing.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTurn {
    /// The message that opened the turn. Absent for a conversation that begins
    /// with the CLI speaking.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_uuid: Option<String>,
    pub question: String,
    /// The CLI's last message in the turn. A fork taken here branches from it,
    /// and it is the id a copy of this turn shares with its source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_uuid: Option<String>,
    pub answer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
}

/// One conversation taking part in a workflow: a session a fork was taken from,
/// or a fork itself.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSession {
    pub session_id: String,
    pub project: String,
    /// The name the session is listed under.
    pub title: String,
    /// The conversation this one was forked from. Equal to the session's own
    /// names for a conversation nothing was forked from.
    pub source_session_id: String,
    pub source_project: String,
    /// The message this fork leaves from. Absent on the conversation it came
    /// from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_uuid: Option<String>,
    /// When the fork was made, or 0 for a conversation that is not one.
    pub created_ms: i64,
    pub modified_ms: i64,
    pub turns: Vec<WorkflowTurn>,
    /// Set when the session file could not be read, so the canvas can say why a
    /// chain stops there instead of dropping it silently.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One conversation family, as the workflow page's navigator lists it: the
/// session everything was copied from, and how many copies hang off it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilySummary {
    pub root_session_id: String,
    pub root_project: String,
    /// The session's own name, read the way the history navigator reads one.
    pub title: String,
    /// When the session itself last ran, and when its newest copy was made.
    pub modified_ms: i64,
    pub last_ms: i64,
    pub copies: usize,
    pub forks: usize,
    pub clones: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyListView {
    pub families: Vec<FamilySummary>,
    /// The directory the lineage files live in, so the page can say where they
    /// are and explain an empty list.
    pub store: String,
}

/// One conversation family, with the turns a canvas needs to draw it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyGraph {
    /// The session the family is named after, so the canvas can say whose it is.
    pub root_session_id: String,
    /// The root conversation first, then each copy in the order it was made.
    pub sessions: Vec<WorkflowSession>,
    /// The lineage file this family was read out of.
    pub store: String,
}

/// Runs a history read on the blocking pool.
///
/// Every command below walks `~/.claude/projects` and parses JSONL. A
/// synchronous command runs on the thread that handles IPC, so a scan froze the
/// whole webview — sidebar included — until it finished.
pub(crate) async fn off_thread<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("History task failed: {error}"))?
}

/// Lists the stored sessions of one working directory, newest first.
///
/// A missing history directory is not an error — it means this directory has no
/// sessions yet, and the UI shows an empty state rather than a failure.
#[tauri::command]
pub async fn list_claude_sessions(cwd: String) -> Result<SessionListView, String> {
    off_thread(move || read_session_list(&cwd)).await
}

fn read_session_list(cwd: &str) -> Result<SessionListView, String> {
    let dir = projects_root().join(slug(cwd));
    let origins = origin_index(&all_copies());
    Ok(SessionListView {
        sessions: list_sessions_in(&dir, &origins),
        dir: dir.display().to_string(),
    })
}

/// Lists the project directories that hold sessions, newest activity first.
///
/// Only the directory entries are read here — a project's sessions are loaded
/// when the navigator expands it, so opening the viewer does not parse every
/// conversation ever recorded.
#[tauri::command]
pub async fn list_claude_projects() -> Result<ProjectListView, String> {
    off_thread(read_project_list).await
}

fn read_project_list() -> Result<ProjectListView, String> {
    let root = projects_root();
    let mut projects = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some((session_count, modified_ms, newest)) = project_session_stats(&dir) else {
                continue;
            };
            projects.push(ProjectSummary {
                path: project_cwd(&dir, &newest).unwrap_or_else(|| slug.clone()),
                session_count,
                modified_ms,
                slug,
            });
        }
    }

    projects.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(ProjectListView {
        projects,
        root: root.display().to_string(),
    })
}

/// Lists one project's sessions, newest first. `project` is a directory name
/// under `~/.claude/projects`, not a path.
#[tauri::command]
pub async fn list_claude_project_sessions(project: String) -> Result<ProjectSessionView, String> {
    off_thread(move || read_project_sessions(&project)).await
}

fn read_project_sessions(project: &str) -> Result<ProjectSessionView, String> {
    let project = validate_key(project, "project")?;
    let dir = projects_root().join(&project);
    let origins = origin_index(&all_copies());
    let sessions = list_sessions_in(&dir, &origins);
    let path = sessions
        .first()
        .and_then(|session| project_cwd(&dir, &session.id))
        .unwrap_or_else(|| project.clone());
    Ok(ProjectSessionView {
        path,
        project,
        sessions,
    })
}

/// The conversation families this app has recorded, newest activity first.
///
/// A family is a conversation plus every clone and fork taken from it, however
/// deep: the lineage files below are this app's own data and are what decides
/// the set, so a conversation nothing was ever copied from is listed nowhere.
/// Only those small files are read here; a family's turns are read when it is
/// opened.
#[tauri::command]
pub async fn list_claude_families() -> Result<FamilyListView, String> {
    off_thread(read_family_list).await
}

fn read_family_list() -> Result<FamilyListView, String> {
    let mut families: Vec<FamilySummary> = families()
        .into_iter()
        .map(|family| {
            let path = projects_root()
                .join(&family.root_project)
                .join(format!("{}.jsonl", family.root_session_id));
            let (head, tail) = read_head_tail(&path);
            let forks = family
                .copies
                .iter()
                .filter(|copy| copy.kind == "fork")
                .count();
            FamilySummary {
                title: title_from_lines(&head, &tail)
                    .map(|entry| entry.0)
                    .unwrap_or_else(|| family.root_session_id.clone()),
                modified_ms: modified_ms(&path),
                last_ms: family
                    .copies
                    .iter()
                    .map(|copy| copy.created_ms)
                    .max()
                    .unwrap_or(0),
                copies: family.copies.len(),
                forks,
                clones: family.copies.len() - forks,
                root_session_id: family.root_session_id,
                root_project: family.root_project,
            }
        })
        .collect();

    families.sort_by(|a, b| {
        b.last_ms
            .max(b.modified_ms)
            .cmp(&a.last_ms.max(a.modified_ms))
    });
    Ok(FamilyListView {
        families,
        store: family_dir().display().to_string(),
    })
}

/// One family's conversations, with the turns a canvas draws them by.
///
/// Any session of the family names it: a copy is resolved up to the root it
/// belongs to, so opening a fork shows the picture its fork was taken in rather
/// than a branch with no trunk. A session nothing was copied from comes back as
/// a family of one, which the canvas draws as a single line.
///
/// Nothing here fails for a session that has gone missing: its entry comes back
/// with the reason, and the chain simply stops there.
#[tauri::command]
pub async fn load_claude_family(
    project: String,
    session_id: String,
) -> Result<FamilyGraph, String> {
    off_thread(move || read_family_graph(&project, &session_id)).await
}

fn read_family_graph(project: &str, session_id: &str) -> Result<FamilyGraph, String> {
    let project = validate_key(project, "project")?;
    let id = validate_key(session_id, "session")?;

    let (root_session_id, root_project) = root_for(&id, &project);
    let mut sessions = vec![read_workflow_session(&root_project, &root_session_id, None)];

    // The root is the conversation everything else is measured against, so it is
    // read first; the copies follow in the order they were made, which is the
    // order the canvas draws their lines in.
    if let Some(family) = read_family(&root_session_id) {
        let mut copies = family.copies;
        copies.sort_by(|a, b| a.created_ms.cmp(&b.created_ms));
        for copy in &copies {
            sessions.push(read_workflow_session(&copy.project, &copy.session_id, Some(copy)));
        }
    }

    Ok(FamilyGraph {
        store: family_path(&root_session_id).display().to_string(),
        root_session_id,
        sessions,
    })
}

/// One conversation of a family: its lineage from the family's file, plus its
/// turns read off disk. Either name is already a plain key — every pair came out
/// of this app's own lineage files rather than from a caller.
fn read_workflow_session(
    project: &str,
    session_id: &str,
    fork: Option<&OriginRecord>,
) -> WorkflowSession {
    let path = projects_root()
        .join(project)
        .join(format!("{session_id}.jsonl"));

    // A conversation nothing was copied from has no lineage entry: its own name
    // stands in, and its title is read the same way the navigator reads one.
    let (title, source_project, source_session_id, fork_uuid, created_ms) = match fork {
        Some(record) => (
            record.title.clone(),
            record.source_project.clone(),
            record.source_session_id.clone(),
            record.fork_uuid.clone(),
            record.created_ms,
        ),
        None => {
            let (head, tail) = read_head_tail(&path);
            (
                title_from_lines(&head, &tail)
                    .map(|entry| entry.0)
                    .unwrap_or_else(|| session_id.to_string()),
                project.to_string(),
                session_id.to_string(),
                None,
                0,
            )
        }
    };

    let (turns, error) = match read_ordered_session(&path) {
        Ok((lines, _)) => (turns_of(&lines), None),
        Err(error) => (Vec::new(), Some(error)),
    };

    WorkflowSession {
        session_id: session_id.to_string(),
        project: project.to_string(),
        title,
        source_project,
        source_session_id,
        fork_uuid,
        created_ms,
        modified_ms: modified_ms(&path),
        turns,
        error,
    }
}

/// One conversation's turns.
///
/// A user message opens a turn and the CLI's last message before the next
/// question ends it, which is exactly the message a fork branches from. Text the
/// CLI sent mid-turn — between two tool calls, or on the way to another one — is
/// the newest message's text until a later message replaces it, so a turn reads
/// as the question and where the reply landed.
fn turns_of(lines: &[Line]) -> Vec<WorkflowTurn> {
    let mut turns: Vec<WorkflowTurn> = Vec::new();

    for line in lines {
        for record in &line.records {
            match record.kind.as_str() {
                "user" if !record.text.trim().is_empty() => turns.push(WorkflowTurn {
                    question_uuid: Some(record.uuid.clone()),
                    question: clip(&record.text),
                    answer_uuid: None,
                    answer: String::new(),
                    timestamp: record.timestamp.clone(),
                }),
                "assistant" if !record.text.trim().is_empty() => {
                    // A conversation can open with the CLI speaking; that reply
                    // still needs a turn to belong to.
                    if turns.is_empty() {
                        turns.push(WorkflowTurn {
                            question_uuid: None,
                            question: String::new(),
                            answer_uuid: None,
                            answer: String::new(),
                            timestamp: record.timestamp.clone(),
                        });
                    }
                    let turn = turns.last_mut().expect("a turn was just pushed");
                    // The first text of a message stands for the whole message,
                    // the way the node view's card does.
                    if turn.answer_uuid.as_deref() != Some(record.uuid.as_str()) {
                        turn.answer_uuid = Some(record.uuid.clone());
                        turn.answer = clip(&record.text);
                    }
                }
                _ => {}
            }
        }
    }

    if turns.len() > WORKFLOW_MAX_TURNS {
        turns.drain(..turns.len() - WORKFLOW_MAX_TURNS);
    }
    turns
}

/// A turn's text, clipped to what a node card can hold.
fn clip(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= WORKFLOW_TEXT_MAX_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(WORKFLOW_TEXT_MAX_CHARS).collect();
    format!("{}…", head.trim_end())
}
/// Every listable session in one `~/.claude/projects/<slug>` directory.
fn list_sessions_in(dir: &Path, origins: &HashMap<String, SessionOrigin>) -> Vec<SessionSummary> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_session_file(&path) {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let (head, tail) = read_head_tail(&path);
        // A sub-agent's file has the same shape as a session but is never shown
        // as one; its first record carries the marker.
        if is_sidechain(&head) {
            continue;
        }
        let Some((title, preview)) = title_from_lines(&head, &tail) else {
            continue;
        };
        sessions.push(SessionSummary {
            id: id.to_string(),
            title,
            preview,
            modified_ms: modified_ms(&path),
            origin: origins.get(id).cloned(),
        });
    }

    sessions.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    sessions
}

/// How many sessions a project directory holds, when its newest one changed, and
/// that session's id.
///
/// The project row only needs a count and a freshness stamp, so this reads the
/// directory entries instead of every session file. Titles, previews and lineage
/// are read when the project is expanded; doing that work here is what made the
/// first request of the viewer slow.
fn project_session_stats(dir: &Path) -> Option<(usize, i64, String)> {
    let mut count = 0usize;
    let mut newest: Option<(i64, String)> = None;

    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !is_session_file(&path) {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        count += 1;
        let modified = modified_ms(&path);
        match &newest {
            Some((best, _)) if *best >= modified => {}
            _ => newest = Some((modified, id.to_string())),
        }
    }

    let (modified, newest) = newest?;
    Some((count, modified, newest))
}

/// The working directory a project's sessions ran in, read off the newest one.
///
/// The directory name is that path with its separators flattened, which is
/// unreadable as a label; every message row carries the real `cwd` it was
/// written from, and the head window holds plenty of them.
fn project_cwd(dir: &Path, newest_session_id: &str) -> Option<String> {
    let (head, _) = read_head_tail(&dir.join(format!("{newest_session_id}.jsonl")));
    head.iter().find_map(|line| {
        if !line.contains("\"cwd\"") {
            return None;
        }
        let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
        json_str_field(&value, "cwd")
    })
}

/// Reads one session's transcript, ordered as the conversation actually ran.
///
/// Returns an error only when the file cannot be opened (it was deleted between
/// listing and opening); a malformed line is skipped rather than failing the read.
#[tauri::command]
pub async fn load_claude_session(cwd: String, session_id: String) -> Result<LoadedSession, String> {
    off_thread(move || read_session(&cwd, &session_id)).await
}

fn read_session(cwd: &str, session_id: &str) -> Result<LoadedSession, String> {
    let id = validate_key(session_id, "session")?;
    let project = slug(cwd);
    let path = projects_root().join(&project).join(format!("{id}.jsonl"));
    let mut session = load_session_file(&path, &id)?;
    session.branches = branches_for(&project, &id);
    Ok(session)
}

/// Reads one session of a project named by its directory, which is what the
/// viewer navigates by.
#[tauri::command]
pub async fn load_claude_project_session(
    project: String,
    session_id: String,
) -> Result<LoadedSession, String> {
    off_thread(move || read_project_session(&project, &session_id)).await
}

fn read_project_session(project: &str, session_id: &str) -> Result<LoadedSession, String> {
    let project = validate_key(project, "project")?;
    let id = validate_key(session_id, "session")?;
    let path = projects_root().join(&project).join(format!("{id}.jsonl"));
    let mut session = load_session_file(&path, &id)?;
    session.branches = branches_for(&project, &id);
    Ok(session)
}

/// The session file itself: every record, in the order the conversation ran.
fn load_session_file(path: &Path, fallback_id: &str) -> Result<LoadedSession, String> {
    let (ordered, stored_session_id) = read_ordered_session(path)?;

    // Tool results live in their own `user` records; collect them by tool-use id
    // so each can be attached to the card it belongs to.
    let mut results: HashMap<String, (serde_json::Value, bool)> = HashMap::new();
    for line in &ordered {
        for (tool_use_id, content, is_error) in &line.results {
            results.insert(tool_use_id.clone(), (content.clone(), *is_error));
        }
    }

    let mut records = Vec::new();
    for line in ordered {
        for mut record in line.records {
            if record.kind == "tool" {
                if let Some(tool_use_id) = record.tool_use_id.as_deref() {
                    if let Some((content, is_error)) = results.get(tool_use_id) {
                        record.result_content = Some(content.clone());
                        record.is_error = Some(*is_error);
                    }
                }
            }
            records.push(record);
        }
    }

    Ok(LoadedSession {
        session_id: stored_session_id.unwrap_or_else(|| fallback_id.to_string()),
        records,
        branches: Vec::new(),
    })
}

/// A session file's lines, ordered the way the conversation ran, plus the
/// `sessionId` the file itself carries.
///
/// Streamed line by line, never read whole, and capped the same way the viewer
/// caps it: a long session is many MB, and only the newest `LOAD_MAX_RECORDS`
/// are kept either way.
fn read_ordered_session(path: &Path) -> Result<(Vec<Line>, Option<String>), String> {
    let file =
        File::open(path).map_err(|error| format!("Could not open the session file: {error}"))?;

    let mut lines: VecDeque<Line> = VecDeque::new();
    let mut record_count = 0usize;
    let mut stored_session_id: Option<String> = None;

    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if stored_session_id.is_none() {
            stored_session_id = value
                .get("sessionId")
                .and_then(|value| value.as_str())
                .map(str::to_owned);
        }
        let Some(parsed) = parse_line(&value) else {
            continue;
        };
        record_count += parsed.records.len();
        lines.push_back(parsed);
        while lines.len() > 1 && (record_count > LOAD_MAX_RECORDS || lines.len() > LOAD_MAX_LINES) {
            match lines.pop_front() {
                Some(dropped) => record_count -= dropped.records.len(),
                None => break,
            }
        }
    }

    Ok((
        select_conversation_chain(lines.into_iter().collect()),
        stored_session_id,
    ))
}

/// Checks a name a caller supplied: a key that can never leave the directory it
/// is joined onto, whatever the frontend sends.
pub(crate) fn validate_key(value: &str, what: &str) -> Result<String, String> {
    let key = value.trim();
    if key.is_empty() || key.contains(['/', '\\', ':']) || key == "." || key == ".." {
        return Err(format!("Invalid {what} id."));
    }
    Ok(key.to_string())
}

/// The sessions copied out of one session, oldest first.
fn branches_for(project: &str, session_id: &str) -> Vec<SessionBranch> {
    let mut branches: Vec<SessionBranch> = all_copies()
        .into_iter()
        .filter(|record| record.source_project == project && record.source_session_id == session_id)
        .map(|record| SessionBranch {
            session_id: record.session_id,
            project: record.project,
            title: record.title,
            fork_uuid: record.fork_uuid,
            created_ms: record.created_ms,
        })
        .collect();
    branches.sort_by(|a, b| a.created_ms.cmp(&b.created_ms));
    branches
}

/// One parsed JSONL line: the records it carried, the tool results it held, and
/// the `uuid`/`parentUuid` links the ordering pass walks.
///
/// A line that yields no records is still kept as long as it has a `uuid`. The CLI
/// interleaves bookkeeping rows (`system`, `attachment`) into the parent chain, so
/// dropping them would cut the walk short and truncate the restored transcript.
#[derive(Clone)]
struct Line {
    uuid: Option<String>,
    parent_uuid: Option<String>,
    /// Whether the row carried a `parentUuid` key at all. A row written without
    /// the key is not a root: it inherits the previous mainline row's uuid.
    has_parent_key: bool,
    kind: String,
    subtype: Option<String>,
    is_sidechain: bool,
    is_meta: bool,
    is_compact_summary: bool,
    /// A slash-command wrapper or interrupt marker, which is plumbing rather than
    /// a turn the user typed.
    is_synthetic_user: bool,
    timestamp_ms: i64,
    /// The row's raw ISO-8601 timestamp, carried onto each of its records so the
    /// viewer can caption a node with when it happened.
    timestamp: Option<String>,
    /// From `compactMetadata`: the pre-compact messages a compaction boundary
    /// carries forward, used to stitch a compacted session back together.
    segment_head: Option<String>,
    segment_tail: Option<String>,
    preserved_uuids: Vec<String>,
    records: Vec<HistoryRecord>,
    results: Vec<(String, serde_json::Value, bool)>,
}

/// Parses one stored line into a transcript carrier.
///
/// Returns `None` only for a row without a `uuid`, which can never sit on the
/// parent chain. A sidechain (sub-agent) or meta line yields a `Line` with no
/// records, so the chain stays walkable while the transcript stays clean.
fn parse_line(value: &serde_json::Value) -> Option<Line> {
    let uuid = value.get("uuid").and_then(|value| value.as_str()).unwrap_or("");
    if uuid.is_empty() {
        return None;
    }

    let kind = value.get("type").and_then(|value| value.as_str()).unwrap_or("");
    let is_sidechain = value.get("isSidechain").and_then(|flag| flag.as_bool()) == Some(true);
    let is_meta = value.get("isMeta").and_then(|flag| flag.as_bool()) == Some(true);
    let content = value.get("message").and_then(|message| message.get("content"));
    let is_synthetic_user = kind == "user"
        && content
            .and_then(|content| content.as_str())
            .map(is_synthetic_prompt)
            .unwrap_or(false);

    let parent_tool_use_id = value
        .get("parentToolUseId")
        .or_else(|| value.get("parent_tool_use_id"))
        .and_then(|value| value.as_str())
        .map(str::to_owned);

    let mut records = Vec::new();
    let mut results = Vec::new();

    if !is_sidechain && !is_meta {
        match kind {
            "user" => match content {
                Some(serde_json::Value::Array(blocks)) => {
                    for block in blocks {
                        match block.get("type").and_then(|kind| kind.as_str()) {
                            Some("tool_result") => {
                                let tool_use_id = block
                                    .get("tool_use_id")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                if tool_use_id.is_empty() {
                                    continue;
                                }
                                results.push((
                                    tool_use_id.to_string(),
                                    block.get("content").cloned().unwrap_or(serde_json::Value::Null),
                                    block.get("is_error").and_then(|flag| flag.as_bool())
                                        == Some(true),
                                ));
                            }
                            Some("text") => {
                                let text = block.get("text").and_then(|value| value.as_str()).unwrap_or("");
                                if !text.is_empty() && !is_synthetic_prompt(text) {
                                    records.push(text_record("user", uuid, text, None));
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Some(serde_json::Value::String(text)) => {
                    if !text.is_empty() && !is_synthetic_prompt(text) {
                        records.push(text_record("user", uuid, text, None));
                    }
                }
                _ => {}
            },
            "assistant" => {
                if let Some(blocks) = content.and_then(|content| content.as_array()) {
                    for block in blocks {
                        match block.get("type").and_then(|kind| kind.as_str()) {
                            Some("text") => {
                                let text = block.get("text").and_then(|value| value.as_str()).unwrap_or("");
                                if !text.is_empty() {
                                    records.push(text_record(
                                        "assistant",
                                        uuid,
                                        text,
                                        parent_tool_use_id.clone(),
                                    ));
                                }
                            }
                            Some("thinking") => {
                                let text =
                                    block.get("thinking").and_then(|value| value.as_str()).unwrap_or("");
                                if !text.is_empty() {
                                    records.push(text_record(
                                        "thinking",
                                        uuid,
                                        text,
                                        parent_tool_use_id.clone(),
                                    ));
                                }
                            }
                            Some("tool_use") => records.push(HistoryRecord {
                                kind: "tool".to_string(),
                                uuid: uuid.to_string(),
                                text: String::new(),
                                parent_tool_use_id: parent_tool_use_id.clone(),
                                timestamp: None,
                                tool_name: Some(
                                    block
                                        .get("name")
                                        .and_then(|value| value.as_str())
                                        .unwrap_or("unknown")
                                        .to_string(),
                                ),
                                tool_use_id: non_empty(
                                    block.get("id").and_then(|value| value.as_str()).unwrap_or(""),
                                ),
                                input: Some(
                                    block.get("input").cloned().unwrap_or(serde_json::Value::Null),
                                ),
                                result_content: None,
                                is_error: None,
                            }),
                            // redacted_thinking, images, server_tool_use: nothing to render.
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // The row's own time, kept verbatim for the viewer and reduced to a
    // comparable key for the ordering pass.
    let timestamp = value
        .get("timestamp")
        .and_then(|value| value.as_str())
        .map(str::to_owned);
    for record in &mut records {
        record.timestamp = timestamp.clone();
    }

    let compact = value.get("compactMetadata");
    let segment = compact.and_then(|metadata| metadata.get("preservedSegment"));
    let preserved = compact.and_then(|metadata| metadata.get("preservedMessages"));

    Some(Line {
        uuid: Some(uuid.to_string()),
        parent_uuid: value
            .get("parentUuid")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        has_parent_key: value.get("parentUuid").is_some(),
        kind: kind.to_string(),
        subtype: value
            .get("subtype")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        is_sidechain,
        is_meta,
        is_compact_summary: value.get("isCompactSummary").and_then(|flag| flag.as_bool())
            == Some(true),
        is_synthetic_user,
        timestamp_ms: timestamp_key(timestamp.as_deref()),
        timestamp,
        segment_head: segment
            .and_then(|segment| segment.get("headUuid"))
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        segment_tail: segment
            .and_then(|segment| segment.get("tailUuid"))
            .and_then(|value| value.as_str())
            .map(str::to_owned),
        preserved_uuids: preserved
            .and_then(|messages| {
                messages
                    .get("allUuids")
                    .or_else(|| messages.get("uuids"))
            })
            .and_then(|value| value.as_array())
            .map(|uuids| {
                uuids
                    .iter()
                    .filter_map(|uuid| uuid.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default(),
        records,
        results,
    })
}

fn text_record(
    kind: &str,
    uuid: &str,
    text: &str,
    parent_tool_use_id: Option<String>,
) -> HistoryRecord {
    HistoryRecord {
        kind: kind.to_string(),
        uuid: uuid.to_string(),
        text: text.to_string(),
        parent_tool_use_id,
        timestamp: None,
        tool_name: None,
        tool_use_id: None,
        input: None,
        result_content: None,
        is_error: None,
    }
}

/// Orders parsed lines the way the conversation actually ran.
///
/// The CLI never deletes a message that was rewound past, so the file keeps
/// abandoned branches, and it starts a fresh segment every time the context is
/// compacted. Both are recovered here: the newest leaf is walked back along
/// `parentUuid` to its root, then a compaction boundary found on that chain has
/// its pre-compact prefix and carried-forward messages spliced back in front of
/// it, recursively, so the restored transcript spans compactions.
///
/// This mirrors `selectConversationChain` in the reference GUI
/// (`.dev/jetbrains-cc-gui/ai-bridge/services/claude/conversation-chain.js`),
/// which in turn mirrors Claude Code's own `buildConversationChain`.
fn select_conversation_chain(lines: Vec<Line>) -> Vec<Line> {
    // Without a single `parentUuid` key the file order is the only order there is.
    if !lines.iter().any(|line| line.has_parent_key) {
        return lines;
    }

    let index_of: HashMap<&str, usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| line.uuid.as_deref().map(|id| (id, index)))
        .collect();
    if index_of.is_empty() {
        return lines;
    }

    let parents = resolve_parents(&lines);
    let Some(leaf) = select_newest_leaf(&lines, &index_of, &parents, None) else {
        return lines;
    };
    let chain = walk_parent_chain(&index_of, &parents, leaf);
    if chain.is_empty() {
        return lines;
    }
    let chain = recover_compact_history(&lines, &index_of, &parents, chain);

    chain
        .into_iter()
        .map(|index| lines[index].clone())
        .collect()
}

/// The uuids a fork keeps: the conversation the viewer showed, cut off at and
/// including `fork_uuid`, plus the tool answers that message was waiting on.
/// `None` when that message is not part of it.
///
/// Taken over the ordered chain rather than the file, so a fork at a message
/// leaves behind whatever the CLI rewound past or compacted away: the copy ends
/// where the branch does.
pub(crate) fn conversation_upto<'a>(
    rows: impl IntoIterator<Item = &'a serde_json::Value>,
    fork_uuid: &str,
) -> Option<Vec<String>> {
    conversation_upto_lines(rows.into_iter().filter_map(parse_line).collect(), fork_uuid)
}

fn conversation_upto_lines(lines: Vec<Line>, fork_uuid: &str) -> Option<Vec<String>> {
    let chain = select_conversation_chain(lines);
    let position = chain
        .iter()
        .position(|line| line.uuid.as_deref() == Some(fork_uuid))?;

    // A tool call's answer is stored on its own row just after the message that
    // made it. Ending the copy at the message itself would leave a tool call the
    // API considers unanswered, so those rows are carried along and the copy ends
    // on the message with its tools resolved.
    let mut end = position + 1;
    while end < chain.len() && chain[end].records.is_empty() && !chain[end].results.is_empty() {
        end += 1;
    }

    Some(
        chain[..end]
            .iter()
            .filter_map(|line| line.uuid.clone())
            .collect(),
    )
}

/// The `parentUuid` of every line, with rows written without the key pointing at
/// the previous mainline row. Sidechain rows neither inherit nor count as the
/// previous row: a sub-agent transcript must not become a mainline parent.
fn resolve_parents(lines: &[Line]) -> Vec<Option<String>> {
    let mut parents: Vec<Option<String>> =
        lines.iter().map(|line| line.parent_uuid.clone()).collect();
    let mut previous: Option<String> = None;
    for (index, line) in lines.iter().enumerate() {
        if line.is_sidechain || line.uuid.is_none() {
            continue;
        }
        if !line.has_parent_key {
            if let Some(previous) = previous.clone() {
                parents[index] = Some(previous);
            }
        }
        previous = line.uuid.clone();
    }
    parents
}

/// The chain from one line back to its root, root first.
fn walk_parent_chain(
    index_of: &HashMap<&str, usize>,
    parents: &[Option<String>],
    tip: usize,
) -> Vec<usize> {
    let mut chain = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();
    let mut cursor = Some(tip);
    while let Some(index) = cursor {
        // A cycle would loop forever; the file should never contain one.
        if !seen.insert(index) {
            break;
        }
        chain.push(index);
        cursor = parents[index]
            .as_deref()
            .and_then(|parent| index_of.get(parent).copied());
    }
    chain.reverse();
    chain
}

/// The newest line a viewer can open the session on.
///
/// Newest by timestamp, over the lines nothing else parents to (the leaves),
/// each walked up to its nearest real `user`/`assistant` row first so a trailing
/// bookkeeping row cannot hide the turn it belongs to. Sidechain rows are
/// excluded from the first pass, so a live mainline branch cannot lose to a dead
/// branch that merely ends in a sub-agent row.
fn select_newest_leaf(
    lines: &[Line],
    index_of: &HashMap<&str, usize>,
    parents: &[Option<String>],
    scope: Option<&[usize]>,
) -> Option<usize> {
    let everything: Vec<usize> = (0..lines.len()).collect();
    let scope = scope.unwrap_or(&everything);
    let main_thread: Vec<usize> = scope
        .iter()
        .copied()
        .filter(|&index| !lines[index].is_sidechain)
        .collect();
    if !main_thread.is_empty() {
        if let Some(leaf) = newest_leaf_in(lines, index_of, parents, &main_thread) {
            return Some(leaf);
        }
    }
    newest_leaf_in(lines, index_of, parents, scope)
}

fn newest_leaf_in(
    lines: &[Line],
    index_of: &HashMap<&str, usize>,
    parents: &[Option<String>],
    graph: &[usize],
) -> Option<usize> {
    let parent_uuids: HashSet<&str> = graph
        .iter()
        .filter_map(|&index| parents[index].as_deref())
        .collect();

    let mut best: Option<usize> = None;
    let mut best_time = 0i64;
    for &tip in graph {
        if lines[tip]
            .uuid
            .as_deref()
            .map(|uuid| parent_uuids.contains(uuid))
            .unwrap_or(false)
        {
            continue;
        }
        let mut seen: HashSet<usize> = HashSet::new();
        let mut cursor = Some(tip);
        while let Some(index) = cursor {
            if !seen.insert(index) {
                break;
            }
            let line = &lines[index];
            if (line.kind == "user" || line.kind == "assistant") && !line.is_synthetic_user {
                if !line.is_sidechain && line.timestamp_ms >= best_time {
                    best_time = line.timestamp_ms;
                    best = Some(index);
                }
                break;
            }
            cursor = parents[index]
                .as_deref()
                .and_then(|parent| index_of.get(parent).copied());
        }
    }
    best
}

/// Splices the pre-compact conversation back in front of the compaction boundary
/// found on `chain`, if there is one.
///
/// Claude Code's own loader prunes that prefix because it only feeds the model as
/// context, but this is a transcript viewer: the messages that led to a summary
/// are exactly what the user is scrolling back through.
fn recover_compact_history(
    lines: &[Line],
    index_of: &HashMap<&str, usize>,
    parents: &[Option<String>],
    chain: Vec<usize>,
) -> Vec<usize> {
    match find_relevant_compact_boundary(lines, &chain) {
        Some((boundary, preserved)) => {
            recover_compact_history_for_boundary(lines, index_of, parents, chain, boundary, &preserved)
        }
        None => chain,
    }
}

/// The newest compaction boundary this chain actually touches, with the uuids it
/// carried forward.
fn find_relevant_compact_boundary(
    lines: &[Line],
    chain: &[usize],
) -> Option<(usize, Vec<String>)> {
    let chain_boundary = chain
        .iter()
        .copied()
        .find(|&index| lines[index].subtype.as_deref() == Some("compact_boundary"));
    let latest = (0..lines.len())
        .filter(|&index| lines[index].subtype.as_deref() == Some("compact_boundary"))
        .next_back();
    let latest_preserved = latest
        .map(|index| lines[index].preserved_uuids.clone())
        .unwrap_or_default();

    let (boundary, preserved) = match latest {
        Some(latest)
            if chain_boundary.is_none()
                || chain_boundary == Some(latest)
                || has_compact_continuation(lines, chain, latest, &latest_preserved) =>
        {
            (latest, latest_preserved)
        }
        _ => match chain_boundary {
            Some(chain_boundary) => (
                chain_boundary,
                lines[chain_boundary].preserved_uuids.clone(),
            ),
            None => return None,
        },
    };

    let on_chain = chain
        .iter()
        .any(|&index| lines[index].uuid == lines[boundary].uuid);
    if on_chain || has_compact_continuation(lines, chain, boundary, &preserved) {
        Some((boundary, preserved))
    } else {
        None
    }
}

/// True when the chain runs through the boundary or any message it carried
/// forward, which is what makes the boundary relevant to this chain.
fn has_compact_continuation(
    lines: &[Line],
    chain: &[usize],
    boundary: usize,
    preserved: &[String],
) -> bool {
    let line = &lines[boundary];
    chain.iter().any(|&index| {
        let uuid = lines[index].uuid.as_deref();
        uuid == line.uuid.as_deref()
            || uuid == line.segment_head.as_deref()
            || uuid == line.segment_tail.as_deref()
            || matches!(uuid, Some(uuid) if preserved.iter().any(|kept| kept == uuid))
    })
}

/// Recovers one pinned boundary.
///
/// Boundary selection is deliberately not re-run inside the recursion: a
/// pre-compact chain always contains the newest boundary's carried-forward uuids,
/// so re-selecting would pick that boundary again and loop forever on a session
/// compacted more than once. The nested boundary found in the prefix is strictly
/// older, so the recursion terminates.
fn recover_compact_history_for_boundary(
    lines: &[Line],
    index_of: &HashMap<&str, usize>,
    parents: &[Option<String>],
    chain: Vec<usize>,
    boundary: usize,
    preserved: &[String],
) -> Vec<usize> {
    let prefix = build_pre_compact_prefix(lines, index_of, parents, boundary, preserved);

    if chain
        .iter()
        .any(|&index| lines[index].uuid == lines[boundary].uuid)
    {
        let unique: Vec<usize> = prefix
            .into_iter()
            .filter(|&index| !contains_uuid(lines, &chain, index))
            .collect();
        if unique.is_empty() {
            return chain;
        }
        let mut combined = unique;
        combined.extend(chain);
        return combined;
    }

    let mut block = prefix;
    block.push(boundary);
    block.extend(find_compact_summary(lines, boundary));
    let Some(position) = find_compact_continuation_index(lines, &chain, boundary, preserved) else {
        return chain;
    };
    let tail: Vec<usize> = chain[position + 1..]
        .iter()
        .copied()
        .filter(|&index| !contains_uuid(lines, &block, index))
        .collect();
    block.extend(tail);
    block
}

/// The pre-compact conversation: the chain ending at the boundary's carried-
/// forward head, or, when the metadata is missing, the newest chain that ends
/// before the boundary row itself.
fn build_pre_compact_prefix(
    lines: &[Line],
    index_of: &HashMap<&str, usize>,
    parents: &[Option<String>],
    boundary: usize,
    preserved: &[String],
) -> Vec<usize> {
    let head = lines[boundary]
        .segment_head
        .as_deref()
        .filter(|head| index_of.contains_key(head))
        .map(str::to_owned)
        .or_else(|| {
            preserved
                .iter()
                .find(|uuid| index_of.contains_key(uuid.as_str()))
                .cloned()
        });

    let mut pre_compact = match head.and_then(|head| index_of.get(head.as_str()).copied()) {
        Some(head) => walk_parent_chain(index_of, parents, head),
        None => find_pre_compact_chain(lines, parents, boundary),
    };

    if let Some(nested) = pre_compact.iter().copied().find(|&index| {
        index != boundary && lines[index].subtype.as_deref() == Some("compact_boundary")
    }) {
        pre_compact = recover_compact_history_for_boundary(
            lines,
            index_of,
            parents,
            pre_compact,
            nested,
            &lines[nested].preserved_uuids,
        );
    }

    let mut used: HashSet<String> = HashSet::new();
    if let Some(uuid) = lines[boundary].uuid.as_deref() {
        used.insert(uuid.to_string());
    }
    let mut prefix = Vec::new();
    for index in pre_compact {
        if let Some(uuid) = lines[index].uuid.as_deref() {
            if used.insert(uuid.to_string()) {
                prefix.push(index);
            }
        }
    }
    for uuid in preserved {
        if let Some(&index) = index_of.get(uuid.as_str()) {
            if used.insert(uuid.clone()) {
                prefix.push(index);
            }
        }
    }
    prefix
}

fn find_pre_compact_chain(lines: &[Line], parents: &[Option<String>], boundary: usize) -> Vec<usize> {
    let scope: Vec<usize> = (0..boundary).collect();
    let scoped: HashMap<&str, usize> = scope
        .iter()
        .filter_map(|&index| lines[index].uuid.as_deref().map(|id| (id, index)))
        .collect();
    match select_newest_leaf(lines, &scoped, parents, Some(&scope)) {
        Some(leaf) => walk_parent_chain(&scoped, parents, leaf),
        None => Vec::new(),
    }
}

/// The summary row the CLI writes directly under a compaction boundary.
fn find_compact_summary(lines: &[Line], boundary: usize) -> Vec<usize> {
    let boundary_uuid = lines[boundary].uuid.as_deref();
    let summaries: Vec<usize> = (0..lines.len())
        .filter(|&index| {
            lines[index].parent_uuid.as_deref() == boundary_uuid
                && (lines[index].kind == "user" || lines[index].kind == "assistant")
        })
        .collect();
    let marked: Vec<usize> = summaries
        .iter()
        .copied()
        .filter(|&index| lines[index].is_compact_summary)
        .collect();
    let chosen = if marked.is_empty() { summaries } else { marked };
    chosen.into_iter().take(1).collect()
}

/// Where in the chain the compacted conversation resumes, if it does.
fn find_compact_continuation_index(
    lines: &[Line],
    chain: &[usize],
    boundary: usize,
    preserved: &[String],
) -> Option<usize> {
    let line = &lines[boundary];
    chain.iter().rposition(|&index| {
        let uuid = lines[index].uuid.as_deref();
        uuid == line.segment_head.as_deref()
            || uuid == line.segment_tail.as_deref()
            || matches!(uuid, Some(uuid) if preserved.iter().any(|kept| kept == uuid))
    })
}

fn contains_uuid(lines: &[Line], chain: &[usize], index: usize) -> bool {
    chain
        .iter()
        .any(|&kept| lines[kept].uuid == lines[index].uuid)
}

/// A comparable `YYYYMMDDHHMMSS` key for an ISO-8601 timestamp, or 0. Only the
/// ordering matters here, so the string is read as digit groups rather than
/// pulled through a date library.
fn timestamp_key(value: Option<&str>) -> i64 {
    let Some(text) = value else { return 0 };
    let mut parts = [0i64; 6];
    let mut filled = 0usize;
    for chunk in text.split(|character: char| !character.is_ascii_digit()) {
        if chunk.is_empty() {
            continue;
        }
        if filled == parts.len() {
            break;
        }
        parts[filled] = chunk.parse().unwrap_or(0);
        filled += 1;
    }
    if filled < 3 {
        return 0;
    }
    ((parts[0] * 100 + parts[1]) * 100 + parts[2]) * 1_000_000
        + parts[3] * 10_000
        + parts[4] * 100
        + parts[5]
}

/// `<home>/.claude/projects` — the root every history path hangs off.
pub(crate) fn projects_root() -> PathBuf {
    crate::mcphub::paths::home_dir().join(".claude").join("projects")
}

/// One copy this app wrote, as recorded in its family's file.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OriginRecord {
    /// `clone` or `fork`.
    pub kind: String,
    /// The copy's own session id.
    pub session_id: String,
    pub title: String,
    /// Where the copy lives, and where it was taken from.
    pub project: String,
    pub source_project: String,
    pub source_session_id: String,
    /// The message a fork branches from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_uuid: Option<String>,
    pub created_ms: i64,
}

/// One conversation's lineage: the session everything was copied from, and every
/// copy made in that family, clones and forks alike.
///
/// There is one of these per family, named `<root>-fork.json`, so a copy is only
/// ever addressed through the conversation it ultimately came from. A copy taken
/// from another copy is listed by the family it belongs to rather than by the one
/// it was taken from, which is what lets the canvas draw a family as one picture.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FamilyFile {
    /// The session the family is named after: the one nothing was copied from.
    pub root_session_id: String,
    /// Where that session lives.
    pub root_project: String,
    #[serde(default)]
    pub copies: Vec<OriginRecord>,
}

/// `<config>/.claude-history` — this app's own bookkeeping for the viewer, kept
/// beside the Claude data rather than inside it.
fn store_dir() -> PathBuf {
    crate::config::dir().join(".claude-history")
}

/// `<config>/.claude-history/forks` — one lineage file per conversation family.
pub(crate) fn family_dir() -> PathBuf {
    store_dir().join("forks")
}

/// `<config>/.claude-history/forks/<root>-fork.json`.
pub(crate) fn family_path(root_session_id: &str) -> PathBuf {
    family_dir().join(format!("{root_session_id}-fork.json"))
}

/// Reads one family's lineage file.
///
/// A missing or unreadable file simply means there is none: the lineage is
/// bookkeeping, never the only copy of anything, so it never fails a caller.
pub(crate) fn read_family(root_session_id: &str) -> Option<FamilyFile> {
    let bytes = std::fs::read(family_path(root_session_id)).ok()?;
    serde_json::from_slice::<FamilyFile>(&bytes).ok()
}

/// Every family this app has recorded.
pub(crate) fn families() -> Vec<FamilyFile> {
    let Ok(entries) = std::fs::read_dir(family_dir()) else {
        return Vec::new();
    };
    let mut families = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if let Ok(family) = serde_json::from_slice::<FamilyFile>(&bytes) {
            families.push(family);
        }
    }
    families
}

/// Every clone and fork this app has made, across every family.
pub(crate) fn all_copies() -> Vec<OriginRecord> {
    families()
        .into_iter()
        .flat_map(|family| family.copies)
        .collect()
}

/// The family a session belongs to: the one named after it, or — when it is a
/// copy itself — the one that lists it.
pub(crate) fn family_of(session_id: &str) -> Option<FamilyFile> {
    families().into_iter().find(|family| {
        family.root_session_id == session_id
            || family.copies.iter().any(|copy| copy.session_id == session_id)
    })
}

/// The session a family is named after: a session itself when nothing has been
/// copied from it yet, otherwise the root of the family it is part of.
pub(crate) fn root_for(session_id: &str, project: &str) -> (String, String) {
    match family_of(session_id) {
        Some(family) => (family.root_session_id, family.root_project),
        None => (session_id.to_string(), project.to_string()),
    }
}

/// Files one copy under the family it belongs to, creating that family's file
/// when it is the first copy.
///
/// A failure here costs the lineage only: the copy itself is already written and
/// is a session like any other, so the caller is told nothing about it.
pub(crate) fn record_origin(root_session_id: &str, root_project: &str, record: &OriginRecord) {
    let mut family = read_family(root_session_id).unwrap_or_else(|| FamilyFile {
        root_session_id: root_session_id.to_string(),
        root_project: root_project.to_string(),
        copies: Vec::new(),
    });
    family.copies.retain(|kept| kept.session_id != record.session_id);
    family.copies.push(record.clone());

    let path = family_path(&family.root_session_id);
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(text) = serde_json::to_string_pretty(&family) {
        let _ = std::fs::write(&path, text);
    }
}

/// The lineage of each copy, keyed by the copy's own session id.
fn origin_index(records: &[OriginRecord]) -> HashMap<String, SessionOrigin> {
    records
        .iter()
        .map(|record| {
            (
                record.session_id.clone(),
                SessionOrigin {
                    kind: record.kind.clone(),
                    source_session_id: record.source_session_id.clone(),
                    source_project: record.source_project.clone(),
                    fork_uuid: record.fork_uuid.clone(),
                    title: record.title.clone(),
                },
            )
        })
        .collect()
}

/// A working directory's history folder name: every non-alphanumeric character
/// becomes `-`, with the case kept (`M:\dev\app` → `M--dev-app`).
fn slug(cwd: &str) -> String {
    cwd.trim_end_matches(['\\', '/'])
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// A session file, not a sub-agent transcript or the journal kept beside them.
fn is_session_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    name.ends_with(".jsonl") && !name.starts_with("agent-") && name != "journal.jsonl"
}

/// True when a session file is a sub-agent transcript rather than a conversation.
///
/// The marker is on the first record only, which is why this reads the head and
/// not the whole file — the same rule the CLI applies to a `--resume` list.
fn is_sidechain(head: &[String]) -> bool {
    head.first()
        .map(|line| {
            line.contains("\"isSidechain\":true") || line.contains("\"isSidechain\": true")
        })
        .unwrap_or(false)
}

/// Title and preview for one session, from its head and tail windows.
///
/// Priority mirrors the CLI's own list (and the JetBrains client): an explicit
/// `customTitle`, then a generated `aiTitle`, then the last `lastPrompt`, then a
/// `summary`, and finally the first real user message. `None` means the file
/// carries no title at all, and the session is left out — a file with no prompt
/// is not a conversation worth restoring.
pub(crate) fn title_from_lines(head: &[String], tail: &[String]) -> Option<(String, String)> {
    let head_fields = title_fields(head);
    let tail_fields = title_fields(tail);
    let first_prompt = first_prompt_from_head(head);

    let title = tail_fields
        .custom_title
        .or(head_fields.custom_title)
        .or(tail_fields.ai_title)
        .or(head_fields.ai_title)
        .or(tail_fields.last_prompt)
        .or(tail_fields.summary)
        .or_else(|| first_prompt.clone())?;

    // The CLI writes these for sessions that never really ran; they would show
    // up as blank-looking rows otherwise.
    let lowered = title.to_lowercase();
    if lowered.starts_with("warmup") || lowered.starts_with("no prompt") {
        return None;
    }

    Some((title, first_prompt.unwrap_or_default()))
}

/// The title-carrying fields of one window, last value winning per field.
#[derive(Default)]
struct TitleFields {
    custom_title: Option<String>,
    ai_title: Option<String>,
    last_prompt: Option<String>,
    summary: Option<String>,
}

fn title_fields(lines: &[String]) -> TitleFields {
    let mut fields = TitleFields::default();
    for line in lines {
        // Parsing every line of a 64 KB window is the expensive part of listing;
        // a plain substring look is a cheap way to reach the few rows that matter.
        if !(line.contains("\"customTitle\"")
            || line.contains("\"aiTitle\"")
            || line.contains("\"lastPrompt\"")
            || line.contains("\"summary\""))
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(text) = json_str_field(&value, "customTitle") {
            fields.custom_title = Some(text);
        }
        if let Some(text) = json_str_field(&value, "aiTitle") {
            fields.ai_title = Some(text);
        }
        if let Some(text) = json_str_field(&value, "lastPrompt") {
            fields.last_prompt = Some(text);
        }
        if let Some(text) = json_str_field(&value, "summary") {
            fields.summary = Some(text);
        }
    }
    fields
}

/// A trimmed, non-empty string field of a parsed record.
fn json_str_field(value: &serde_json::Value, key: &str) -> Option<String> {
    let text = value.get(key)?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// The first message the user actually typed, read from the head window.
///
/// Mirrors the client's `extractFirstPromptFromHead`: the CLI's own wrappers, tool
/// results, meta rows and compact summaries are skipped. A slash-command wrapper
/// is remembered as a fallback while a later real message still wins, and a shell
/// mode prompt is reported as `! <command>`.
fn first_prompt_from_head(head: &[String]) -> Option<String> {
    let mut command_fallback = None;
    for line in head {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|kind| kind.as_str()) != Some("user") {
            continue;
        }
        if value.get("isMeta").and_then(|flag| flag.as_bool()) == Some(true)
            || value.get("isCompactSummary").and_then(|flag| flag.as_bool()) == Some(true)
        {
            continue;
        }
        let message = value.get("message");
        if message_is_tool_result(message) {
            continue;
        }
        let text = content_text(message.and_then(|message| message.get("content")));
        if text.is_empty() {
            continue;
        }
        let text = text.replace('\n', " ");
        let text = text.trim();

        if let Some(rest) = text.strip_prefix("<command-name>") {
            if let Some(end) = rest.find("</command-name>") {
                let name = &rest[..end];
                if !name.is_empty() {
                    command_fallback = Some(name.to_string());
                    continue;
                }
            }
        }
        if let Some(open) = text.find("<bash-input>") {
            let start = open + "<bash-input>".len();
            let end = text.find("</bash-input>").unwrap_or(text.len());
            if end > start {
                return Some(format!("! {}", text[start..end].trim()));
            }
        }
        if text.starts_with('<') && text.chars().nth(1).is_some_and(char::is_lowercase) {
            continue;
        }
        if text.starts_with("[Request interrupted") {
            continue;
        }
        return Some(truncate_first_prompt(text));
    }
    command_fallback
}

/// The reference caps a first-prompt title at 200 characters plus an ellipsis.
fn truncate_first_prompt(text: &str) -> String {
    if text.chars().count() <= FIRST_PROMPT_MAX_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(FIRST_PROMPT_MAX_CHARS).collect();
    format!("{}…", head.trim_end())
}

/// True when a `user` record is a tool result coming back, never a typed prompt.
fn message_is_tool_result(message: Option<&serde_json::Value>) -> bool {
    match message.and_then(|message| message.get("content")) {
        Some(serde_json::Value::Array(blocks)) => blocks.iter().any(|block| {
            block.get("type").and_then(|kind| kind.as_str()) == Some("tool_result")
        }),
        _ => false,
    }
}

/// Plain text of a stored `message.content`, which is a string or a block array.
fn content_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(|kind| kind.as_str()) == Some("text"))
            .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// True for the strings the CLI writes for its own plumbing rather than a prompt
/// the user typed: slash-command wrappers and the interrupt marker.
fn is_synthetic_prompt(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("<local-command-caveat>")
        || trimmed.starts_with("<command-name>")
        || trimmed.starts_with("<local-command-stdout>")
        || trimmed.starts_with("[Request interrupted")
}

/// Last-modified time as epoch milliseconds, or 0 when it cannot be read.
fn modified_ms(path: &Path) -> i64 {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// The head and tail windows of a session file: at most `LIST_WINDOW_BYTES` from
/// each end, without touching the middle. A file no larger than one window is read
/// once and both windows hold the same lines.
pub(crate) fn read_head_tail(path: &Path) -> (Vec<String>, Vec<String>) {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Default::default(),
    };
    let len = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);

    let mut head_bytes = Vec::new();
    if (&file)
        .take(LIST_WINDOW_BYTES)
        .read_to_end(&mut head_bytes)
        .is_err()
    {
        return Default::default();
    }
    let head: Vec<String> = String::from_utf8_lossy(&head_bytes)
        .lines()
        .map(str::to_owned)
        .collect();
    if len <= LIST_WINDOW_BYTES {
        return (head.clone(), head);
    }

    let mut tail_bytes = Vec::new();
    if file.seek(SeekFrom::Start(len - LIST_WINDOW_BYTES)).is_err()
        || file.read_to_end(&mut tail_bytes).is_err()
    {
        return (head, Vec::new());
    }
    let tail_text = String::from_utf8_lossy(&tail_bytes).into_owned();
    // The first line of the tail window starts mid-line when the cut is not on a
    // boundary; such a fragment is not valid JSON and is skipped when parsed.
    let tail = tail_text.lines().map(str::to_owned).collect();
    (head, tail)
}

fn non_empty(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_replaces_every_non_alphanumeric_character() {
        assert_eq!(slug("M:\\MaBangProjectsWorkflows-dev-skills"), "M--MaBangProjectsWorkflows-dev-skills");
        assert_eq!(slug("C:\\Users\\Anfioo\\.claude-mem\\observer\\sessions"), "C--Users-Anfioo--claude-mem-observer-sessions");
        assert_eq!(slug("M:\\dev\\app\\"), "M--dev-app");
    }

    #[test]
    fn synthetic_prompts_are_skipped() {
        assert!(is_synthetic_prompt("<command-name>/clear</command-name>"));
        assert!(is_synthetic_prompt("[Request interrupted by user]"));
        assert!(!is_synthetic_prompt("fix the history feature"));
    }

    #[test]
    fn ordering_follows_the_parent_chain_and_drops_abandoned_branches() {
        let lines: Vec<Line> = [
            ("a", None, "user", "first", 1),
            ("b", Some("a"), "user", "second", 2),
            ("c", Some("a"), "user", "abandoned", 3),
            ("d", Some("b"), "user", "third", 4),
        ]
        .into_iter()
        .map(test_line)
        .collect();

        let ordered = select_conversation_chain(lines);
        let texts: Vec<&str> = ordered
            .iter()
            .map(|line| line.records[0].text.as_str())
            .collect();
        assert_eq!(texts, vec!["first", "second", "third"]);
    }

    #[test]
    fn ordering_walks_through_bookkeeping_rows() {
        // The CLI interleaves `system`/`attachment` rows into the parent chain;
        // a row with no records must still carry the walk across.
        let lines: Vec<Line> = [
            ("a", None, "user", "first", 1),
            ("b", Some("a"), "user", "second", 2),
            ("s", Some("b"), "system", "", 3),
            ("d", Some("s"), "user", "third", 4),
        ]
        .into_iter()
        .map(test_line)
        .collect();

        let ordered = select_conversation_chain(lines);
        let texts: Vec<&str> = ordered
            .iter()
            .flat_map(|line| line.records.iter().map(|record| record.text.as_str()))
            .collect();
        assert_eq!(texts, vec!["first", "second", "third"]);
    }

    #[test]
    fn ordering_stitches_the_pre_compact_conversation_back_in() {
        // `x`..`z` are compacted away; the boundary row is a root that carries
        // them forward, so the restored chain must still start at `x`.
        let mut lines: Vec<Line> = [
            ("x", None, "user", "before", 1),
            ("y", Some("x"), "user", "kept", 2),
            ("z", Some("y"), "user", "summarised", 3),
        ]
        .into_iter()
        .map(test_line)
        .collect();

        let mut boundary = test_line(("k", None, "system", "", 4));
        boundary.subtype = Some("compact_boundary".to_string());
        boundary.segment_head = Some("x".to_string());
        boundary.segment_tail = Some("z".to_string());
        boundary.preserved_uuids = vec!["x".to_string(), "y".to_string(), "z".to_string()];
        let mut summary = test_line(("m", Some("k"), "user", "summary", 5));
        summary.is_compact_summary = true;
        let continuation = test_line(("n", Some("m"), "user", "after", 6));

        lines.push(boundary);
        lines.push(summary);
        lines.push(continuation);

        let ordered = select_conversation_chain(lines);
        let texts: Vec<&str> = ordered
            .iter()
            .flat_map(|line| line.records.iter().map(|record| record.text.as_str()))
            .collect();
        assert_eq!(texts, vec!["before", "kept", "summarised", "summary", "after"]);
    }

    #[test]
    fn a_fork_keeps_the_conversation_up_to_its_message() {
        // `c` is a branch the CLI rewound past, so forking at `b` must not carry
        // it — and must not carry the messages after the fork either.
        let rows = [
            json_line("a", None, "user", "first", 1),
            json_line("b", Some("a"), "assistant", "second", 2),
            json_line("c", Some("a"), "user", "abandoned", 3),
            json_line("d", Some("b"), "user", "third", 4),
        ];
        let values = parse_rows(&rows);

        let kept = conversation_upto(values.iter(), "b").expect("the message is on the chain");
        assert_eq!(kept, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn a_fork_carries_the_tool_answers_of_the_message_it_ends_on() {
        // A tool's answer is stored on its own row, just after the message that
        // asked for it. Ending the copy at the message itself would keep a tool
        // call the API considers unanswered, so the answer comes along.
        let rows = [
            json_line("a", None, "user", "first", 1),
            json_line("b", Some("a"), "assistant", "let me look", 2),
            tool_result_line("br", "b", 3),
            json_line("d", Some("br"), "user", "next", 4),
        ];
        let values = parse_rows(&rows);

        let kept = conversation_upto(values.iter(), "b").expect("the message is on the chain");
        assert_eq!(
            kept,
            vec!["a".to_string(), "b".to_string(), "br".to_string()]
        );
    }

    #[test]
    fn a_fork_at_a_message_outside_the_conversation_is_refused() {
        // `c` lost to `d` when the newest leaf was picked, so it is not a message
        // the viewer ever showed and cannot be branched from.
        let rows = [
            json_line("a", None, "user", "first", 1),
            json_line("c", Some("a"), "user", "abandoned", 2),
            json_line("d", Some("a"), "user", "kept", 3),
        ];
        let values = parse_rows(&rows);

        assert_eq!(conversation_upto(values.iter(), "c"), None);
    }

    #[test]
    fn workflow_turns_pair_a_question_with_the_reply_before_it() {
        // A turn is the question plus the last thing said before the next one. A
        // bare tool call is not a turn of its own: it says nothing.
        let lines: Vec<Line> = [
            ("u1", None, "user", "first question", 1),
            ("a1", Some("u1"), "assistant", "answer one", 2),
            ("t1", Some("a1"), "assistant", "", 3),
            ("u2", Some("t1"), "user", "second question", 4),
            ("a2", Some("u2"), "assistant", "answer two", 5),
            ("u3", Some("a2"), "user", "third question", 6),
        ]
        .into_iter()
        .map(test_line)
        .collect();

        let turns = turns_of(&select_conversation_chain(lines));
        let pairs: Vec<(&str, &str)> = turns
            .iter()
            .map(|turn| (turn.question.as_str(), turn.answer.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("first question", "answer one"),
                ("second question", "answer two"),
                // Nothing was said after it: this is the message a fork of the
                // session would branch from.
                ("third question", ""),
            ]
        );
        assert_eq!(turns[0].question_uuid.as_deref(), Some("u1"));
        assert_eq!(turns[0].answer_uuid.as_deref(), Some("a1"));
        assert_eq!(turns[2].answer_uuid, None);
    }

    #[test]
    fn workflow_turns_carry_text_clipped_and_a_reply_without_a_question() {
        let long = "x".repeat(WORKFLOW_TEXT_MAX_CHARS + 20);
        let lines: Vec<Line> = [
            ("a1", None, "assistant", "the CLI speaks first", 1),
            ("u1", Some("a1"), "user", &long, 2),
        ]
        .into_iter()
        .map(test_line)
        .collect();

        let turns = turns_of(&select_conversation_chain(lines));
        assert_eq!(turns.len(), 2);
        // A conversation can open with the CLI; that reply still gets a turn.
        assert_eq!(turns[0].question_uuid, None);
        assert_eq!(turns[0].answer, "the CLI speaks first");
        assert_eq!(turns[1].question.chars().count(), WORKFLOW_TEXT_MAX_CHARS + 1);
        assert!(turns[1].question.ends_with('…'));
    }

    #[test]
    fn names_that_could_leave_the_history_tree_are_refused() {
        assert!(validate_key("2f8a1c", "session").is_ok());
        assert!(validate_key("", "session").is_err());
        assert!(validate_key("..", "project").is_err());
        assert!(validate_key("a/b", "project").is_err());
        assert!(validate_key("a\\b", "project").is_err());
        assert!(validate_key("C:x", "project").is_err());
    }

    #[test]
    fn timestamps_compare_by_calendar_value() {
        assert_eq!(timestamp_key(Some("2026-10-11T09:45:57.123Z")), 20261011094557);
        assert_eq!(timestamp_key(Some("2026-10-11T10:00:00.000Z")) > timestamp_key(Some("2026-10-11T09:59:59.000Z")), true);
        assert_eq!(timestamp_key(None), 0);
    }

    #[test]
    fn titles_prefer_custom_then_ai_then_last_prompt() {
        let head = vec![user("build the title list"), ai_title("generated title")];
        // No custom title yet: the generated one wins over the user prompt.
        assert_eq!(
            title_from_lines(&head, &head),
            Some(("generated title".to_string(), "build the title list".to_string()))
        );

        // A custom title outranks a generated one, and the newest wins.
        let head = vec![
            ai_title("generated title"),
            custom_title("first name"),
            custom_title("second name"),
        ];
        assert_eq!(
            title_from_lines(&head, &head).map(|entry| entry.0),
            Some("second name".to_string())
        );

        // With neither, the last prompt stands in for the title.
        let head = vec![user("build the title list")];
        let tail = vec![last_prompt("latest prompt")];
        assert_eq!(
            title_from_lines(&head, &tail).map(|entry| entry.0),
            Some("latest prompt".to_string())
        );
    }

    #[test]
    fn titles_fall_back_to_the_first_real_prompt() {
        let head = vec![
            meta_row("meta row"),
            tool_result_row(),
            raw(r#"{"type":"user","message":{"content":"<local-command-caveat>noise</local-command-caveat>"}}"#),
            user("fix the history titles"),
        ];
        assert_eq!(
            title_from_lines(&head, &head),
            Some(("fix the history titles".to_string(), "fix the history titles".to_string()))
        );
    }

    #[test]
    fn titles_are_dropped_when_there_is_nothing_to_show() {
        // Only plumbing rows: no title, no prompt, so the session is not listed.
        let head = vec![meta_row("meta row"), raw(r#"{"type":"system","subtype":"init"}"#)];
        assert_eq!(title_from_lines(&head, &head), None);

        // The CLI's own "nothing happened" titles are dropped too.
        let warmup = vec![last_prompt("warmup session")];
        assert_eq!(title_from_lines(&warmup, &warmup), None);
    }

    #[test]
    fn first_prompts_report_commands_and_shell_input() {
        // A slash-command wrapper is only a fallback; a later real message wins.
        let head = vec![command("/clear"), user("real prompt")];
        assert_eq!(first_prompt_from_head(&head), Some("real prompt".to_string()));

        // Command-only history falls back to the command name.
        let head = vec![command("/clear")];
        assert_eq!(first_prompt_from_head(&head), Some("/clear".to_string()));

        // Shell mode is shown as the command the user ran.
        let head = vec![raw(r#"{"type":"user","message":{"content":"<bash-input>git status</bash-input>"}}"#)];
        assert_eq!(first_prompt_from_head(&head), Some("! git status".to_string()));
    }

    #[test]
    fn sidechain_files_are_recognised_by_their_first_record() {
        assert!(is_sidechain(&vec![raw(r#"{"type":"user","isSidechain":true}"#)]));
        assert!(!is_sidechain(&vec![raw(r#"{"type":"user","isSidechain":false}"#)]));
        assert!(!is_sidechain(&[]));
    }

    /// A raw JSONL line as written on disk.
    fn raw(line: &str) -> String {
        line.to_string()
    }

    /// A `user` record whose content is a plain string.
    fn user(text: &str) -> String {
        format!(r#"{{"type":"user","message":{{"content":{}}}}}"#, json_string(text))
    }

    fn meta_row(text: &str) -> String {
        format!(
            r#"{{"type":"user","isMeta":true,"message":{{"content":{}}}}}"#,
            json_string(text)
        )
    }

    fn tool_result_row() -> String {
        raw(r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"out"}]}}"#)
    }

    fn command(name: &str) -> String {
        user(&format!("<command-name>{name}</command-name>"))
    }

    fn ai_title(text: &str) -> String {
        format!(r#"{{"type":"ai-title","aiTitle":{}}}"#, json_string(text))
    }

    fn custom_title(text: &str) -> String {
        format!(r#"{{"type":"custom-title","customTitle":{}}}"#, json_string(text))
    }

    fn last_prompt(text: &str) -> String {
        format!(r#"{{"type":"last-prompt","lastPrompt":{}}}"#, json_string(text))
    }

    fn json_string(text: &str) -> String {
        serde_json::Value::String(text.to_string()).to_string()
    }

    /// A stored row as the CLI writes it: a uuid, its parent, a timestamp and a
    /// plain-string message.
    fn json_line(uuid: &str, parent: Option<&str>, kind: &str, text: &str, at: i64) -> String {
        format!(
            r#"{{"type":"{kind}","uuid":"{uuid}","parentUuid":{},"timestamp":{},"message":{{"content":{}}}}}"#,
            parent
                .map(|parent| format!("\"{parent}\""))
                .unwrap_or_else(|| "null".to_string()),
            json_string(&format!("2026-01-01T00:00:{at:02}Z")),
            json_string(text),
        )
    }

    /// A tool's answer as the CLI stores it: a row of its own, right after the
    /// message that asked for it. The answer is only a record when it names the
    /// tool call it belongs to, which is what the id here is for.
    fn tool_result_line(uuid: &str, parent: &str, at: i64) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","parentUuid":"{parent}","timestamp":{},"message":{{"content":[{{"type":"tool_result","tool_use_id":"t","content":"out"}}]}}}}"#,
            json_string(&format!("2026-01-01T00:00:{at:02}Z")),
        )
    }

    fn parse_rows(rows: &[String]) -> Vec<serde_json::Value> {
        rows.iter()
            .map(|row| serde_json::from_str(row).expect("a fixture row is valid JSON"))
            .collect()
    }

    fn test_line((uuid, parent, kind, text, at): (&str, Option<&str>, &str, &str, i64)) -> Line {
        Line {
            uuid: Some(uuid.to_string()),
            parent_uuid: parent.map(str::to_owned),
            has_parent_key: true,
            kind: kind.to_string(),
            subtype: None,
            is_sidechain: false,
            is_meta: false,
            is_compact_summary: false,
            is_synthetic_user: false,
            timestamp_ms: at,
            timestamp: None,
            segment_head: None,
            segment_tail: None,
            preserved_uuids: Vec::new(),
            records: if text.is_empty() {
                Vec::new()
            } else {
                vec![text_record(kind, uuid, text, None)]
            },
            results: Vec::new(),
        }
    }
}