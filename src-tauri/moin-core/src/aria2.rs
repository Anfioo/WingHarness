// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! The aria2c transfer backend: a loopback RPC daemon started on demand.
//!
//! aria2c is not a service and not a sidecar here. It is a child of the app,
//! spawned the first time a task needs it, listening on a loopback port with a
//! secret that only ever lives in memory, and killed when the engine shuts down.
//! Control goes through JSON-RPC over HTTP, which needs no extra crate:
//! `reqwest` and `serde_json` are already dependencies.
//!
//! Two rules run through the file. The RPC secret and the query string of a task
//! URL must never reach a log line, so every message below names a method, a
//! task id or a gid and never a request body. And no `std::sync::Mutex` guard is
//! held across an `.await`: the session is cloned out of its slot, or taken out
//! of it entirely, before anything is awaited.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::process::Child;
use uuid::Uuid;

use crate::aria2_tool::{new_command, Aria2Tool};
use crate::backend::{Control, DownloadBackend, Outcome, ProgressFn, Signal, TransferOpts};
use crate::models::{now_ms, SegmentProgress, Task, TaskKind};
use crate::paths;

pub const ID: &str = "aria2";
pub const LABEL: &str = "aria2";

/// How often `aria2.tellStatus` is polled while a transfer runs.
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// How long the daemon gets to open its RPC port after it was spawned.
const READY_TIMEOUT: Duration = Duration::from_secs(5);
/// Deadline for a single RPC round trip.
const RPC_TIMEOUT: Duration = Duration::from_secs(10);
/// Consecutive failed status polls before a transfer is abandoned (~5 seconds).
const MAX_POLL_FAILURES: u32 = 10;
/// How long the daemon gets to answer `aria2.shutdown` before it is killed.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// aria2 rejects `--min-split-size` outside this range, so requests are clamped.
const MIN_SPLIT_FLOOR: u64 = 1024 * 1024;
const MIN_SPLIT_CEIL: u64 = 1024 * 1024 * 1024;
/// aria2 accepts at most sixteen connections per server.
const MAX_CONNECTIONS: usize = 16;

/// External download backend driven by a local `aria2c` RPC daemon.
pub struct Aria2Backend {
    tool: Arc<Aria2Tool>,
    data_dir: PathBuf,
    /// The running daemon, if one was started. `None` means "not started yet".
    session: Mutex<Option<Session>>,
    /// Serialises the start path so two tasks cannot spawn two daemons.
    start_gate: tokio::sync::Mutex<()>,
}

/// One live daemon: the child, the port it listens on and the secret it wants.
///
/// The secret is a random UUID per process start. It is never written to disk
/// and never logged, which is why this type has no `Debug` implementation.
struct Session {
    child: Child,
    port: u16,
    secret: String,
}

impl Aria2Backend {
    pub fn new(tool: Arc<Aria2Tool>, data_dir: PathBuf) -> Self {
        Self {
            tool,
            data_dir,
            session: Mutex::new(None),
            start_gate: tokio::sync::Mutex::new(()),
        }
    }

    /// `config::dir()/moin/aria2`, or a sibling of the data directory when the
    /// global has not been initialised yet (crate tests).
    fn control_dir(&self) -> PathBuf {
        paths::aria2_dir().unwrap_or_else(|_| self.data_dir.join("aria2"))
    }

    /// Clone the port and secret of a daemon that is still alive; kill and drop
    /// one that died behind our back so the next spawn starts clean.
    fn live_session(&self) -> Option<(u16, String)> {
        let mut slot = self.session.lock().ok()?;
        match slot.as_mut() {
            Some(session) => match session.child.try_wait() {
                Ok(None) => {}
                _ => {
                    if let Some(mut stale) = slot.take() {
                        let _ = stale.child.start_kill();
                    }
                    return None;
                }
            },
            None => return None,
        }
        let session = slot.as_ref()?;
        Some((session.port, session.secret.clone()))
    }

    /// Make sure a daemon is running and return where it listens. Called before
    /// every transfer; a warm session costs one `try_wait`.
    async fn ensure_session(&self) -> Result<(u16, String), String> {
        let _gate = self.start_gate.lock().await;
        if let Some(live) = self.live_session() {
            return Ok(live);
        }
        let mut last_error = String::new();
        for attempt in 1..=2 {
            match self.spawn_session().await {
                Ok(session) => {
                    let port = session.port;
                    let secret = session.secret.clone();
                    let mut slot = self
                        .session
                        .lock()
                        .map_err(|_| "The aria2c session lock is poisoned.".to_string())?;
                    if let Some(mut previous) = slot.replace(session) {
                        let _ = previous.child.start_kill();
                    }
                    return Ok((port, secret));
                }
                Err(error) => {
                    // The reserved port can be taken between `bind` and the
                    // child's `listen`; one retry covers that race.
                    log::warn!("Could not start the aria2c RPC daemon (attempt {attempt}): {error}");
                    last_error = error;
                }
            }
        }
        Err(last_error)
    }

