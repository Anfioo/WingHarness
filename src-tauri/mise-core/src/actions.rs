// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

//! Running the commands the page offers as one-click actions.
//!
//! A script is validated line by line before the first process starts: every
//! line must be a `mise` invocation, and no shell operator may appear in its
//! arguments. Each line then runs as an argv array, streaming output through
//! the `mise:action-progress` event and stopping the rest of the script on the
//! first non-zero exit. A failed action also sweeps the lockfiles mise left
//! behind, and every run is recorded in the history store.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use tauri::Emitter;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

use crate::error::{MiseError, MiseResult};
use crate::models::{
    MiseActionProgress, MiseActionProgressKind, MiseActionResult, MiseExecutedCommand,
    MiseHealthLevel, MiseHistoryStatus, MiseLockfileReport, MiseOutputChunk,
};
use crate::{history, paths, process, MiseState};

const PROGRESS_EVENT: &str = "mise:action-progress";
/// A package install can download for minutes; the page shows progress.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(6 * 60);

/// One validated line of the script.
#[derive(Debug, Clone)]
pub(crate) struct ScriptCommand {
    line: String,
    args: Vec<String>,
}

/// Releases the action gate when the function leaves, including on an early
/// return or a panic.
struct ActionGate<'a> {
    state: &'a MiseState,
}

impl<'a> ActionGate<'a> {
    fn new(state: &'a MiseState) -> Self {
        Self { state }
    }
}

impl Drop for ActionGate<'_> {
    fn drop(&mut self) {
        self.state.end_action();
    }
}

/// Validate and run a multi-line mise script, reporting progress through the
/// `mise:action-progress` event and recording one history entry.
pub async fn run_script(
    app: &tauri::AppHandle,
    state: &MiseState,
    script: &str,
    working_directory: Option<&str>,
) -> MiseResult<MiseActionResult> {
    if !state.try_begin_action() {
        return Err(MiseError::busy());
    }
    let _gate = ActionGate::new(state);

    // Every line is checked before the first process starts, so an invalid
    // script cannot leave the environment half-changed.
    let commands = parse_script(script)?;
    if commands.is_empty() {
        return Err(MiseError::invalid_input(
            "script",
            "The script contains no mise commands.",
        ));
    }

    let working_path = match working_directory {
        Some(directory) => {
            let path = PathBuf::from(directory);
            if !path.is_dir() {
                return Err(MiseError::invalid_input(
                    "workingDirectory",
                    "The working directory does not exist.",
                ));
            }
            Some(path)
        }
        None => None,
    };

    let snapshot = capture_lockfiles();
    let total_commands = commands.len();
    let mut executed = Vec::new();
    let mut lockfile_cleanup = None;

    for (index, command) in commands.iter().enumerate() {
        let command_index = index + 1;
        emit_progress(
            app,
            progress(
                MiseActionProgressKind::CommandStarted,
                command,
                command_index,
                total_commands,
            ),
        );

        let (sender, receiver) = unbounded_channel::<MiseOutputChunk>();
        let forwarder = spawn_output_forwarder(
            app.clone(),
            command.line.clone(),
            command_index,
            total_commands,
            receiver,
        );

        let started = Instant::now();
        let result = process::run_command(
            &command.args,
            working_path.as_deref(),
            COMMAND_TIMEOUT,
            true,
            None,
            Some(sender),
        )
        .await;

        // The sender lives inside the process layer and is dropped when it
        // returns, so this join closes the channel and flushes every chunk
        // before the finished event.
        let _ = forwarder.await;

        let executed_command = match result {
            Ok(result) => MiseExecutedCommand {
                command: command.line.clone(),
                stdout: result.stdout,
                stderr: result.stderr,
                exit_code: result.exit_code,
                duration_ms: result.duration_ms,
            },
            Err(error) => {
                log::warn!(
                    "mise_action_command_failed command={} error={}",
                    command.line,
                    error
                );
                MiseExecutedCommand {
                    command: command.line.clone(),
                    stdout: String::new(),
                    stderr: error.message,
                    exit_code: -1,
                    duration_ms: started.elapsed().as_millis() as u64,
                }
            }
        };

        let mut finished = progress(
            MiseActionProgressKind::CommandFinished,
            command,
            command_index,
            total_commands,
        );
        finished.exit_code = Some(executed_command.exit_code);
        emit_progress(app, finished);

        let failed = executed_command.exit_code != 0;
        let output = if failed {
            format!("{}\n{}", executed_command.stdout, executed_command.stderr)
        } else {
            String::new()
        };
        executed.push(executed_command);

        if failed {
            let report = cleanup_after_failed_action(&snapshot, &output);
            if has_findings(&report) {
                let mut cleanup_progress = progress(
                    MiseActionProgressKind::LockfileCleanup,
                    command,
                    command_index,
                    total_commands,
                );
                cleanup_progress.lockfile_cleanup = Some(report.clone());
                emit_progress(app, cleanup_progress);
                lockfile_cleanup = Some(report);
            }
            break;
        }
    }

    let action_result = MiseActionResult {
        script: script.to_string(),
        commands: executed,
        lockfile_cleanup,
    };
    record_history(&action_result);
    Ok(action_result)
}

