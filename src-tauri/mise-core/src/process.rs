// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

//! Locating the `mise` executable and running it without a shell.
//!
//! The command layer never concatenates a command line: arguments arrive as an
//! array, the child is spawned directly, and its two output pipes are drained
//! concurrently while the call waits for exit, a deadline or a cancellation
//! token. The same reader accumulates bytes for the final UTF-8/GBK decode and
//! forwards text chunks to the caller for streaming.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::error::{MiseError, MiseErrorCode, MiseResult};
use crate::models::{MiseCommandResult, MiseOutputChunk, MiseOutputSource};
use crate::paths;

/// One pipe read.
const READ_BUFFER: usize = 8 * 1024;

/// How long to wait for the output readers once the child is gone. A
/// grandchild that inherited a pipe must not keep the command result hostage.
const STREAM_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Which of the wait branches won.
enum ExitOutcome {
    Exited(std::io::Result<std::process::ExitStatus>),
    TimedOut,
    Cancelled,
}

/// Resolve the mise executable. The search order is `MISE_EXECUTABLE`, `PATH`,
/// the app's own Scoop shims, then the usual per-user install locations.
pub fn resolve_executable() -> MiseResult<PathBuf> {
    resolve_executable_from(executable_candidates()).ok_or_else(|| {
        log::warn!("mise_executable_not_found");
        MiseError::mise_not_found("The mise executable could not be found.")
    })
}

/// The first candidate that exists, used by the probe and by tests.
pub fn resolve_executable_from(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// Candidate paths in priority order.
fn executable_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(configured) = non_empty_env("MISE_EXECUTABLE") {
        candidates.push(PathBuf::from(configured));
    }

    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            candidates.push(directory.join("mise"));
            // Windows executables need the extension; the bare name is kept
            // first so a shim script still wins over a stray `mise.exe`.
            #[cfg(windows)]
            candidates.push(directory.join("mise.exe"));
        }
    }

    if let Some(host_data_dir) = paths::host_data_dir() {
        candidates.push(
            host_data_dir
                .join("ScoopCurrent")
                .join("shims")
                .join("mise.exe"),
        );
    }

    if let Some(home) = paths::home_dir() {
        candidates.push(home.join(".local").join("bin").join("mise.exe"));
        candidates.push(home.join("scoop").join("shims").join("mise.exe"));
    }

    if let Some(local_app_data) = non_empty_env("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("mise")
                .join("bin")
                .join("mise.exe"),
        );
    }

    candidates
}

/// Decode console output: strict UTF-8 first, then GBK, then lossy.
pub fn decode_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }

    let (decoded, _, had_errors) = encoding_rs::GBK.decode(bytes);
    if had_errors {
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        decoded.into_owned()
    }
}

