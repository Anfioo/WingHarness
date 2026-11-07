//! Discovery, extraction and paging over desensitized native transcripts.
//!
//! The fixtures under `tests/fixtures/` are written into a temp CLI home and
//! reached through `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, so the tests never read
//! the developer's real history. Those variables are process-wide, hence the
//! shared mutex below.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_chat_core::history;
use agent_chat_core::AgentChatErrorCode;

const CLAUDE_FIXTURE: &str = include_str!("fixtures/claude_session.jsonl");
const CODEX_FIXTURE: &str = include_str!("fixtures/codex_session.jsonl");
const WORKSPACE: &str = r"C:\workspace\demo";

static SERIAL: Mutex<()> = Mutex::new(());
static ROOT: OnceLock<PathBuf> = OnceLock::new();

fn fixture_root() -> PathBuf {
    ROOT.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "agent-chat-history-{}-{nanos}",
            std::process::id()
        ));

        // Claude encodes `C:\workspace\demo` as `C--workspace-demo`.
        let claude_project = root
            .join("claude")
            .join("projects")
            .join("C--workspace-demo");
        fs::create_dir_all(&claude_project).expect("create claude project dir");
        fs::write(claude_project.join("demo-claude.jsonl"), CLAUDE_FIXTURE)
            .expect("write claude fixture");

        let codex_day = root
            .join("codex")
            .join("sessions")
            .join("2026")
            .join("02")
            .join("03");
        fs::create_dir_all(&codex_day).expect("create codex day dir");
        fs::write(codex_day.join("rollout-demo.jsonl"), CODEX_FIXTURE)
            .expect("write codex fixture");

        std::env::set_var("CLAUDE_CONFIG_DIR", root.join("claude"));
        std::env::set_var("CODEX_HOME", root.join("codex"));
        root
    })
    .clone()
}

fn with_fixtures() -> MutexGuard<'static, ()> {
    let guard = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    fixture_root();
    guard
}

fn load(engine: &str, session_id: &str, limit: usize, before: Option<i64>) -> agent_chat_core::AgentSessionPage {
    history::load_session(engine, session_id, Path::new(WORKSPACE), limit, before)
        .expect("session loads")
}

#[test]
fn fixtures_are_desensitized() {
    for (name, body) in [
        ("claude_session.jsonl", CLAUDE_FIXTURE),
        ("codex_session.jsonl", CODEX_FIXTURE),
    ] {
        let lowered = body.to_ascii_lowercase();
        for marker in ["c:\\\\users", "appa_data", "sk-", "api_key", "authorization"] {
            assert!(
                !lowered.contains(marker),
                "{name} must not contain {marker}"
            );
        }
        assert!(
            body.contains(r"C:\\workspace\\demo"),
            "{name} uses the shared demo workspace"
        );
    }
}

#[test]
fn lists_both_engines_newest_first_with_summaries() {
    let _guard = with_fixtures();

    let sessions = history::list_sessions(None, None, 10).expect("scan succeeds");
    let ids: Vec<&str> = sessions
        .iter()
        .map(|session| session.session_id.as_str())
        .collect();
    assert_eq!(ids, ["demo-codex", "demo-claude"], "newest first");

    let codex = &sessions[0];
    assert_eq!(codex.engine, "codex");
    assert_eq!(codex.workspace_path, WORKSPACE);
    assert_eq!(codex.title, "List the demo files.");
    assert_eq!(codex.preview, "There are two files.");
    assert_eq!(codex.message_count, 4);
    assert!(codex.file_path.ends_with("rollout-demo.jsonl"));

    let claude = &sessions[1];
    assert_eq!(claude.engine, "claude");
    assert_eq!(claude.workspace_path, WORKSPACE);
    assert_eq!(claude.title, "Summarize the demo project");
    assert_eq!(claude.preview, "Done.");
    assert_eq!(claude.message_count, 5);
    assert!(claude.file_path.ends_with("demo-claude.jsonl"));
    assert!(claude.created_at.is_some());
    assert!(claude.updated_at >= claude.created_at);
}

#[test]
fn filters_by_engine_and_workspace() {
    let _guard = with_fixtures();

    let claude = history::list_sessions(Some("claude"), None, 10).expect("claude scan");
    assert_eq!(claude.len(), 1);
    assert_eq!(claude[0].session_id, "demo-claude");

    let codex = history::list_sessions(Some("codex"), None, 10).expect("codex scan");
    assert_eq!(codex.len(), 1);
    assert_eq!(codex[0].session_id, "demo-codex");

    let unknown = history::list_sessions(Some("gemini"), None, 10).expect("unknown engine scan");
    assert!(unknown.is_empty());

    let same = history::list_sessions(None, Some(Path::new("c:/WORKSPACE/demo/")), 10)
        .expect("case and separator insensitive scan");
    assert_eq!(same.len(), 2);

    let other = history::list_sessions(None, Some(Path::new(r"C:\workspace\other")), 10)
        .expect("unrelated workspace scan");
    assert!(other.is_empty());
}