fn spawn_output_forwarder(
    app: tauri::AppHandle,
    line: String,
    command_index: usize,
    total_commands: usize,
    mut receiver: UnboundedReceiver<MiseOutputChunk>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(chunk) = receiver.recv().await {
            emit_progress(
                &app,
                MiseActionProgress {
                    kind: MiseActionProgressKind::Output,
                    command: line.clone(),
                    command_index,
                    total_commands,
                    output: Some(chunk.text),
                    output_source: Some(chunk.source),
                    exit_code: None,
                    lockfile_cleanup: None,
                },
            );
        }
    })
}

fn progress(
    kind: MiseActionProgressKind,
    command: &ScriptCommand,
    command_index: usize,
    total_commands: usize,
) -> MiseActionProgress {
    MiseActionProgress {
        kind,
        command: command.line.clone(),
        command_index,
        total_commands,
        output: None,
        output_source: None,
        exit_code: None,
        lockfile_cleanup: None,
    }
}

fn emit_progress(app: &tauri::AppHandle, payload: MiseActionProgress) {
    if let Err(error) = app.emit(PROGRESS_EVENT, payload) {
        log::warn!("mise_action_progress_emit_failed error={error}");
    }
}

/// Parse the script into validated commands. Comments and blank lines are
/// skipped; every other line must start with `mise `.
pub(crate) fn parse_script(script: &str) -> MiseResult<Vec<ScriptCommand>> {
    let mut commands = Vec::new();

    for line in script.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if !trimmed.starts_with("mise ") {
            return Err(MiseError::unsafe_command(
                "Only mise commands can be run from the Environment page.",
            ));
        }
        let args = parse_arguments(trimmed[5..].trim_start())?;
        commands.push(ScriptCommand {
            line: trimmed.to_string(),
            args,
        });
    }

    Ok(commands)
}

/// Split one argument string into argv entries. Single and double quotes group
/// whitespace, empty arguments are kept, and shell operators are rejected.
pub(crate) fn parse_arguments(input: &str) -> MiseResult<Vec<String>> {
    let mut arguments = Vec::new();
    let mut characters = input.chars().peekable();

    while let Some(character) = characters.next() {
        if character.is_whitespace() {
            continue;
        }

        let mut token = String::new();
        if character == '"' || character == '\'' {
            let quote = character;
            let mut closed = false;
            for next in characters.by_ref() {
                if next == quote {
                    closed = true;
                    break;
                }
                token.push(next);
            }
            if !closed {
                return Err(MiseError::unsafe_command(
                    "The script contains an unterminated quote.",
                ));
            }
        } else {
            token.push(character);
            while let Some(&next) = characters.peek() {
                if next.is_whitespace() {
                    break;
                }
                token.push(next);
                characters.next();
            }
        }

        if is_shell_operator(&token) {
            return Err(MiseError::unsafe_command(
                "The script contains a shell operator.",
            ));
        }
        arguments.push(token);
    }

    Ok(arguments)
}

