//! The `codeg-server` process the Codeg page is served by.
//!
//! The app owns the process rather than asking the user to start one by hand:
//! opening the Codeg page starts it, closing the app kills it. That ownership is
//! what makes the feature usable after a fresh install — a page that needs a
//! server nobody started is a page that never loads.
//!
//! Lifetime, in one place:
//!
//! 1. [`start`] validates the configuration *before* spawning anything, because
//!    the two failures a developer actually hits — a binary that has not been
//!    built, and a port something else holds — are much clearer here than in the
//!    child's output a second later.
//! 2. The child is spawned with the four variables Codeg reads
//!    (`CODEG_HOST`/`CODEG_PORT`/`CODEG_TOKEN`/`CODEG_STATIC_DIR`/
//!    `CODEG_DATA_DIR`), its output drained into a ring buffer the settings page
//!    shows, and its exit watched so a crash is reported instead of leaving the
//!    page on "starting".
//! 3. Readiness is a poll of a real endpoint (`/api/get_system_language_settings`,
//!    the one public route), not a fixed sleep: the export loads a full database
//!    client and a scan of the workspace, so the interval is not predictable.
//! 4. [`stop`] and [`shutdown`] kill the tree by pid. `Child::kill` alone would
//!    leave the process the server daemonises free to keep the port.
//!
//! Which binary and which export it runs is [`Mode`]: the archive the app
//! installed for itself ([`crate::codeg::install`]), or a developer's checkout.
//! One process serves one mode at a time, so a start in the other mode stops the
//! running one first.

use std::collections::VecDeque;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::codeg::install;
use crate::config::{self, CodegConfig};
use crate::proc::{self, NoWindow, Stream};

/// How long a start waits for the server to answer.
const READY_TIMEOUT: Duration = Duration::from_secs(25);
/// How often the readiness probe asks while it waits.
const READY_POLL: Duration = Duration::from_millis(150);
/// Lines of the child's own output kept for the settings page.
const LOG_LINES: usize = 200;
/// File holding the access token, in the app's data directory.
///
/// Not inside Codeg's data directory: that directory belongs to Codeg, and an
/// extra file in it would be something the user's real installation does not
/// have. Not in the config either, because the settings page saves the whole
/// config from a draft it loaded earlier and would then be able to write back a
/// token from before it was generated.
const TOKEN_FILE: &str = "codeg-token";

/// Emitted with the [`Status`] whenever it moves, so a page that is still
/// showing the embed can put its error up when the server behind it goes away.
pub const STATUS_EVENT: &str = "codeg-status";

/// What the process is doing.
///
/// Serialised with its own tag so the page can switch on `status` and read the
/// address or the message in the same object.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Status {
    /// Nothing started in this run, or the last run was stopped.
    Stopped,
    /// Spawned, not answering yet.
    Starting,
    /// Answering; this is the address the page loads.
    Ready { url: String },
    /// Gave up: the message is what the page shows.
    Failed { message: String },
}

impl Default for Status {
    fn default() -> Self {
        Status::Stopped
    }
}

/// Where the server this app runs comes from.
///
/// The process handling is identical either way, so the mode only decides which
/// executable and which export a start uses — and which page asked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// A checkout the developer builds; paths from `config.codeg`.
    Dev,
    /// The archive the app installed under the data directory.
    Installed,
}

impl Mode {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "dev" => Ok(Self::Dev),
            "installed" => Ok(Self::Installed),
            other => Err(format!("Unknown Codeg mode: {other}")),
        }
    }

    /// The label the page and the status event carry back.
    pub fn label(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Installed => "installed",
        }
    }
}

/// The paths one mode runs from, after the mode has been applied.
struct Layout {
    server_path: String,
    static_dir: String,
    /// The directory to run the server in, when there is one.
    repo_path: Option<PathBuf>,
}