    async fn spawn_session(&self) -> Result<Session, String> {
        let binary = self
            .tool
            .binary()
            .ok_or_else(|| "aria2c was not found".to_string())?;
        let port = free_port()?;
        let secret = Uuid::new_v4().to_string();
        let control_dir = self.control_dir();
        tokio::fs::create_dir_all(&control_dir)
            .await
            .map_err(|error| format!("Could not create the aria2c control directory: {error}"))?;
        let session_file = control_dir.join("session.txt");

        let mut command = new_command(&binary);
        command
            .arg("--enable-rpc")
            .arg("--rpc-listen-all=false")
            .arg(format!("--rpc-listen-port={port}"))
            .arg(format!("--rpc-secret={secret}"))
            .arg(format!("--dir={}", self.data_dir.display()))
            .arg("--continue=true")
            .arg("--auto-file-renaming=false")
            .arg("--summary-interval=0")
            .arg("--auto-save-interval=30")
            .arg("--save-session-interval=30")
            .arg(format!("--save-session={}", session_file.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // aria2 refuses to start when `--input-file` names a missing file, so the
        // saved session is only replayed once it exists.
        if session_file.exists() {
            command.arg(format!("--input-file={}", session_file.display()));
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start aria2c: {error}"))?;
        let rpc = Rpc::new(port, secret.clone());
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if rpc.version().await.is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.start_kill();
                let _ = tokio::time::timeout(STOP_TIMEOUT, child.wait()).await;
                return Err("aria2c did not open its RPC port in time.".to_string());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        log::info!("Started the aria2c RPC daemon on loopback port {port}.");
        Ok(Session {
            child,
            port,
            secret,
        })
    }

    /// One transfer: add the URI, follow it, then move the `.part` into place.
    async fn transfer(
        &self,
        task: Task,
        opts: TransferOpts,
        control: Control,
        progress: ProgressFn,
    ) -> Outcome {
        if !self.tool.is_available() {
            return Outcome::Failed("aria2c was not found".to_string());
        }
        let Some(options) = download_options(&task, opts) else {
            return Outcome::Failed("The download destination has no file name.".to_string());
        };
        let (port, secret) = match self.ensure_session().await {
            Ok(session) => session,
            Err(error) => return Outcome::Failed(error),
        };
        let rpc = Rpc::new(port, secret);
        let gid = match rpc.add_uri(&task.url, options).await {
            Ok(gid) => gid,
            Err(error) => return Outcome::Failed(error),
        };
        log::info!("aria2c accepted download {} as {gid}.", task.id);
        self.write_note(&task, &gid, port).await;

        let outcome = self.monitor(&rpc, &gid, opts, &control, &progress).await;
        match &outcome {
            Outcome::Completed => {
                let _ = rpc.remove_result(&gid).await;
                let part = PathBuf::from(task.part_path());
                let destination = PathBuf::from(&task.dest);
                if let Err(error) = finalize(&part, &destination).await {
                    self.clear_note(&task).await;
                    return Outcome::Failed(error);
                }
                if let Ok(metadata) = tokio::fs::metadata(&destination).await {
                    progress(metadata.len(), Some(metadata.len()), &[]);
                }
            }
            Outcome::Failed(message) => {
                log::warn!("aria2c download {} failed: {message}", task.id);
                let _ = rpc.remove_result(&gid).await;
            }
            _ => {}
        }
        self.clear_note(&task).await;
        outcome
    }

    /// Poll until the download ends, the user stops it, or it stops moving.
    async fn monitor(
        &self,
        rpc: &Rpc,
        gid: &str,
        opts: TransferOpts,
        control: &Control,
        progress: &ProgressFn,
    ) -> Outcome {
        let mut last_received = 0u64;
        let mut last_change = Instant::now();
        let mut failures = 0u32;
        loop {
            match control.signal() {
                Signal::Pause => {
                    if let Err(error) = rpc.pause(gid).await {
                        log::debug!("aria2c could not pause a download: {error}");
                    }
                    // A paused gid keeps the entry in aria2's download list, and
                    // the next attempt adds the same `<name>.part` again. Drop
                    // the entry here; the file stays on disk for `continue`.
                    stop(rpc, gid).await;
                    return Outcome::Paused;
                }
                Signal::Cancel => {
                    stop(rpc, gid).await;
                    return Outcome::Canceled;
                }
                Signal::Run => {}
            }

            match rpc.tell_status(gid).await {
                Ok(status) => {
                    let total = (status.total > 0).then_some(status.total);
                    let segments = simulated_segments(status.total, status.completed, opts.connections);
                    progress(status.completed, total, &segments);
                    match status.state.as_str() {
                        "complete" => return Outcome::Completed,
                        "removed" => return Outcome::Canceled,
                        "paused" => {
                            stop(rpc, gid).await;
                            return Outcome::Paused;
                        }
                        "error" => {
                            return Outcome::Failed(status.message.unwrap_or_else(|| {
                                "aria2c reported an error.".to_string()
                            }))
                        }
                        _ => {}
                    }
                    if status.completed > last_received {
                        last_received = status.completed;
                        last_change = Instant::now();
                    }
                    failures = 0;
                }
                Err(error) => {
                    // A daemon that died leaves every poll failing; with a stall
                    // window of zero the loop would never end, so give up after
                    // a short run of errors instead.
                    failures += 1;
                    if failures >= MAX_POLL_FAILURES {
                        log::warn!("Giving up on an aria2c download after {failures} failed polls.");
                        return Outcome::Failed(error);
                    }
                    log::warn!("aria2c status poll failed: {error}");
                }
            }

            if !opts.stall_timeout.is_zero() && last_change.elapsed() >= opts.stall_timeout {
                stop(rpc, gid).await;
                return Outcome::Stalled;
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// Record which gid belongs to which task under the control directory. The
    /// note holds no URL and no secret, only what a later run needs to explain a
    /// leftover process or a stale download.
    async fn write_note(&self, task: &Task, gid: &str, port: u16) {
        let folder = self.control_dir();
        if let Err(error) = tokio::fs::create_dir_all(&folder).await {
            log::warn!("Could not create the aria2c control directory: {error}");
            return;
        }
        let note = json!({
            "gid": gid,
            "port": port,
            "out": part_name(task),
            "dir": Path::new(&task.dest)
                .parent()
                .map(|folder| folder.to_string_lossy().into_owned()),
            "updated_at": now_ms(),
        });
        let path = folder.join(format!("{}.json", task.id));
        if let Err(error) = tokio::fs::write(&path, note.to_string()).await {
            log::warn!("Could not write the aria2c session note: {error}");
        }
    }

    async fn clear_note(&self, task: &Task) {
        let path = self.control_dir().join(format!("{}.json", task.id));
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::debug!("Could not remove the aria2c session note: {error}"),
        }
    }

    /// Ask the daemon to leave, then make sure it is gone.
    async fn stop_daemon(&self) {
        let session = self.session.lock().ok().and_then(|mut slot| slot.take());
        let Some(mut session) = session else {
            return;
        };
        let rpc = Rpc::new(session.port, session.secret.clone());
        match tokio::time::timeout(Duration::from_secs(2), rpc.shutdown()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::debug!("aria2c did not shut down over RPC: {error}"),
            Err(_) => log::warn!("aria2c ignored the shutdown request."),
        }
        let _ = session.child.start_kill();
        match tokio::time::timeout(STOP_TIMEOUT, session.child.wait()).await {
            Ok(Ok(_)) => log::info!("Stopped the aria2c RPC daemon."),
            Ok(Err(error)) => log::warn!("Could not reap the aria2c child: {error}"),
            Err(_) => log::warn!(
                "The aria2c child did not exit within {} seconds.",
                STOP_TIMEOUT.as_secs()
            ),
        }
    }
}

#[async_trait]
impl DownloadBackend for Aria2Backend {
    fn id(&self) -> &'static str {
        ID
    }

    fn label(&self) -> &'static str {
        LABEL
    }

    /// HTTP only: BitTorrent is out of scope for this port, so every torrent
    /// parameter and RPC call was dropped instead of being kept dormant.
    fn supports(&self, kind: TaskKind) -> bool {
        matches!(kind, TaskKind::Http)
    }

    fn available(&self) -> bool {
        self.tool.is_available()
    }

    async fn run(
        &self,
        task: Task,
        opts: TransferOpts,
        control: Control,
        progress: ProgressFn,
    ) -> Outcome {
        self.transfer(task, opts, control, progress).await
    }

    async fn shutdown(&self) {
        self.stop_daemon().await;
    }
}

/// Ask for a free loopback port.
///
/// aria2 cannot be told "pick a port yourself" over RPC, so the port is reserved
/// by binding and then released. Another process can win the race in between;
/// the caller retries the spawn once when that happens.
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Could not reserve a loopback port for aria2c: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read the reserved loopback port: {error}"))?
        .port();
    drop(listener);
    Ok(port)
}

/// `<file name>.part`, matching `Task::part_path` so the embedded and external
/// backends leave the same files behind.
fn part_name(task: &Task) -> Option<String> {
    Path::new(&task.dest)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| format!("{name}.part"))
}

/// The `options` object of `aria2.addUri`.
///
/// The download is written as `<name>.part` inside the destination folder, so a
/// paused or interrupted transfer is byte-for-byte the same artifact the
/// embedded backend produces, and `continue` resumes it on the next attempt.
fn download_options(task: &Task, opts: TransferOpts) -> Option<Value> {
    let part = part_name(task)?;
    let folder = Path::new(&task.dest).parent()?;
    let connections = opts.connections.clamp(1, MAX_CONNECTIONS);
    let min_split = opts.min_split_size.clamp(MIN_SPLIT_FLOOR, MIN_SPLIT_CEIL);
    let mut options = json!({
        "dir": folder.to_string_lossy(),
        "out": part,
        "continue": "true",
        "auto-file-renaming": "false",
        "allow-overwrite": "true",
        "file-allocation": "none",
        "max-tries": "1",
        "retry-wait": "0",
        "summary-interval": "0",
        "split": connections.to_string(),
        "max-connection-per-server": connections.to_string(),
        "min-split-size": min_split.to_string(),
    });
    if !task.headers.is_empty() {
        let headers: Vec<Value> = task
            .headers
            .iter()
            .map(|(name, value)| Value::String(format!("{name}: {value}")))
            .collect();
        options["header"] = Value::Array(headers);
    }
    Some(options)
}

/// Move the finished `.part` onto the destination path.
async fn finalize(part: &Path, destination: &Path) -> Result<(), String> {
    if !tokio::fs::try_exists(part).await.unwrap_or(false) {
        return Err("aria2c finished but left no partial file behind.".to_string());
    }
    if let Some(folder) = destination.parent() {
        let _ = tokio::fs::create_dir_all(folder).await;
    }
    tokio::fs::rename(part, destination)
        .await
        .map_err(|error| format!("Could not move the finished download into place: {error}"))
}

/// Remove a download and drop its result, so a stopped task leaves no entry in
/// the daemon's list.
async fn stop(rpc: &Rpc, gid: &str) {
    if let Err(error) = rpc.remove(gid).await {
        log::debug!("aria2c could not remove a download: {error}");
    }
    if let Err(error) = rpc.remove_result(gid).await {
        log::debug!("aria2c could not clear a download result: {error}");
    }
}

/// The `status` object of `aria2.tellStatus`, reduced to what the queue needs.
///
/// Throughput is not taken from aria2: the engine samples the byte rate itself,
/// so the two backends report speed the same way.
#[derive(Debug, Clone, Default)]
struct Status {
    state: String,
    completed: u64,
    total: u64,
    message: Option<String>,
}

impl Status {
    fn parse(value: &Value) -> Self {
        Self {
            state: value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            completed: number(value.get("completedLength")),
            total: number(value.get("totalLength")),
            message: value
                .get("errorMessage")
                .and_then(Value::as_str)
                .map(str::to_string)
                .filter(|text| !text.is_empty()),
        }
    }
}

/// aria2 reports every numeric field as a string; accept both shapes.
fn number(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::String(text)) => text.parse().unwrap_or_default(),
        Some(Value::Number(number)) => number.as_u64().unwrap_or_default(),
        _ => 0,
    }
}