fn is_shell_operator(token: &str) -> bool {
    matches!(
        token,
        "&&" | "||" | "|" | ";" | ">" | "<" | ">>" | "<<" | "&" | "2>" | "2>>" | ">&" | "2>&1"
    ) || token.contains('`')
        || token.contains("$(")
}

/// One scan of mise's lock directories, keyed by the normalized file path.
#[derive(Debug, Default)]
pub(crate) struct LockfileSnapshot {
    modified: HashMap<String, SystemTime>,
}

/// Record the lockfiles that exist before the action starts.
pub(crate) fn capture_lockfiles() -> LockfileSnapshot {
    let mut modified = HashMap::new();

    for directory in lockfile_directories() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let Ok(modified_at) = metadata.modified() else {
                continue;
            };
            modified.insert(normalize_path_key(&path), modified_at);
        }
    }

    LockfileSnapshot { modified }
}

/// The lockfile sweep after a failed command: paths named in the output plus
/// files that appeared or changed since the snapshot, each deleted only when it
/// sits directly under a `mise/lockfiles` directory.
pub(crate) fn cleanup_after_failed_action(
    snapshot: &LockfileSnapshot,
    output: &str,
) -> MiseLockfileReport {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for path in extract_lockfile_paths(output)
        .into_iter()
        .chain(changed_lockfiles(snapshot))
    {
        if seen.insert(path.clone()) {
            candidates.push(path);
        }
    }

    let mut report = MiseLockfileReport {
        removed_paths: Vec::new(),
        failed_paths: Vec::new(),
        detected_paths: Vec::new(),
    };

    for path in candidates {
        if !is_safe_lockfile_path(&path) {
            report.detected_paths.push(path);
            continue;
        }
        let file = PathBuf::from(&path);
        if !file.is_file() {
            report.detected_paths.push(path);
            continue;
        }
        match std::fs::remove_file(&file) {
            Ok(()) => report.removed_paths.push(path),
            Err(error) => {
                log::warn!("mise_lockfile_remove_failed path={path} error={error}");
                report.failed_paths.push(path);
            }
        }
    }

    report
}

fn lockfile_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();

    if let Some(value) = non_empty_env("MISE_CACHE_DIR") {
        directories.push(PathBuf::from(value).join("lockfiles"));
    }
    if let Some(value) = non_empty_env("XDG_CACHE_HOME") {
        directories.push(PathBuf::from(value).join("mise").join("lockfiles"));
    }
    if let Some(home) = paths::home_dir() {
        directories.push(home.join(".cache").join("mise").join("lockfiles"));
    }
    if let Some(value) = non_empty_env("LOCALAPPDATA") {
        directories.push(PathBuf::from(value).join("mise").join("lockfiles"));
    }

    directories
}

/// Lock paths mentioned in the command output, with a leading `~` expanded.
pub(crate) fn extract_lockfile_paths(output: &str) -> Vec<String> {
    let mut paths = Vec::new();

    for raw in output.split_whitespace() {
        let token = raw.trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '`' | '(' | ')' | '[' | ']' | ',' | ';' | ':'
            )
        });
        let normalized = token.replace('\\', "/").to_ascii_lowercase();
        let Some(marker) = normalized.find("/mise/lockfiles/") else {
            continue;
        };
        if marker + "/mise/lockfiles/".len() >= normalized.len() {
            continue;
        }
        paths.push(expand_home(token));
    }

    paths
}