/// Applies the mode to the configuration.
fn layout(config: &CodegConfig, mode: Mode) -> Layout {
    match mode {
        Mode::Dev => Layout {
            server_path: config.server_path.trim().to_string(),
            static_dir: config.static_dir.trim().to_string(),
            repo_path: Some(PathBuf::from(config.repo_path.trim())),
        },
        Mode::Installed => {
            let paths = install::paths();
            Layout {
                server_path: paths.server_path.to_string_lossy().to_string(),
                static_dir: paths.static_dir.to_string_lossy().to_string(),
                repo_path: Some(paths.dir),
            }
        }
    }
}

/// Everything the settings page and the Codeg page read in one call.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodegView {
    /// The development paths as configured, with the data directory resolved.
    pub settings: Settings,
    /// The server archive the app installed for itself, if any.
    pub install: install::InstallView,
    /// The mode the running (or last started) server runs, if any.
    pub running: Option<String>,
    pub server: Status,
    /// The access token this install uses; generated on first read, then fixed.
    pub token: String,
    /// The child's recent output, newest last. Shown when a start fails.
    pub log: Vec<String>,
}

/// The configuration as the backend resolved it.
///
/// `data_dir` is the effective directory, not the possibly blank field the user
/// typed, so the page can show where Codeg actually writes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub repo_path: String,
    pub static_dir: String,
    pub server_path: String,
    pub port: u16,
    pub data_dir: String,
    pub url: String,
}

/// The server's state, as one managed value.
#[derive(Default)]
pub struct CodegState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    status: Status,
    /// The mode the current run serves; `None` when nothing runs.
    mode: Option<Mode>,
    /// Bumped when a run starts or ends, so a watcher belonging to an earlier
    /// run cannot write over the current one — a stop followed by a start would
    /// otherwise let the first child's exit mark the second one failed.
    generation: u64,
    pid: Option<u32>,
    token: String,
    log: VecDeque<String>,
}

impl CodegState {
    /// The lock, with a poisoned mutex treated as usable.
    ///
    /// Nothing here can leave a half-updated invariant behind — every field is
    /// replaced, never a pair that has to agree — so recovering is better than
    /// failing every later call for the rest of the run.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// Tells every window what the server is doing now.
///
/// Called after the lock is released — the readers take the same lock — and
/// never fatal: a window that cannot be reached is one that is going away.
fn announce(app: &AppHandle) {
    let status = {
        let state = app.state::<CodegState>();
        let inner = state.lock();
        inner.status.clone()
    };
    let _ = app.emit(STATUS_EVENT, status);
}

/// The state as the page reads it.
pub fn view(app: &AppHandle) -> CodegView {
    let config = config::load().codeg;
    let state = app.state::<CodegState>();
    let mut inner = state.lock();

    // Generated on the first look rather than on the first start: the settings
    // page shows the token, and one that only appeared after a start would look
    // like a setting that had not been saved.
    let token = match ensure_token() {
        Ok(token) => {
            inner.token = token.clone();
            token
        }
        Err(error) => {
            if inner.token.is_empty() {
                push_line(&mut inner, Stream::Stderr, &error);
            }
            inner.token.clone()
        }
    };

    CodegView {
        settings: settings_of(&config),
        install: install::view(),
        running: inner.mode.map(Mode::label).map(str::to_string),
        server: inner.status.clone(),
        token,
        log: inner.log.iter().cloned().collect(),
    }
}

/// The token this install uses, generated and persisted on first use.
pub fn token(app: &AppHandle) -> Result<String, String> {
    let state = app.state::<CodegState>();
    let mut inner = state.lock();
    if !inner.token.is_empty() {
        return Ok(inner.token.clone());
    }
    let token = ensure_token()?;
    inner.token = token.clone();
    Ok(token)
}

/// Starts the server for `mode`, and waits until it answers.
///
/// Returns the failure as an error *and* records it in the state, so whichever
/// of the page and the settings window is open shows the same thing.
pub async fn start(app: AppHandle, mode: Mode) -> Result<Status, String> {
    let config = config::load().codeg;

    // One process at a time, and one configuration with it: a server started for
    // the other mode serves another export on the same port, so it is stopped
    // before this mode's server takes the port. A start in the mode already
    // running answers with the state it found instead of racing a second child.
    let switching = {
        let state = app.state::<CodegState>();
        let inner = state.lock();
        match inner.status {
            Status::Starting | Status::Ready { .. } => {
                if inner.mode == Some(mode) {
                    return Ok(inner.status.clone());
                }
                true
            }
            _ => false,
        }
    };
    if switching {
        end(&app, "codeg-server stopped: the page now runs the other mode");
    }

    let generation = {
        let state = app.state::<CodegState>();
        let mut inner = state.lock();
        inner.generation = inner.generation.wrapping_add(1);
        inner.pid = None;
        inner.mode = Some(mode);
        inner.log.clear();
        inner.status = Status::Starting;
        inner.generation
    };
    announce(&app);

    let prepared = match prepare(&config, mode) {
        Ok(prepared) => prepared,
        Err(error) => return Err(fail(&app, generation, error)),
    };

    let mut child = match spawn(&config, mode, &prepared) {
        Ok(child) => child,
        Err(error) => return Err(fail(&app, generation, error)),
    };

    let pid = child.id();
    {
        let state = app.state::<CodegState>();
        let mut inner = state.lock();
        inner.pid = Some(pid);
        push_line(
            &mut inner,
            Stream::Stdout,
            &format!(
                "codeg-server started (pid {pid}, {} mode) for {}",
                mode.label(),
                config.url()
            ),
        );
    }

    // The child's output goes to the ring buffer through one channel and one
    // thread, so the two pipes are drained concurrently — a full pipe would
    // otherwise block the server for as long as nobody reads it.
    let (sender, receiver) = mpsc::channel::<(Stream, String)>();
    if let Some(stdout) = child.stdout.take() {
        proc::forward(stdout, Stream::Stdout, sender.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        proc::forward(stderr, Stream::Stderr, sender);
    }
    let log_app = app.clone();
    std::thread::spawn(move || {
        for (stream, line) in receiver {
            let state = log_app.state::<CodegState>();
            let mut inner = state.lock();
            push_line(&mut inner, stream, &line);
        }
    });

    // Exit watcher: `wait` needs the `Child`, and nothing else does — stopping
    // goes through the pid, which is what reaches the whole tree anyway.
    let watch_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        exited(&watch_app, generation, code);
    });