/// Per-connection bars for the download list.
///
/// `aria2.tellStatus` exposes only the aggregate `completedLength`, never the
/// range each connection owns, so the split is even and the completed bytes are
/// spread across the segments. This is a presentation aid, not a measurement;
/// the embedded backend reports the real positions.
fn simulated_segments(total: u64, completed: u64, connections: usize) -> Vec<SegmentProgress> {
    if total == 0 {
        return Vec::new();
    }
    let limit = total.min(MAX_CONNECTIONS as u64) as usize;
    let count = connections.clamp(1, MAX_CONNECTIONS).min(limit.max(1));
    let completed = completed.min(total);
    let base = total / count as u64;
    let share = completed / count as u64;
    let mut remaining = completed;
    let mut start = 0u64;
    let mut segments = Vec::with_capacity(count);
    for index in 0..count {
        let end = if index + 1 == count {
            total - 1
        } else {
            start + base - 1
        };
        let length = end - start + 1;
        // The last segment absorbs the division remainder, capped so a segment
        // can never report more bytes than it owns.
        let received = if index + 1 == count {
            remaining.min(length)
        } else {
            share.min(length)
        };
        remaining = remaining.saturating_sub(received);
        segments.push(SegmentProgress {
            start,
            end,
            position: start + received,
        });
        start = end + 1;
    }
    segments
}

