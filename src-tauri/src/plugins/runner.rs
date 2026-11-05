//! Runs a plugin's entry script and streams its output.
//!
//! A plugin is an ordinary script — nothing here is sandboxed. It runs as the
//! user, with the user's files and network access, which is why installing one
//! leaves it disabled until the user turns it on.
//!
//! Nothing is injected into the run: a plugin reads its own config files, which
//! the config window edits directly. The only things the app sets are the paths
//! a script cannot work out for itself — `PLUGIN_ID` and `PLUGIN_DIR`.
//!
//! Every line the app sees is also written to a durable per-plugin log (see
//! [`super::log`]), so the run stays readable after the window is closed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;

use super::log;
use crate::proc::{forward, NoWindow, Stream};

/// How long a declared stop script gets before the app gives up on it.
///
/// Generous, because stopping a daemon can involve waiting for it to release a
/// port — but bounded, because a script that waits for input must not leave the
/// Stop button spinning forever.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(60);

/// One message of a streamed plugin run.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OutputEvent {
    /// A single line of the script's output.
    Line { stream: String, text: String },
    /// The script exited; `code` is its exit status.
    Done { code: i32 },
    /// The script could not be started, or the run could not be set up.
    Failed { message: String },
}

/// Plugins this app started and has not seen exit: id → pid.
///
/// This answers "did *we* start it", which is not the same as "is it up" — a
/// plugin can be serving from an earlier run, or from outside the app. Callers
/// deciding what to show should ask whether its address answers instead (see
/// `plugins_probe`); this table is what tells Stop which process it may kill.
fn running_table() -> &'static Mutex<HashMap<String, u32>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn is_running(id: &str) -> bool {
    running_table()
        .lock()
        .map(|table| table.contains_key(id))
        .unwrap_or(false)
}

fn mark_running(id: &str, pid: u32) {
    if let Ok(mut table) = running_table().lock() {
        table.insert(id.to_string(), pid);
    }
}

/// Forgets a plugin only when the process that just exited is the one on record.
///
/// A plugin can be stopped and started again before the old process's pipes
/// close. Without the pid check that thread would deregister its replacement,
/// leaving a live process the app can no longer find.
fn mark_stopped(id: &str, pid: u32) {
    if let Ok(mut table) = running_table().lock() {
        if table.get(id) == Some(&pid) {
            table.remove(id);
        }
    }
}

/// Ids of the plugins currently running, sorted.
pub fn running() -> Vec<String> {
    let mut ids: Vec<String> = running_table()
        .lock()
        .map(|table| table.keys().cloned().collect())
        .unwrap_or_default();
    ids.sort();
    ids
}

/// What a start attempt did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Started {
    /// This call launched the script.
    Now,
    /// A copy was already up; nothing was launched.
    AlreadyRunning,
}

/// Starts `entry` unless that plugin is already running.
///
/// Launching twice is not an error the caller should have to avoid — the plugin
/// page asks on every visit — so it is reported instead.
///
/// There is no stop script here: stopping reads it from the manifest, because a
/// plugin can be up without this app having started it (see [`stop`]).
pub fn start(id: &str, dir: &Path, entry: &str) -> Result<Started, String> {
    if is_running(id) {
        return Ok(Started::AlreadyRunning);
    }
    launch(id, dir, entry, None).map(|()| Started::Now)
}