    let url = config.url();
    match wait_ready(&app, generation, &url, &prepared.token).await {
        Ok(()) => Ok(Status::Ready { url }),
        Err(error) => Err(fail(&app, generation, error)),
    }
}

/// Stops the server and everything it spawned.
pub fn stop(app: &AppHandle) -> Status {
    end(app, "codeg-server stopped");
    Status::Stopped
}

/// Stops the server without recording anything, for the app's own exit.
///
/// The window is going away, so the log it would write to is about to be lost;
/// what matters is that the process tree dies with the app.
pub fn shutdown(app: &AppHandle) {
    let pid = {
        let state = app.state::<CodegState>();
        let mut inner = state.lock();
        inner.generation = inner.generation.wrapping_add(1);
        inner.status = Status::Stopped;
        inner.mode = None;
        inner.pid.take()
    };
    if let Some(pid) = pid {
        proc::kill_tree_of(pid);
    }
}

/// Refuses while the server is running, naming what was being done.
///
/// Its executable and its export are both inside the folder an install replaces,
/// and on Windows a running image cannot be replaced at all — so the caller is
/// told to stop the server rather than left with a locked file halfway through an
/// update.
pub fn assert_stopped(app: &AppHandle, what: &str) -> Result<(), String> {
    let state = app.state::<CodegState>();
    let inner = state.lock();
    if matches!(inner.status, Status::Starting | Status::Ready { .. }) {
        return Err(format!(
            "Stop the Codeg server before {what}: its executable sits in the folder being replaced."
        ));
    }
    Ok(())
}