/// Minimal JSON-RPC client for the daemon.
struct Rpc {
    client: reqwest::Client,
    endpoint: String,
    secret: String,
}

impl Rpc {
    fn new(port: u16, secret: String) -> Self {
        let client = reqwest::Client::builder()
            .timeout(RPC_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            client,
            endpoint: format!("http://127.0.0.1:{port}/jsonrpc"),
            secret,
        }
    }

    /// aria2 wants the secret as the first positional parameter, prefixed with
    /// `token:`; everything else follows as the method's own parameters.
    fn body(&self, method: &str, params: Value) -> Value {
        let mut list = vec![Value::String(format!("token:{}", self.secret))];
        if let Value::Array(items) = params {
            list.extend(items);
        }
        json!({
            "jsonrpc": "2.0",
            "id": Uuid::new_v4().to_string(),
            "method": method,
            "params": list,
        })
    }

    /// One round trip. Errors name the method and quote aria2's own message;
    /// the request body is never included, because it carries the secret.
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = self.body(method, params);
        let response = self
            .client
            .post(&self.endpoint)
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("The aria2c RPC call {method} failed: {error}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| format!("The aria2c RPC reply to {method} could not be read: {error}"))?;
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|_| format!("The aria2c RPC reply to {method} was not JSON (HTTP {status})."))?;
        if let Some(error) = parsed.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            let code = error.get("code").and_then(Value::as_i64).unwrap_or_default();
            return Err(format!("aria2c rejected {method}: {message} (code {code})"));
        }
        parsed
            .get("result")
            .cloned()
            .ok_or_else(|| format!("The aria2c RPC reply to {method} carried no result."))
    }

    async fn version(&self) -> Result<(), String> {
        self.call("aria2.getVersion", json!([])).await.map(|_| ())
    }

    async fn add_uri(&self, url: &str, options: Value) -> Result<String, String> {
        let result = self.call("aria2.addUri", json!([[url], options])).await?;
        result
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "aria2c did not return a download id.".to_string())
    }

    async fn tell_status(&self, gid: &str) -> Result<Status, String> {
        let result = self
            .call(
                "aria2.tellStatus",
                json!([
                    gid,
                    [
                        "status",
                        "completedLength",
                        "totalLength",
                        "errorMessage",
                        "errorCode"
                    ]
                ]),
            )
            .await?;
        Ok(Status::parse(&result))
    }

    async fn pause(&self, gid: &str) -> Result<(), String> {
        self.call("aria2.pause", json!([gid])).await.map(|_| ())
    }

    async fn remove(&self, gid: &str) -> Result<(), String> {
        self.call("aria2.remove", json!([gid])).await.map(|_| ())
    }

    async fn remove_result(&self, gid: &str) -> Result<(), String> {
        self.call("aria2.removeDownloadResult", json!([gid]))
            .await
            .map(|_| ())
    }

    async fn shutdown(&self) -> Result<(), String> {
        self.call("aria2.shutdown", json!([])).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::models::TaskStatus;

    fn sample_task(dest: &str) -> Task {
        Task {
            id: "task-1".to_string(),
            kind: TaskKind::Http,
            url: "http://example.test/file.zip?token=secret-query".to_string(),
            filename: "file.zip".to_string(),
            dest: dest.to_string(),
            status: TaskStatus::Queued,
            total: None,
            received: 0,
            error: None,
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            active_ms: 0,
            backend: Some(ID.to_string()),
            category: None,
            final_dir: None,
            headers: BTreeMap::new(),
        }
    }

    fn quiet() -> ProgressFn {
        Arc::new(|_, _, _| {})
    }

    fn options() -> TransferOpts {
        TransferOpts {
            connections: 8,
            min_split_size: 1024 * 1024,
            hide_part: false,
            stall_timeout: Duration::from_secs(60),
        }
    }

    #[test]
    fn reserved_port_is_usable() {
        let port = free_port().expect("a free port");
        assert!(port > 0);
    }

    #[test]
    fn rpc_body_puts_the_token_first_and_keeps_it_out_of_the_method() {
        let rpc = Rpc::new(6800, "s3cret".to_string());
        let body = rpc.body("aria2.addUri", json!([["http://example.test/a"], {}]));
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["method"], json!("aria2.addUri"));
        let params = body["params"].as_array().expect("a parameter list");
        assert_eq!(params.len(), 3);
        assert_eq!(params[0], json!("token:s3cret"));
        assert_eq!(params[1], json!(["http://example.test/a"]));
    }

    #[test]
    fn download_options_target_the_part_file_next_to_the_destination() {
        let task = sample_task("/downloads/file.zip");
        let options = download_options(&task, options()).expect("options");
        assert_eq!(options["dir"], json!("/downloads"));
        assert_eq!(options["out"], json!("file.zip.part"));
        assert_eq!(options["continue"], json!("true"));
        assert_eq!(options["auto-file-renaming"], json!("false"));
        assert_eq!(options["split"], json!("8"));
        assert_eq!(options["max-connection-per-server"], json!("8"));
        assert!(options.get("header").is_none());
    }

    #[test]
    fn download_options_clamp_what_aria2_would_reject() {
        let task = sample_task("/downloads/file.zip");
        let opts = TransferOpts {
            connections: 64,
            min_split_size: 1024,
            hide_part: false,
            stall_timeout: Duration::ZERO,
        };
        let options = download_options(&task, opts).expect("options");
        assert_eq!(options["split"], json!("16"));
        assert_eq!(options["min-split-size"], json!(MIN_SPLIT_FLOOR.to_string()));
    }

    #[test]
    fn download_options_forward_request_headers() {
        let mut task = sample_task("/downloads/file.zip");
        task.headers
            .insert("Cookie".to_string(), "a=b".to_string());
        task.headers
            .insert("Referer".to_string(), "http://example.test/".to_string());
        let options = download_options(&task, options()).expect("options");
        assert_eq!(options["header"], json!(["Cookie: a=b", "Referer: http://example.test/"]));
    }

    #[test]
    fn a_destination_without_a_file_name_has_no_options() {
        let task = sample_task("/");
        assert!(download_options(&task, options()).is_none());
    }

    #[test]
    fn status_reads_aria2_string_lengths() {
        let status = Status::parse(&json!({
            "status": "active",
            "completedLength": "1024",
            "totalLength": "4096",
            "downloadSpeed": "512",
            "errorMessage": "",
        }));
        assert_eq!(status.state, "active");
        assert_eq!(status.completed, 1024);
        assert_eq!(status.total, 4096);
        assert!(status.message.is_none());
    }

    #[test]
    fn status_reads_an_error_message() {
        let status = Status::parse(&json!({
            "status": "error",
            "completedLength": "0",
            "totalLength": "0",
            "errorMessage": "Resource not found",
            "errorCode": "3",
        }));
        assert_eq!(status.state, "error");
        assert_eq!(status.message.as_deref(), Some("Resource not found"));
    }

    #[test]
    fn the_backend_reports_http_only_and_follows_the_tool() {
        let tool = Arc::new(Aria2Tool::new(None));
        let available = tool.is_available();
        let backend = Aria2Backend::new(tool, std::env::temp_dir());
        assert_eq!(backend.id(), ID);
        assert_eq!(backend.label(), LABEL);
        assert!(backend.supports(TaskKind::Http));
        assert!(!backend.supports(TaskKind::Media));
        assert_eq!(backend.available(), available);
    }

    /// A scripted stand-in for the daemon: it speaks just enough JSON-RPC to
    /// exercise the client, the poll loop and the stop paths without aria2c.
    mod fake {
        use std::collections::VecDeque;
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, Mutex};

        use serde_json::{json, Value};

        pub struct Daemon {
            pub port: u16,
            pub calls: Arc<Mutex<Vec<String>>>,
        }

        impl Daemon {
            /// `statuses` are handed out one per `tellStatus` call; once the
            /// queue is empty the daemon keeps reporting a still download.
            pub fn start(statuses: Vec<Value>) -> Self {
                let listener = TcpListener::bind("127.0.0.1:0").expect("a listener");
                let port = listener.local_addr().expect("a local address").port();
                let calls = Arc::new(Mutex::new(Vec::new()));
                let queue: Arc<Mutex<VecDeque<Value>>> =
                    Arc::new(Mutex::new(statuses.into_iter().collect()));
                let thread_calls = Arc::clone(&calls);
                std::thread::spawn(move || {
                    for stream in listener.incoming() {
                        let Ok(mut stream) = stream else { break };
                        let calls = Arc::clone(&thread_calls);
                        let queue = Arc::clone(&queue);
                        std::thread::spawn(move || {
                            let mut buffer = Vec::new();
                            let mut chunk = [0u8; 1024];
                            loop {
                                let Ok(read) = stream.read(&mut chunk) else { return };
                                if read == 0 {
                                    return;
                                }
                                buffer.extend_from_slice(&chunk[..read]);
                                if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                                    break;
                                }
                            }
                            let Some(split) = buffer
                                .windows(4)
                                .position(|window| window == b"\r\n\r\n")
                                .map(|index| index + 4)
                            else {
                                return;
                            };
                            let head = String::from_utf8_lossy(&buffer[..split]).to_string();
                            let mut length = 0usize;
                            for line in head.lines() {
                                if let Some((name, value)) = line.split_once(':') {
                                    if name.trim().eq_ignore_ascii_case("content-length") {
                                        length = value.trim().parse().unwrap_or(0);
                                    }
                                }
                            }
                            while buffer.len() < split + length {
                                let Ok(read) = stream.read(&mut chunk) else { return };
                                if read == 0 {
                                    break;
                                }
                                buffer.extend_from_slice(&chunk[..read]);
                            }
                            let body = String::from_utf8_lossy(&buffer[split..]).to_string();
                            let request: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                            let method = request["method"].as_str().unwrap_or_default().to_string();
                            calls.lock().expect("the call log").push(method.clone());
                            let result = match method.as_str() {
                                "aria2.getVersion" => json!({ "version": "1.37.0" }),
                                "aria2.addUri" => json!("gid-1"),
                                "aria2.tellStatus" => queue
                                    .lock()
                                    .expect("the status queue")
                                    .pop_front()
                                    .unwrap_or_else(|| {
                                        json!({
                                            "status": "active",
                                            "completedLength": "0",
                                            "totalLength": "0",
                                        })
                                    }),
                                _ => json!("OK"),
                            };
                            let payload = json!({
                                "jsonrpc": "2.0",
                                "id": request["id"].clone(),
                                "result": result,
                            })
                            .to_string();
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                                payload.len()
                            );
                            let _ = stream.write_all(response.as_bytes());
                            let _ = stream.flush();
                        });
                    }
                });
                Self { port, calls }
            }

            pub fn calls(&self) -> Vec<String> {
                self.calls.lock().expect("the call log").clone()
            }
        }
    }

    fn status(state: &str, completed: u64, total: u64) -> Value {
        json!({
            "status": state,
            "completedLength": completed.to_string(),
            "totalLength": total.to_string(),
        })
    }

    #[test]
    fn simulated_segments_cover_the_file_and_the_completed_bytes() {
        let segments = simulated_segments(4096, 2048, 4);
        assert_eq!(segments.len(), 4);
        assert_eq!(segments.first().map(|segment| segment.start), Some(0));
        assert_eq!(segments.last().map(|segment| segment.end), Some(4095));
        for pair in segments.windows(2) {
            assert_eq!(pair[0].end + 1, pair[1].start);
        }
        assert!(segments.iter().all(|segment| segment.position <= segment.end + 1));
        let received: u64 = segments
            .iter()
            .map(|segment| segment.position - segment.start)
            .sum();
        assert_eq!(received, 2048);
    }

    #[test]
    fn simulated_segments_never_split_more_ways_than_bytes() {
        let segments = simulated_segments(3, 3, 8);
        assert_eq!(segments.len(), 3);
        assert!(segments.iter().all(|segment| segment.position == segment.end + 1));
        assert!(simulated_segments(0, 0, 8).is_empty());
    }

    #[tokio::test]
    async fn the_rpc_client_reads_a_result_and_ignores_a_foreign_id() {
        let daemon = fake::Daemon::start(Vec::new());
        let rpc = Rpc::new(daemon.port, "s3cret".to_string());
        rpc.version().await.expect("a version reply");
        assert_eq!(daemon.calls(), vec!["aria2.getVersion".to_string()]);
    }

    #[tokio::test]
    async fn the_poll_loop_reports_progress_and_stops_at_complete() {
        let daemon = fake::Daemon::start(vec![
            status("active", 0, 100),
            status("active", 50, 100),
            status("complete", 100, 100),
        ]);
        let backend = Aria2Backend::new(Arc::new(Aria2Tool::new(None)), std::env::temp_dir());
        let rpc = Rpc::new(daemon.port, "s3cret".to_string());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);
        let progress: ProgressFn = Arc::new(move |received, total, _| {
            recorder
                .lock()
                .expect("the progress log")
                .push((received, total));
        });

        let outcome = backend
            .monitor(&rpc, "gid-1", options(), &Control::new(), &progress)
            .await;

        assert!(matches!(outcome, Outcome::Completed), "outcome: {outcome:?}");
        assert_eq!(
            *seen.lock().expect("the progress log"),
            vec![
                (0, Some(100)),
                (50, Some(100)),
                (100, Some(100))
            ]
        );
        assert!(!daemon.calls().iter().any(|call| call == "aria2.remove"));
    }

    #[tokio::test]
    async fn a_pause_signal_stops_the_download_and_drops_its_gid() {
        let daemon = fake::Daemon::start(Vec::new());
        let backend = Aria2Backend::new(Arc::new(Aria2Tool::new(None)), std::env::temp_dir());
        let rpc = Rpc::new(daemon.port, "s3cret".to_string());
        let control = Control::new();
        control.set(Signal::Pause);

        let outcome = backend
            .monitor(&rpc, "gid-1", options(), &control, &quiet())
            .await;

        assert!(matches!(outcome, Outcome::Paused), "outcome: {outcome:?}");
        let calls = daemon.calls();
        assert!(calls.contains(&"aria2.pause".to_string()));
        assert!(calls.contains(&"aria2.remove".to_string()));
        assert!(calls.contains(&"aria2.removeDownloadResult".to_string()));
    }

    #[tokio::test]
    async fn a_cancel_signal_removes_the_download() {
        let daemon = fake::Daemon::start(Vec::new());
        let backend = Aria2Backend::new(Arc::new(Aria2Tool::new(None)), std::env::temp_dir());
        let rpc = Rpc::new(daemon.port, "s3cret".to_string());
        let control = Control::new();
        control.set(Signal::Cancel);

        let outcome = backend
            .monitor(&rpc, "gid-1", options(), &control, &quiet())
            .await;

        assert!(matches!(outcome, Outcome::Canceled), "outcome: {outcome:?}");
        assert!(!daemon.calls().contains(&"aria2.pause".to_string()));
        assert!(daemon.calls().contains(&"aria2.remove".to_string()));
    }

    #[tokio::test]
    async fn an_error_state_becomes_a_failed_outcome_with_aria2s_message() {
        let daemon = fake::Daemon::start(vec![json!({
            "status": "error",
            "completedLength": "0",
            "totalLength": "0",
            "errorMessage": "Resource not found",
        })]);
        let backend = Aria2Backend::new(Arc::new(Aria2Tool::new(None)), std::env::temp_dir());
        let rpc = Rpc::new(daemon.port, "s3cret".to_string());

        let outcome = backend
            .monitor(&rpc, "gid-1", options(), &Control::new(), &quiet())
            .await;

        assert!(
            matches!(&outcome, Outcome::Failed(message) if message == "Resource not found"),
            "outcome: {outcome:?}"
        );
    }

    /// Serves a fixed payload over loopback so the test needs no network.
    fn serve_once(payload: Vec<u8>) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("a listener");
        let port = listener.local_addr().expect("a local address").port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let body = payload.clone();
                std::thread::spawn(move || {
                    use std::io::{Read, Write};
                    let mut buffer = [0u8; 4096];
                    let _ = stream.read(&mut buffer);
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: none\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes());
                    let _ = stream.write_all(&body);
                    let _ = stream.flush();
                });
            }
        });
        port
    }

    #[tokio::test]
    #[ignore = "requires a local aria2c on PATH"]
    async fn downloads_through_aria2_when_available() {
        let tool = Arc::new(Aria2Tool::new(std::env::var(crate::aria2_tool::ENV_VAR).ok()));
        assert!(
            tool.is_available(),
            "install aria2c or set WINGHARNESS_ARIA2 before running this test"
        );

        let payload: Vec<u8> = (0..256 * 1024).map(|index| (index % 251) as u8).collect();
        let port = serve_once(payload.clone());
        let workspace = tempfile::tempdir().expect("a temporary directory");
        let dest = workspace.path().join("payload.bin");
        let mut task = sample_task(&dest.to_string_lossy());
        task.url = format!("http://127.0.0.1:{port}/payload.bin");

        let backend = Aria2Backend::new(tool, workspace.path().to_path_buf());
        let outcome = backend
            .run(
                task,
                TransferOpts {
                    connections: 1,
                    min_split_size: 1024 * 1024,
                    hide_part: false,
                    stall_timeout: Duration::from_secs(60),
                },
                Control::new(),
                Arc::new(|_, _, _| {}),
            )
            .await;
        backend.shutdown().await;

        assert!(matches!(outcome, Outcome::Completed), "outcome: {outcome:?}");
        assert_eq!(std::fs::read(&dest).expect("the finished file"), payload);
        assert!(!workspace.path().join("payload.bin.part").exists());
    }

    /// The guard in `transfer` must fail fast instead of spawning anything. The
    /// assertion only applies on a machine without aria2c, so the test stays
    /// green either way.
    #[tokio::test]
    async fn a_missing_binary_fails_without_spawning_anything() {
        let tool = Arc::new(Aria2Tool::new(Some("definitely-not-here/aria2c.exe".to_string())));
        let backend = Aria2Backend::new(tool, std::env::temp_dir());
        if backend.available() {
            return;
        }
        let outcome = backend
            .run(
                sample_task("/tmp/file.zip"),
                options(),
                Control::new(),
                Arc::new(|_, _, _| {}),
            )
            .await;
        assert!(matches!(outcome, Outcome::Failed(message) if message == "aria2c was not found"));
    }
}