fn changed_lockfiles(snapshot: &LockfileSnapshot) -> Vec<String> {
    let mut changed = Vec::new();

    for directory in lockfile_directories() {
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let Ok(modified_at) = metadata.modified() else {
                continue;
            };
            let previous = snapshot.modified.get(&normalize_path_key(&path));
            if previous.is_none_or(|previous| modified_at > *previous) {
                changed.push(path.to_string_lossy().into_owned());
            }
        }
    }

    changed
}

/// Only a path directly under `mise/lockfiles` is deleted, and never a
/// directory itself or a path that walks upwards.
pub(crate) fn is_safe_lockfile_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    normalized.contains("/mise/lockfiles/")
        && !normalized.ends_with("/mise/lockfiles/")
        && !normalized.contains("/../")
}

fn normalize_path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = paths::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

pub(crate) fn has_findings(report: &MiseLockfileReport) -> bool {
    !report.removed_paths.is_empty()
        || !report.failed_paths.is_empty()
        || !report.detected_paths.is_empty()
}

/// English summary of a lockfile sweep, used in the history detail.
pub(crate) fn cleanup_detail(report: &MiseLockfileReport) -> Option<String> {
    if !has_findings(report) {
        return None;
    }

    let mut parts = Vec::new();
    if !report.removed_paths.is_empty() {
        parts.push(format!(
            "Removed {} stale mise lockfile(s).",
            report.removed_paths.len()
        ));
        parts.extend(
            report
                .removed_paths
                .iter()
                .map(|path| format!("removed: {path}")),
        );
    }
    if !report.failed_paths.is_empty() {
        parts.push(format!(
            "{} lockfile(s) could not be removed; delete them manually after other mise processes exit.",
            report.failed_paths.len()
        ));
        parts.extend(
            report
                .failed_paths
                .iter()
                .map(|path| format!("still present: {path}")),
        );
    }
    if !report.detected_paths.is_empty() {
        parts.extend(
            report
                .detected_paths
                .iter()
                .map(|path| format!("detected lock path: {path}")),
        );
    }

    Some(parts.join("\n"))
}