/// Sets Codeg's own language, which lives in its database rather than in the
/// page.
///
/// The page would otherwise keep showing the language its database was created
/// with, whatever the app's own language is.
///
/// Written unconditionally: Codeg reads the language once at boot, so deciding
/// whether a reload is needed belongs to the caller, which cannot rely on this
/// call reporting a difference — the write of a superseded call may be the one
/// that lands last.
pub async fn set_language(app: &AppHandle, language: &str) -> Result<(), String> {
    let config = config::load().codeg;
    let token = token(app)?;
    let client = client()?;
    let body = serde_json::json!({
        "settings": { "mode": "manual", "language": language }
    });
    let response = client
        .post(format!(
            "{}/api/update_system_language_settings",
            config.url()
        ))
        .header("Authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Failed to reach the Codeg server: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "The Codeg server refused the language change (HTTP {}).",
            response.status()
        ));
    }
    Ok(())
}

/// What a start needs from the configuration, once it has been checked.
struct Prepared {
    token: String,
    data_dir: PathBuf,
}

/// Checks everything a start would fail on, before anything is spawned.
///
/// The messages name the fix, because each of these is a configuration mistake
/// rather than a bug: an unbuilt binary, a missing export, or a port in use.
fn prepare(config: &CodegConfig, mode: Mode) -> Result<Prepared, String> {
    let layout = layout(config, mode);

    let server = Path::new(&layout.server_path);
    if !server.is_file() {
        return Err(match mode {
            Mode::Dev => format!(
                "codeg-server was not found at {}. Build it with `cargo build \
                 --no-default-features --features server-bin --bin codeg-server`, or correct the \
                 path under Settings → Codeg (dev).",
                server.display()
            ),
            Mode::Installed => format!(
                "codeg-server was not found at {}. Install it under Settings → Codeg.",
                server.display()
            ),
        });
    }

    let static_dir = Path::new(&layout.static_dir);
    if !static_dir.is_dir() {
        return Err(match mode {
            Mode::Dev => format!(
                "The Codeg static export was not found at {}. Run `pnpm build` in the Codeg \
                 checkout, or correct the path under Settings → Codeg (dev).",
                static_dir.display()
            ),
            Mode::Installed => format!(
                "The Codeg static export was not found at {}. Install Codeg again under \
                 Settings → Codeg.",
                static_dir.display()
            ),
        });
    }

    // Bound and released immediately: this is the cheapest way to tell whether
    // the port is free, and the server itself would only report it after a
    // spawn, when the page is already showing a spinner.
    if let Err(error) = TcpListener::bind(("127.0.0.1", config.port)) {
        return Err(format!(
            "Port {} is already in use ({error}). Stop whatever holds it, or choose another \
             port under Settings → Codeg.",
            config.port
        ));
    }

    let data_dir = config.resolved_data_dir();
    std::fs::create_dir_all(&data_dir).map_err(|error| {
        format!(
            "Failed to create the Codeg data directory {}: {error}",
            data_dir.display()
        )
    })?;

    Ok(Prepared {
        token: ensure_token()?,
        data_dir,
    })
}