/// Stops a plugin.
///
/// **A declared `stopScript` is the whole job.** It is the plugin's own
/// shutdown, it is what reaches daemons the app never started, and it works on
/// an instance this app did not launch — so when there is one, the app runs it
/// and does nothing else. It deliberately does *not* also kill the process
/// tree: the script knows how to end its own plugin, and a second, cruder
/// mechanism running behind its back can only cut a shutdown short.
///
/// The process-tree kill is the fallback for a plugin that declares no script,
/// where there is nothing else to end it with.
///
/// `dir` and `stop_script` come from the manifest rather than from the running
/// table, because a plugin can be up without this app having started it.
///
/// Returns whether anything was done. An `Err` is the stop script's.
pub fn stop(
    id: &str,
    dir: &Path,
    stop_script: Option<&str>,
    timeout: Duration,
) -> Result<bool, String> {
    let pid = running_table()
        .lock()
        .ok()
        .and_then(|mut table| table.remove(id));

    if let Some(script) = stop_script
        .map(str::trim)
        .filter(|script| !script.is_empty())
    {
        return match run_stop_script(id, dir, script, timeout) {
            Ok(()) => {
                log::note(id, "stopped");
                Ok(true)
            }
            Err(error) => {
                log::failed(id, &error);
                Err(error)
            }
        };
    }

    match pid {
        Some(pid) => {
            crate::proc::kill_tree_of(pid);
            log::note(id, "stopped");
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Runs one plugin on its own thread, so the caller returns immediately.
///
/// The stream always ends with `done` or `failed`.
pub fn spawn(id: String, dir: PathBuf, entry: String, on_event: Channel<OutputEvent>) {
    std::thread::spawn(move || run_one(&id, &dir, &entry, &on_event));
}

/// [`run`], reporting a failure as an event instead of returning it.
pub fn run_one(id: &str, dir: &Path, entry: &str, on_event: &Channel<OutputEvent>) {
    if let Err(message) = run(id, dir, entry, on_event) {
        log::failed(id, &message);
        let _ = on_event.send(OutputEvent::Failed { message });
    }
}

/// Runs `entry` inside `dir`, forwarding its output to `on_event`.
pub fn run(
    id: &str,
    dir: &Path,
    entry: &str,
    on_event: &Channel<OutputEvent>,
) -> Result<(), String> {
    // Refused rather than started a second time: the copy would fail on
    // whatever the first one holds, and that failure would be the user's only
    // clue as to why nothing worked.
    if is_running(id) {
        return Err(format!("Plugin '{id}' is already running."));
    }

    launch(id, dir, entry, Some(on_event.clone()))
}

/// Starts the script and streams it on a thread of its own.
///
/// Registration happens before the streaming thread starts, so a second caller
/// arriving while the script is still booting already sees it as running.
fn launch(
    id: &str,
    dir: &Path,
    entry: &str,
    on_event: Option<Channel<OutputEvent>>,
) -> Result<(), String> {
    let entry_path = dir.join(entry);
    if !entry_path.is_file() {
        return Err(format!("Entry script not found: {}", entry_path.display()));
    }

    let mut command = Command::new("cmd");
    command
        .arg("/C")
        // The full path, not the bare entry name: `cmd` only looks in the
        // current directory when the environment allows it, and
        // `NoDefaultCurrentDirectoryInExePath` forbids it. That variable is set
        // for every shell Git Bash and MSYS2 start, so the app inherits it
        // whenever it is launched with `pnpm tauri dev` and a relative name
        // would never be found.
        .arg(&entry_path)
        .current_dir(dir)
        // Without this the packaged app — a GUI binary with no console of its
        // own — makes Windows create one for the script, flashing a black
        // window on every run.
        .creation_flags_no_window()
        .env("PLUGIN_ID", id)
        .env("PLUGIN_DIR", dir)
        // Nothing reads stdin, and inheriting it would let the script sit on a
        // prompt nobody can answer.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start the plugin: {error}"))?;

    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let pid = child.id();
    log::begin(id, entry);
    mark_running(id, pid);

    let owner = id.to_string();
    let log_id = id.to_string();
    std::thread::spawn(move || {
        let (sender, receiver) = mpsc::channel();
        forward(stdout, Stream::Stdout, sender.clone());
        forward(stderr, Stream::Stderr, sender.clone());
        // Drop our own handle so the loop ends once both readers hit EOF.
        drop(sender);

        for (stream, text) in receiver {
            let name = stream_name(stream);
            log::line(&log_id, name, &text);
            if let Some(channel) = &on_event {
                let _ = channel.send(OutputEvent::Line {
                    stream: name.to_string(),
                    text,
                });
            }
        }

        // The pipes end when the process does, so it has already exited. A
        // plugin stopped from the app removed its own record, and `mark_stopped`
        // declines to touch whatever took its place.
        let code = child
            .wait()
            .map(|status| status.code().unwrap_or(-1))
            .unwrap_or(-1);
        mark_stopped(&owner, pid);
        log::finish(&log_id, code);

        if let Some(channel) = &on_event {
            let _ = channel.send(OutputEvent::Done { code });
        }
    });

    Ok(())
}

/// Runs a plugin's declared stop script, forwarding its output to the log.
///
/// stdin is the null device for the same reason the entry script's is: a script
/// ending in `pause` — as the portable bundles' own stop scripts do — would
/// otherwise wait forever for a keypress nobody can give.
fn run_stop_script(id: &str, dir: &Path, script: &str, timeout: Duration) -> Result<(), String> {
    let path = dir.join(script);
    if !path.is_file() {
        return Err(format!("Stop script not found: {}", path.display()));
    }

    log::note(id, &format!("running stop script {script}"));

    let mut child = Command::new("cmd")
        .arg("/C")
        .arg(&path)
        .current_dir(dir)
        .creation_flags_no_window()
        .env("PLUGIN_ID", id)
        .env("PLUGIN_DIR", dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to run stop script '{script}': {error}"))?;

    if let Some(stdout) = child.stdout.take() {
        forward_to_log(id.to_string(), stdout, Stream::Stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        forward_to_log(id.to_string(), stderr, Stream::Stderr);
    }

    wait_with_timeout(child, script, timeout)
}

/// Waits for a child, killing it once `timeout` has passed.
fn wait_with_timeout(mut child: Child, script: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(-1);
                if code == 0 {
                    return Ok(());
                }
                return Err(format!("Stop script '{script}' exited with code {code}."));
            }
            Ok(None) => {}
            Err(error) => {
                return Err(format!(
                    "Failed to wait for stop script '{script}': {error}"
                ))
            }
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Stop script '{script}' timed out after {timeout:?}."
            ));
        }

        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Reads a stop script's stream into the plugin log on a thread of its own.
fn forward_to_log(id: String, stream: impl std::io::Read + Send + 'static, kind: Stream) {
    std::thread::spawn(move || {
        let (sender, receiver) = mpsc::channel();
        forward(stream, kind, sender);
        for (kind, text) in receiver {
            log::line(&id, stream_name(kind), &text);
        }
    });
}

fn stream_name(stream: Stream) -> &'static str {
    match stream {
        Stream::Stdout => "stdout",
        Stream::Stderr => "stderr",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The tests below share one global table, so each uses an id of its own.

    #[test]
    fn a_running_plugin_is_on_record_until_it_exits() {
        assert!(!is_running("unit-live"));

        mark_running("unit-live", 4242);
        assert!(is_running("unit-live"));

        mark_stopped("unit-live", 4242);
        assert!(!is_running("unit-live"));
    }

    /// A plugin can be stopped and restarted before the first process's pipes
    /// close. The old thread must not deregister its replacement.
    #[test]
    fn a_late_exit_does_not_forget_a_newer_run() {
        mark_running("unit-restart", 1);
        mark_running("unit-restart", 2);
        mark_stopped("unit-restart", 1);

        assert!(
            is_running("unit-restart"),
            "the newer run must stay registered"
        );

        mark_stopped("unit-restart", 2);
        assert!(!is_running("unit-restart"));
    }

    #[test]
    fn stopping_something_that_is_not_running_reports_it() {
        // No process of ours and nothing declared to run, so there is nothing
        // to do — and it must not reach taskkill.
        let dir = Path::new(".");
        assert!(!stop("unit-nothing-runs-under-this", dir, None, STOP_TIMEOUT).unwrap());
    }

    /// The point of the manifest-supplied stop script: a plugin can be serving
    /// from a run this app never started, and only its own script can end that.
    /// Stop must therefore run the script even with no process on record.
    #[test]
    fn a_stop_script_runs_even_when_the_process_is_not_ours() {
        let dir = std::env::temp_dir().join(format!("plugin-stop-orphan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("stop.cmd"), "@echo off\nexit /b 0\n").unwrap();

        // Nothing registered under this id.
        assert!(!is_running("unit-stop-orphan"));
        let done = stop("unit-stop-orphan", &dir, Some("stop.cmd"), STOP_TIMEOUT).unwrap();
        assert!(
            done,
            "the declared stop script should count as doing something"
        );
    }

    #[test]
    fn running_lists_the_ids_that_are_up() {
        mark_running("unit-listed", 7);
        assert!(running().contains(&"unit-listed".to_string()));
        mark_stopped("unit-listed", 7);
        assert!(!running().contains(&"unit-listed".to_string()));
    }

    /// A declared stop script that does not exist is reported rather than
    /// silently skipped — it is a manifest mistake the author should see.
    #[test]
    fn a_missing_stop_script_is_reported() {
        let dir = std::env::temp_dir().join(format!("plugin-stop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let error =
            run_stop_script("unit-stop-missing", &dir, "stop.cmd", STOP_TIMEOUT).unwrap_err();
        assert!(error.contains("not found"), "{error}");
    }

    /// A stop script that never exits must not hold the Stop button forever.
    #[test]
    fn a_stop_script_that_hangs_is_killed_at_the_timeout() {
        let dir = std::env::temp_dir().join(format!("plugin-stop-hang-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // `ping` with a large count is a portable sleep that exits on its own;
        // killing it is what the test observes.
        std::fs::write(
            dir.join("hang.cmd"),
            "@echo off\r\nping -n 60 127.0.0.1 >nul\r\n",
        )
        .unwrap();

        let started = Instant::now();
        let error = run_stop_script(
            "unit-stop-hang",
            &dir,
            "hang.cmd",
            Duration::from_millis(300),
        )
        .unwrap_err();

        assert!(error.contains("timed out"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the wait was not bounded"
        );
    }

    /// A stop script that exits cleanly is not an error.
    #[test]
    fn a_stop_script_that_succeeds_reports_ok() {
        let dir = std::env::temp_dir().join(format!("plugin-stop-ok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("stop.cmd"),
            "@echo off\r\necho stopping\r\nexit /b 0\r\n",
        )
        .unwrap();

        run_stop_script("unit-stop-ok", &dir, "stop.cmd", STOP_TIMEOUT).unwrap();
    }
}