fn record_history(result: &MiseActionResult) {
    let success = result.is_success();
    let detail = if success {
        "Completed from the Environment page.".to_string()
    } else {
        let mut parts = vec![format!(
            "The action stopped after {} command(s) with exit code {}.",
            result.commands.len(),
            result.exit_code()
        )];
        if let Some(report) = &result.lockfile_cleanup {
            if let Some(cleanup) = cleanup_detail(report) {
                parts.push(cleanup);
            }
        }
        parts.join("\n")
    };

    let mut entry = history::new_entry(
        &result.script,
        &detail,
        if success {
            MiseHealthLevel::Healthy
        } else {
            MiseHealthLevel::Warning
        },
        if success {
            MiseHistoryStatus::Success
        } else {
            MiseHistoryStatus::Failure
        },
    );
    entry.exit_code = Some(result.exit_code());
    entry.duration_ms = Some(result.duration_ms());
    let stdout = result.stdout();
    if !stdout.is_empty() {
        entry.stdout = Some(stdout);
    }
    let stderr = result.stderr();
    if !stderr.is_empty() {
        entry.stderr = Some(stderr);
    }
    entry.stdout_snippet = result.stdout_snippet();
    entry.stderr_snippet = result.stderr_snippet();

    // History is diagnostic; failing to record it must not change the result
    // the user sees.
    if let Err(error) = history::append(entry) {
        log::warn!("mise_action_history_append_failed error={error}");
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let sequence = SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let stamp = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default();
            let path =
                std::env::temp_dir().join(format!("mise-actions-test-{label}-{stamp}-{sequence}"));
            std::fs::create_dir_all(&path).expect("failed to create scratch directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn command_line(command: &ScriptCommand) -> &str {
        &command.line
    }

    #[test]
    fn comments_and_blank_lines_are_skipped() {
        let commands =
            parse_script("# install\n\n  mise install node@22.0.0  \n").expect("valid script");
        assert_eq!(commands.len(), 1);
        assert_eq!(command_line(&commands[0]), "mise install node@22.0.0");
        assert_eq!(
            commands[0].args,
            vec!["install".to_string(), "node@22.0.0".to_string()]
        );
    }

    #[test]
    fn a_non_mise_line_is_refused() {
        let error = parse_script("echo hello").expect_err("echo is not allowed");
        assert_eq!(error.code, crate::error::MiseErrorCode::UnsafeCommand);
    }

    #[test]
    fn a_bare_mise_without_arguments_is_refused() {
        let error = parse_script("mise").expect_err("a bare mise line is not a command");
        assert_eq!(error.code, crate::error::MiseErrorCode::UnsafeCommand);
    }

    #[test]
    fn quoted_arguments_keep_their_whitespace() {
        let arguments = parse_arguments("use --global \"node@22.0.0\" 'two words' \"\"")
            .expect("valid arguments");
        assert_eq!(
            arguments,
            vec![
                "use".to_string(),
                "--global".to_string(),
                "node@22.0.0".to_string(),
                "two words".to_string(),
                String::new(),
            ]
        );
    }

    #[test]
    fn an_unterminated_quote_is_refused() {
        let error = parse_arguments("'broken").expect_err("the quote is not closed");
        assert_eq!(error.code, crate::error::MiseErrorCode::UnsafeCommand);
    }

    #[test]
    fn shell_operators_are_refused() {
        for operator in ["&&", "||", "|", ";", ">", "<", ">>", "2>", "&"] {
            let input = format!("install node@22.0.0 {operator} rm");
            let error = parse_arguments(&input).expect_err("the operator must be refused");
            assert_eq!(error.code, crate::error::MiseErrorCode::UnsafeCommand);
        }
        assert!(parse_arguments("install 'node@22.0.0'").is_ok());
    }

    #[test]
    fn lockfile_paths_are_extracted_from_output() {
        let output =
            "error: could not lock C:\\Users\\me\\AppData\\Local\\mise\\lockfiles\\node-22.lock\n";
        let paths = extract_lockfile_paths(output);
        assert_eq!(
            paths,
            vec![r"C:\Users\me\AppData\Local\mise\lockfiles\node-22.lock".to_string()]
        );
    }

    #[test]
    fn only_paths_under_lockfiles_are_safe() {
        assert!(is_safe_lockfile_path(
            "C:/Users/me/AppData/Local/mise/lockfiles/node.lock"
        ));
        assert!(is_safe_lockfile_path(r"D:\cache\mise\lockfiles\py.lock"));
        assert!(!is_safe_lockfile_path(
            "C:/Users/me/AppData/Local/mise/lockfiles/"
        ));
        assert!(!is_safe_lockfile_path(
            "C:/Users/me/AppData/Local/mise/lockfiles/../secret.txt"
        ));
        assert!(!is_safe_lockfile_path("C:/Users/me/notes.txt"));
    }

    #[test]
    fn changed_files_are_detected_against_the_snapshot() {
        let scratch = Scratch::new("lockfiles");
        let directory = scratch.path().join("lockfiles");
        std::fs::create_dir_all(&directory).unwrap();
        let existing = directory.join("old.lock");
        std::fs::write(&existing, b"old").unwrap();

        let snapshot = LockfileSnapshot {
            modified: HashMap::from([(normalize_path_key(&existing), SystemTime::now())]),
        };
        let fresh = directory.join("new.lock");
        std::fs::write(&fresh, b"new").unwrap();

        let changed = changed_lockfiles_in(&snapshot, &[directory.clone()]);
        assert_eq!(changed.len(), 1);
        assert_eq!(PathBuf::from(&changed[0]), fresh);
    }

    #[test]
    fn a_safe_lockfile_is_removed_and_an_unsafe_one_is_only_reported() {
        let scratch = Scratch::new("cleanup");
        let directory = scratch.path().join("mise").join("lockfiles");
        std::fs::create_dir_all(&directory).unwrap();
        let lock = directory.join("node.lock");
        std::fs::write(&lock, b"lock").unwrap();
        // Looks like a lockfile path but walks upwards, so it must only be
        // reported, never deleted.
        let traversal_path = directory.join("..").join("keep.txt");
        std::fs::write(&traversal_path, b"keep").unwrap();

        let output = format!("{}\n{}", lock.display(), traversal_path.display());
        let report = cleanup_after_failed_action(&LockfileSnapshot::default(), &output);

        assert!(!lock.exists(), "the lockfile must be removed");
        assert!(traversal_path.exists(), "a traversing path must survive");
        assert_eq!(report.removed_paths.len(), 1);
        assert_eq!(report.detected_paths.len(), 1);
    }

    #[test]
    fn a_clean_sweep_reports_nothing() {
        let report = cleanup_after_failed_action(&LockfileSnapshot::default(), "no paths here");
        assert!(!has_findings(&report));
        assert_eq!(cleanup_detail(&report), None);
    }

    #[test]
    fn the_cleanup_detail_is_english() {
        let report = MiseLockfileReport {
            removed_paths: vec!["C:/cache/mise/lockfiles/a.lock".to_string()],
            failed_paths: Vec::new(),
            detected_paths: Vec::new(),
        };
        let detail = cleanup_detail(&report).expect("findings produce a detail");
        assert!(detail.contains("Removed 1"));
        assert!(detail.contains("a.lock"));
    }

    /// Same as `changed_lockfiles`, but over explicit directories so the test
    /// never touches the real cache.
    fn changed_lockfiles_in(snapshot: &LockfileSnapshot, directories: &[PathBuf]) -> Vec<String> {
        let mut changed = Vec::new();
        for directory in directories {
            let Ok(entries) = std::fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let Ok(modified_at) = entry.metadata().and_then(|metadata| metadata.modified())
                else {
                    continue;
                };
                let previous = snapshot.modified.get(&normalize_path_key(&path));
                if previous.is_none_or(|previous| modified_at > *previous) {
                    changed.push(path.to_string_lossy().into_owned());
                }
            }
        }
        changed
    }

    fn executed(
        command: &str,
        stdout: &str,
        stderr: &str,
        exit_code: i32,
        duration_ms: u64,
    ) -> MiseExecutedCommand {
        MiseExecutedCommand {
            command: command.to_string(),
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            exit_code,
            duration_ms,
        }
    }

    #[test]
    fn the_action_result_aggregates_every_command() {
        let success = MiseActionResult {
            script: "mise install node@22.0.0".to_string(),
            commands: vec![
                executed("mise install node@22.0.0", "installed\n", "", 0, 120),
                executed("mise use node@22.0.0", "", "warning text\n", 0, 30),
            ],
            lockfile_cleanup: None,
        };
        assert!(success.is_success());
        assert_eq!(success.exit_code(), 0);
        assert_eq!(success.duration_ms(), 150);
        assert_eq!(success.stdout(), "installed\n");
        assert_eq!(success.stderr(), "warning text\n");
        assert_eq!(success.stdout_snippet().as_deref(), Some("installed"));
        assert_eq!(success.stderr_snippet().as_deref(), Some("warning text"));

        let failure = MiseActionResult {
            script: "mise install node@22.0.0".to_string(),
            commands: vec![
                executed("mise install node@22.0.0", "partial", "", 0, 10),
                executed(
                    "mise use node@22.0.0",
                    "",
                    "line one\nline two\nline three\nline four\n",
                    2,
                    20,
                ),
            ],
            lockfile_cleanup: None,
        };
        assert!(!failure.is_success());
        assert_eq!(failure.exit_code(), 2);
        assert_eq!(
            failure.stderr_snippet().as_deref(),
            Some("line one\nline two\nline three")
        );
        assert_eq!(failure.stdout(), "partial");
    }
}