#[test]
fn claude_transcript_extracts_text_thinking_and_tool_rows() {
    let _guard = with_fixtures();

    let page = load("claude", "demo-claude", 200, None);
    assert_eq!(page.next_before, None);

    let roles: Vec<&str> = page.messages.iter().map(|row| row.role.as_str()).collect();
    assert_eq!(roles, ["user", "thinking", "assistant", "tool", "assistant"]);
    let seqs: Vec<i64> = page.messages.iter().map(|row| row.seq).collect();
    assert_eq!(seqs, [1, 2, 3, 4, 5]);

    let user = &page.messages[0];
    assert_eq!(user.text, "Summarize the demo project");
    assert_eq!(user.ts.as_deref(), Some("2026-01-02T03:04:05Z"));

    let thinking = &page.messages[1];
    assert_eq!(thinking.text, "Plan the answer.");

    let answer = &page.messages[2];
    assert_eq!(answer.text, "The demo has three files.");
    assert_eq!(answer.model.as_deref(), Some("claude-demo"));
    assert_eq!(
        answer
            .usage
            .as_ref()
            .expect("usage rides the assistant row")["input_tokens"],
        10
    );

    let tool = &page.messages[3];
    assert_eq!(tool.text, "Read");
    assert_eq!(tool.tool_call_id.as_deref(), Some("toolu_demo_1"));
    assert_eq!(tool.path.as_deref(), Some(r"C:\workspace\demo\README.md"));
    assert_eq!(
        tool.args.as_ref().expect("args")["file_path"],
        r"C:\workspace\demo\README.md"
    );
    assert_eq!(
        tool.result.as_ref().and_then(|result| result.as_str()),
        Some("# Demo")
    );

    assert_eq!(page.messages[4].text, "Done.");
}

#[test]
fn codex_transcript_folds_reasoning_tool_output_and_usage() {
    let _guard = with_fixtures();

    let page = load("codex", "demo-codex", 200, None);
    let roles: Vec<&str> = page.messages.iter().map(|row| row.role.as_str()).collect();
    assert_eq!(roles, ["user", "thinking", "tool", "assistant"]);

    assert_eq!(page.messages[0].text, "List the demo files.");
    assert_eq!(page.messages[1].text, "Look at the tree.");

    let tool = &page.messages[2];
    assert_eq!(tool.text, "shell");
    assert_eq!(tool.tool_call_id.as_deref(), Some("call-demo-1"));
    assert_eq!(
        tool.args.as_ref().expect("decoded arguments")["command"][0],
        "ls"
    );
    assert_eq!(
        tool.result.as_ref().and_then(|result| result.as_str()),
        Some("README.md\nsrc")
    );

    let answer = &page.messages[3];
    assert_eq!(answer.text, "There are two files.");
    let usage = answer
        .usage
        .as_ref()
        .expect("token_count folds onto the answer");
    assert_eq!(usage["input_tokens"], 12);
    assert_eq!(usage["model_context_window"], 128000);
}

#[test]
fn paging_walks_backwards_without_repeating_rows() {
    let _guard = with_fixtures();

    let first = load("claude", "demo-claude", 2, None);
    assert_eq!(
        first.messages.iter().map(|row| row.seq).collect::<Vec<_>>(),
        [4, 5]
    );
    assert_eq!(first.next_before, Some(3));

    let second = load("claude", "demo-claude", 2, first.next_before);
    assert_eq!(
        second.messages.iter().map(|row| row.seq).collect::<Vec<_>>(),
        [2, 3]
    );
    assert_eq!(second.next_before, Some(1));

    let third = load("claude", "demo-claude", 2, second.next_before);
    assert_eq!(
        third.messages.iter().map(|row| row.seq).collect::<Vec<_>>(),
        [1]
    );
    assert_eq!(third.next_before, None);

    // limit 0 means "the documented default page", not an empty page.
    let default_page = load("claude", "demo-claude", 0, None);
    assert_eq!(default_page.messages.len(), 5);
}

#[test]
fn missing_sessions_and_unknown_engines_are_not_found() {
    let _guard = with_fixtures();

    let error = history::load_session("claude", "missing", Path::new(WORKSPACE), 50, None)
        .expect_err("unknown session id");
    assert_eq!(error.code, AgentChatErrorCode::NotFound);

    let error = history::load_session("gemini", "demo-claude", Path::new(WORKSPACE), 50, None)
        .expect_err("unknown engine");
    assert_eq!(error.code, AgentChatErrorCode::NotFound);
}

#[test]
fn limit_is_clamped_to_the_documented_maximum() {
    let _guard = with_fixtures();

    let page = load("claude", "demo-claude", 10_000, None);
    assert_eq!(page.messages.len(), 5);
}