/// Run one `mise` invocation without a shell, streaming output when a sender is
/// provided. Cancellation and timeouts kill the child first.
#[allow(clippy::too_many_arguments)]
pub async fn run_command(
    args: &[String],
    working_directory: Option<&Path>,
    timeout: Duration,
    allow_non_zero: bool,
    cancel: Option<CancellationToken>,
    on_output: Option<UnboundedSender<MiseOutputChunk>>,
) -> MiseResult<MiseCommandResult> {
    if let Some(directory) = working_directory {
        if !directory.is_dir() {
            return Err(MiseError::invalid_input(
                "workingDirectory",
                "The working directory does not exist.",
            ));
        }
    }

    let executable = resolve_executable()?;
    let started = Instant::now();

    let mut command = Command::new(&executable);
    command.args(args);
    if let Some(directory) = working_directory {
        command.current_dir(directory);
    }
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    hide_console(&mut command);

    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            MiseError::mise_not_found("The mise executable could not be started.")
        } else {
            log::warn!("mise_command_spawn_failed error={error}");
            MiseError::internal("The mise command could not be started.")
        }
    })?;

    let stdout_task = tokio::spawn(read_stream(
        child.stdout.take(),
        MiseOutputSource::Stdout,
        on_output.clone(),
    ));
    let stderr_task = tokio::spawn(read_stream(
        child.stderr.take(),
        MiseOutputSource::Stderr,
        on_output,
    ));

    let outcome = wait_for_exit(&mut child, timeout, cancel).await;

    match outcome {
        ExitOutcome::TimedOut => {
            let _ = child.kill().await;
            drain(stdout_task).await;
            drain(stderr_task).await;
            log::warn!(
                "mise_command_timed_out duration_ms={}",
                started.elapsed().as_millis()
            );
            Err(MiseError::timeout(format!(
                "The mise command did not finish within {} seconds.",
                timeout.as_secs()
            )))
        }
        ExitOutcome::Cancelled => {
            let _ = child.kill().await;
            drain(stdout_task).await;
            drain(stderr_task).await;
            log::debug!(
                "mise_command_cancelled duration_ms={}",
                started.elapsed().as_millis()
            );
            Err(MiseError::cancelled())
        }
        ExitOutcome::Exited(result) => {
            let status = result.map_err(|error| {
                log::warn!("mise_command_wait_failed error={error}");
                MiseError::internal("The mise command could not be waited on.")
            })?;

            let stdout = decode_output(&drain(stdout_task).await);
            let stderr = decode_output(&drain(stderr_task).await);
            let exit_code = status.code().unwrap_or(-1);
            let duration_ms = started.elapsed().as_millis() as u64;

            log::debug!(
                "mise_command_finished exit_code={exit_code} duration_ms={duration_ms}"
            );

            if !status.success() && !allow_non_zero {
                return Err(MiseError::new(
                    MiseErrorCode::Internal,
                    "The mise command failed.",
                )
                .with_detail(serde_json::json!({
                    "exitCode": exit_code,
                    "stderr": stderr,
                })));
            }

            Ok(MiseCommandResult {
                stdout,
                stderr,
                exit_code,
                duration_ms,
            })
        }
    }
}

/// Wait for the child, the deadline or the cancellation, whichever comes first.
async fn wait_for_exit(
    child: &mut tokio::process::Child,
    timeout: Duration,
    cancel: Option<CancellationToken>,
) -> ExitOutcome {
    tokio::select! {
        result = child.wait() => ExitOutcome::Exited(result),
        _ = tokio::time::sleep(timeout) => ExitOutcome::TimedOut,
        _ = cancelled(cancel) => ExitOutcome::Cancelled,
    }
}

/// Await the token, or forever when the caller passed none.
async fn cancelled(cancel: Option<CancellationToken>) {
    match cancel {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}

/// Read one pipe to the end, forwarding decoded chunks as they arrive and
/// returning the raw bytes for the final whole-stream decode.
async fn read_stream(
    stream: Option<impl AsyncRead + Unpin + Send + 'static>,
    source: MiseOutputSource,
    sender: Option<UnboundedSender<MiseOutputChunk>>,
) -> Vec<u8> {
    let Some(stream) = stream else {
        return Vec::new();
    };

    let mut reader = BufReader::new(stream);
    let mut buffer = [0u8; READ_BUFFER];
    let mut bytes = Vec::new();

    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                bytes.extend_from_slice(&buffer[..read]);
                if let Some(sender) = &sender {
                    let text = decode_output(&buffer[..read]);
                    if !text.is_empty() {
                        let _ = sender.send(MiseOutputChunk { source, text });
                    }
                }
            }
            Err(error) => {
                log::warn!("mise_output_read_failed source={source:?} error={error}");
                break;
            }
        }
    }

    bytes
}