/// Spawns `codeg-server` with the environment Codeg reads.
fn spawn(config: &CodegConfig, mode: Mode, prepared: &Prepared) -> Result<Child, String> {
    let layout = layout(config, mode);
    let mut command = Command::new(&layout.server_path);

    // Run inside the install folder or the checkout when it is there: the server
    // resolves a handful of paths relative to its working directory.
    if let Some(repo) = layout.repo_path.filter(|repo| repo.is_dir()) {
        command.current_dir(repo);
    }

    command
        .env("CODEG_HOST", "127.0.0.1")
        .env("CODEG_PORT", config.port.to_string())
        .env("CODEG_TOKEN", &prepared.token)
        .env("CODEG_STATIC_DIR", &layout.static_dir)
        .env("CODEG_DATA_DIR", &prepared.data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags_no_window();

    command
        .spawn()
        .map_err(|error| format!("Failed to start {}: {error}", layout.server_path))
}

/// Polls the one public endpoint until it answers, the process dies, or the
/// timeout runs out.
async fn wait_ready(
    app: &AppHandle,
    generation: u64,
    url: &str,
    token: &str,
) -> Result<(), String> {
    let probe = format!("{url}/api/get_system_language_settings");
    let client = client()?;
    let deadline = Instant::now() + READY_TIMEOUT;

    loop {
        // A stop, or the process dying, ends the wait at once instead of
        // holding the page on "starting" for the rest of the timeout.
        {
            let state = app.state::<CodegState>();
            let inner = state.lock();
            if inner.generation != generation {
                return Err("The Codeg server start was cancelled.".to_string());
            }
            if let Status::Failed { message } = &inner.status {
                return Err(message.clone());
            }
        }

        let answered = client
            .post(&probe)
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false);

        if answered {
            let state = app.state::<CodegState>();
            let mut inner = state.lock();
            if inner.generation == generation {
                inner.status = Status::Ready {
                    url: url.to_string(),
                };
                push_line(&mut inner, Stream::Stdout, "codeg-server is ready");
            }
            drop(inner);
            announce(app);
            return Ok(());
        }

        if Instant::now() >= deadline {
            return Err(format!(
                "The Codeg server did not answer on {url} within {} seconds. See its output \
                 under Settings → Codeg.",
                READY_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(READY_POLL).await;
    }
}

/// Records a failure and hands the message back, so both readers of the state
/// see the same thing.
fn fail(app: &AppHandle, generation: u64, message: String) -> String {
    let state = app.state::<CodegState>();
    let mut inner = state.lock();
    if inner.generation == generation {
        inner.pid = None;
        inner.status = Status::Failed {
            message: message.clone(),
        };
        push_line(&mut inner, Stream::Stderr, &message);
    }
    drop(inner);
    announce(app);
    message
}

/// Kills the process tree and marks the server stopped.
fn end(app: &AppHandle, note: &str) {
    let pid = {
        let state = app.state::<CodegState>();
        let mut inner = state.lock();
        inner.generation = inner.generation.wrapping_add(1);
        inner.status = Status::Stopped;
        inner.mode = None;
        if inner.pid.is_some() {
            push_line(&mut inner, Stream::Stdout, note);
        }
        inner.pid.take()
    };

    if let Some(pid) = pid {
        proc::kill_tree_of(pid);
    }
    announce(app);
}

/// Called when the child exits on its own.
fn exited(app: &AppHandle, generation: u64, code: Option<i32>) {
    let state = app.state::<CodegState>();
    let mut inner = state.lock();
    // Superseded by a stop or a newer run: whoever replaced it owns the state.
    if inner.generation != generation {
        return;
    }
    inner.pid = None;
    let message = match code {
        Some(code) => format!("codeg-server exited with code {code}."),
        None => "codeg-server exited.".to_string(),
    };
    inner.status = Status::Failed {
        message: message.clone(),
    };
    push_line(&mut inner, Stream::Stderr, &message);
    drop(inner);
    announce(app);
}

/// An HTTP client for the loopback server.
///
/// `no_proxy` on purpose: the app exports its configured proxy into the
/// environment, and a probe for a server on the same machine has no business
/// going through it.
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("Failed to build the Codeg HTTP client: {error}"))
}

/// The access token, read from the app's data directory or generated there.
fn ensure_token() -> Result<String, String> {
    let path = config::dir().join(TOKEN_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        let token = text.trim().to_string();
        if !token.is_empty() {
            return Ok(token);
        }
    }

    let dir = config::dir();
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create {}: {error}", dir.display()))?;
    let token = uuid::Uuid::new_v4().to_string();
    std::fs::write(&path, format!("{token}\n"))
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    Ok(token)
}

/// The settings as the page shows them.
fn settings_of(config: &CodegConfig) -> Settings {
    Settings {
        repo_path: config.repo_path.clone(),
        static_dir: config.static_dir.clone(),
        server_path: config.server_path.clone(),
        port: config.port,
        data_dir: config.resolved_data_dir().display().to_string(),
        url: config.url(),
    }
}

/// Appends one line of the child's output, oldest first.
fn push_line(inner: &mut Inner, stream: Stream, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let text = match stream {
        Stream::Stdout => line.to_string(),
        Stream::Stderr => format!("[stderr] {line}"),
    };
    inner.log.push_back(text);
    while inner.log.len() > LOG_LINES {
        inner.log.pop_front();
    }
}