/// Collect a reader's bytes, but never wait on it forever.
async fn drain(task: JoinHandle<Vec<u8>>) -> Vec<u8> {
    match tokio::time::timeout(STREAM_DRAIN_TIMEOUT, task).await {
        Ok(Ok(bytes)) => bytes,
        _ => Vec::new(),
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Keep the child's console window hidden. A no-op off Windows.
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Keep the child's console window hidden. A no-op off Windows.
#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let sequence = SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default();
            let path = std::env::temp_dir().join(format!(
                "mise-process-test-{label}-{stamp}-{sequence}"
            ));
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

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime")
    }

    #[test]
    fn candidates_are_tried_in_order_and_missing_ones_are_skipped() {
        let scratch = Scratch::new("resolve");
        let first = scratch.path().join("first-mise");
        let second = scratch.path().join("second-mise");
        std::fs::write(&first, b"").unwrap();
        std::fs::write(&second, b"").unwrap();

        let resolved = resolve_executable_from(vec![
            scratch.path().join("missing-mise"),
            first.clone(),
            second.clone(),
        ]);

        assert_eq!(resolved, Some(first));
    }

    #[test]
    fn no_existing_candidate_resolves_to_none() {
        let scratch = Scratch::new("resolve-none");
        assert_eq!(
            resolve_executable_from(vec![
                scratch.path().join("missing-a"),
                scratch.path().join("missing-b"),
            ]),
            None
        );
    }

    #[test]
    fn directories_are_not_executables() {
        let scratch = Scratch::new("resolve-directory");
        assert_eq!(
            resolve_executable_from(vec![scratch.path().to_path_buf()]),
            None
        );
    }

    #[test]
    fn a_directory_before_a_file_is_skipped() {
        let scratch = Scratch::new("resolve-directory-first");
        let file = scratch.path().join("real-mise");
        std::fs::write(&file, b"").unwrap();

        assert_eq!(
            resolve_executable_from(vec![scratch.path().to_path_buf(), file.clone()]),
            Some(file)
        );
    }

    #[test]
    fn utf8_output_decodes_as_utf8() {
        assert_eq!(decode_output("mise 版本".as_bytes()), "mise 版本");
        assert_eq!(decode_output(&[]), "");
    }

    #[test]
    fn gbk_output_decodes_as_gbk() {
        let (encoded, _, had_errors) = encoding_rs::GBK.encode("mise 版本");
        assert!(!had_errors, "the test string must be encodable as GBK");
        assert_eq!(decode_output(&encoded), "mise 版本");
    }

    #[test]
    fn undecodable_bytes_fall_back_to_lossy_utf8() {
        let decoded = decode_output(&[0xFF, 0xFE, 0xFA]);
        assert!(!decoded.is_empty());
        assert!(decoded.contains('\u{FFFD}'));
    }

    #[test]
    fn a_missing_working_directory_is_invalid_input() {
        let scratch = Scratch::new("missing-directory");
        let missing = scratch.path().join("does-not-exist");
        let error = runtime()
            .block_on(run_command(
                &[],
                Some(&missing),
                Duration::from_secs(1),
                false,
                None,
                None,
            ))
            .expect_err("a missing working directory must be refused");

        assert_eq!(error.code, MiseErrorCode::InvalidInput);
    }

    #[test]
    #[ignore = "requires a local mise install"]
    fn real_mise_without_arguments_forwards_the_result() {
        let result = runtime()
            .block_on(run_command(
                &[],
                None,
                Duration::from_secs(15),
                true,
                None,
                None,
            ))
            .expect("an empty argument list must still produce a command result");

        // `mise` prints its usage when it has nothing to do; the process layer
        // must not invent arguments of its own.
        assert!(!result.stdout.is_empty() || !result.stderr.is_empty());
    }

    #[test]
    #[ignore = "requires a local mise install"]
    fn real_mise_version_runs() {
        let result = runtime()
            .block_on(run_command(
                &["--version".to_string()],
                None,
                Duration::from_secs(15),
                false,
                None,
                None,
            ))
            .expect("mise --version should succeed");

        assert!(!result.stdout.trim().is_empty());
        assert_eq!(result.exit_code, 0);
    }
}
