//! Transfer queue: concurrency limit, recursive directory walks, progress,
//! pause / resume / cancel, and conflict resolution.
//!
//! The queue lives for the lifetime of the app so the window can be closed and
//! reopened without losing running transfers.
//!
//! Task granularity is the top-level source (one id per entry in `sources`,
//! matching `serverTransferStart`'s contract). A directory source is walked
//! once when the task starts, every file is queued in that walk, and the walk's
//! total size drives the progress figures. Data always lands in a `.part` file
//! first and is renamed into place once the last chunk is written, so a paused
//! or crashed transfer can restart from the `.part` size.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::Manager as _;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::error::{ServerError, ServerErrorCode, ServerResult};
use crate::events::{self, TransferDoneEvent, TransferProgressEvent};
use crate::local_fs;
use crate::models::{
    ConflictPolicy, EntryKind, SftpEntry, TransferDirection, TransferSnapshot, TransferState,
};
use crate::sftp::paths;
use crate::sftp::SftpHandle;
use crate::ServerState;

/// Bytes moved per read / write call.
const CHUNK_SIZE: usize = 32 * 1024;
/// At most one progress event per task in this window (plan D10).
const PROGRESS_THROTTLE: Duration = Duration::from_millis(100);
/// How many directory levels a transfer may descend (plan R5).
const MAX_SCAN_DEPTH: usize = 64;
/// Used when the preference file cannot be read on first use.
const DEFAULT_CONCURRENCY: u32 = 3;
/// How many `name (n).ext` candidates are tried before giving up.
const MAX_COLLISION_PROBES: u32 = 1000;
/// A stalled stream must not hang the queue forever.
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// Finished rows kept for the queue UI; the oldest are dropped first.
const MAX_FINISHED_ROWS: usize = 200;

const FLAG_RUNNING: u8 = 0;
const FLAG_PAUSE: u8 = 1;
const FLAG_CANCEL: u8 = 2;

// ---------------------------------------------------------------------------
// Process-wide queue
// ---------------------------------------------------------------------------

struct Queue {
    tasks: HashMap<String, Arc<TransferControl>>,
}

static QUEUE: OnceLock<Mutex<Queue>> = OnceLock::new();
static SLOTS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
/// Submission order, so `list` returns rows in a stable order.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn queue() -> &'static Mutex<Queue> {
    QUEUE.get_or_init(|| {
        Mutex::new(Queue {
            tasks: HashMap::new(),
        })
    })
}

/// The global transfer slots. The limit comes from the user's preference once,
/// on first use; a later preference change applies to the next app start.
fn slots() -> Arc<tokio::sync::Semaphore> {
    SLOTS
        .get_or_init(|| {
            Arc::new(tokio::sync::Semaphore::new(concurrency_limit()))
        })
        .clone()
}

fn concurrency_limit() -> usize {
    use crate::store::Store;

    Store::open()
        .and_then(|store| store.prefs())
        .map(|prefs| prefs.max_concurrent_transfers as usize)
        .unwrap_or(DEFAULT_CONCURRENCY as usize)
        .clamp(1, 10)
}

// ---------------------------------------------------------------------------
// Task model
// ---------------------------------------------------------------------------

/// One slot of work. Directories are expanded into the plan at start time, but
/// the task itself stays a single queue row.
#[derive(Debug, Clone)]
struct TransferRecord {
    id: String,
    sequence: u64,
    profile_id: String,
    direction: TransferDirection,
    /// Absolute source path (remote for downloads, local for uploads).
    source: String,
    /// Absolute destination path, already collision-resolved.
    target: String,
    state: TransferState,
    transferred: u64,
    total: u64,
    bytes_per_sec: u64,
    error: Option<String>,
    started_at: i64,
    policy: ConflictPolicy,
    plan: Plan,
    completed_files: usize,
}

impl TransferRecord {
    fn snapshot(&self) -> TransferSnapshot {
        TransferSnapshot {
            transfer_id: self.id.clone(),
            profile_id: self.profile_id.clone(),
            direction: self.direction,
            source: self.source.clone(),
            target: self.target.clone(),
            transferred: self.transferred,
            total: self.total,
            bytes_per_sec: self.bytes_per_sec,
            state: self.state,
            error: self.error.clone(),
        }
    }

    fn is_terminal(&self) -> bool {
        matches!(
            self.state,
            TransferState::Done | TransferState::Failed | TransferState::Cancelled
        )
    }
}

/// A directory transfer's file list, built once at start time.
#[derive(Debug, Clone, Default)]
struct Plan {
    /// Destination directories, parents before children.
    directories: Vec<String>,
    files: Vec<PlannedFile>,
    total_bytes: u64,
    /// True when the byte total is unknown; progress is then reported in files.
    by_count: bool,
}

#[derive(Debug, Clone)]
struct PlannedFile {
    source: String,
    target: String,
    size: u64,
    /// Skip policy found the target already in place.
    skip: bool,
}

/// Decide what the progress figures count and return the task total.
fn plan_progress(plan: &mut Plan) -> u64 {
    plan.by_count = plan.total_bytes == 0 && !plan.files.is_empty();
    if plan.by_count {
        plan.files.len() as u64
    } else {
        plan.total_bytes
    }
}

/// Shared control block of one task: flags, record, and the worker handle.
struct TransferControl {
    id: String,
    app: tauri::AppHandle,
    flags: AtomicU8,
    live: AtomicBool,
    record: Mutex<TransferRecord>,
    join: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl TransferControl {
    fn new(app: tauri::AppHandle, record: TransferRecord) -> Self {
        Self {
            id: record.id.clone(),
            app,
            flags: AtomicU8::new(FLAG_RUNNING),
            live: AtomicBool::new(false),
            record: Mutex::new(record),
            join: Mutex::new(None),
        }
    }

    fn request_pause(&self) {
        let _ = self
            .flags
            .compare_exchange(FLAG_RUNNING, FLAG_PAUSE, Ordering::SeqCst, Ordering::SeqCst);
    }

    /// Undo a pause that the worker has not observed yet; resume uses this when
    /// the task is still alive.
    fn clear_pause(&self) {
        let _ = self
            .flags
            .compare_exchange(FLAG_PAUSE, FLAG_RUNNING, Ordering::SeqCst, Ordering::SeqCst);
    }

    fn request_cancel(&self) {
        self.flags.store(FLAG_CANCEL, Ordering::SeqCst);
    }

    fn checkpoint(&self) -> Result<(), TaskFailure> {
        match self.flags.load(Ordering::SeqCst) {
            FLAG_PAUSE => Err(TaskFailure::Stop(Stop::Pause)),
            FLAG_CANCEL => Err(TaskFailure::Stop(Stop::Cancel)),
            _ => Ok(()),
        }
    }

    fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    fn record(&self) -> TransferRecord {
        self.record
            .lock()
            .map(|record| record.clone())
            .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
    }

    fn update(&self, apply: impl FnOnce(&mut TransferRecord)) {
        match self.record.lock() {
            Ok(mut record) => apply(&mut record),
            Err(poisoned) => apply(&mut poisoned.into_inner()),
        }
    }
}

/// Clears the live flag even when the worker unwinds.
struct LiveGuard(Arc<TransferControl>);

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.0.live.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Copy)]
enum Stop {
    Pause,
    Cancel,
}

enum TaskFailure {
    Stop(Stop),
    Error(ServerError),
}

impl From<Stop> for TaskFailure {
    fn from(stop: Stop) -> Self {
        TaskFailure::Stop(stop)
    }
}

impl From<ServerError> for TaskFailure {
    fn from(error: ServerError) -> Self {
        TaskFailure::Error(error)
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Queue one upload (`direction = upload`) or download.
///
/// Returns one id per top-level source; directory sources expand into tasks of
/// their own and do not recurse into symlinked directories.
pub async fn start(
    state: &ServerState,
    profile_id: &str,
    direction: TransferDirection,
    sources: Vec<String>,
    target_dir: &str,
    conflict_policy: ConflictPolicy,
) -> ServerResult<Vec<String>> {
    if profile_id.trim().is_empty() {
        return Err(ServerError::internal("A profile id is required."));
    }
    if sources.is_empty() {
        return Err(ServerError::internal("At least one source is required."));
    }
    if target_dir.trim().is_empty() || target_dir.contains('\0') {
        return Err(ServerError::path_invalid(target_dir));
    }

    // Fail before touching the queue when the connection is not ready.
    let handle = state.connections.sftp(profile_id).await?;

    // Two phases: a source that fails to prepare must not leave half a queue
    // behind, so nothing is registered until every record is built.
    let mut records = Vec::with_capacity(sources.len());
    for source in sources {
        let record = prepare(
            &handle,
            profile_id,
            direction,
            &source,
            target_dir,
            conflict_policy,
        )
        .await?;
        records.push(record);
    }

    let mut ids = Vec::with_capacity(records.len());
    for record in records {
        let control = Arc::new(TransferControl::new(state.app.clone(), record));
        register(control.clone())?;
        ids.push(control.id.clone());
        if !control.record().is_terminal() {
            spawn(control);
        }
    }
    Ok(ids)
}

pub async fn pause(transfer_id: &str) -> ServerResult<()> {
    let control = lookup(transfer_id)?;
    if !control.is_live() {
        return Err(ServerError::transfer_not_found(transfer_id));
    }
    control.request_pause();
    Ok(())
}

pub async fn resume(_state: &ServerState, transfer_id: &str) -> ServerResult<()> {
    let control = lookup(transfer_id)?;
    if control.is_live() {
        // The pause may not have reached a checkpoint yet; flip it back so the
        // click is not swallowed.
        control.clear_pause();
        return Ok(());
    }

    let record = control.record();
    if record.state != TransferState::Paused {
        return Err(ServerError::transfer_not_found(transfer_id));
    }

    control.update(|record| {
        record.state = TransferState::Pending;
        record.error = None;
        record.bytes_per_sec = 0;
    });
    control.flags.store(FLAG_RUNNING, Ordering::SeqCst);
    spawn(control);
    Ok(())
}

pub async fn cancel(transfer_id: &str) -> ServerResult<()> {
    let control = lookup(transfer_id)?;
    if control.is_live() {
        control.request_cancel();
        return Ok(());
    }

    let record = control.record();
    match record.state {
        TransferState::Done | TransferState::Cancelled => Ok(()),
        TransferState::Paused | TransferState::Failed => {
            // No worker is running, so clean up here: a paused task may have
            // left a `.part` for the file it was on.
            let app = control.app.clone();
            cleanup_parts(&app, &record).await;
            control.update(|record| {
                record.state = TransferState::Cancelled;
                record.error = Some("The transfer was cancelled.".to_string());
                record.plan = Plan::default();
            });
            events::emit(
                &app,
                events::SERVER_TRANSFER_DONE,
                TransferDoneEvent {
                    transfer_id: record.id.clone(),
                    state: TransferState::Cancelled,
                    error: Some("The transfer was cancelled.".to_string()),
                },
            );
            Ok(())
        }
        TransferState::Pending | TransferState::Running => Ok(()),
    }
}

/// Snapshot of every task still worth showing in the queue.
pub fn list() -> ServerResult<Vec<TransferSnapshot>> {
    let mut rows: Vec<TransferRecord> = match queue().lock() {
        Ok(queue) => queue.tasks.values().map(|task| task.record()).collect(),
        Err(poisoned) => poisoned
            .into_inner()
            .tasks
            .values()
            .map(|task| task.record())
            .collect(),
    };
    rows.sort_by_key(|record| record.sequence);
    Ok(rows.iter().map(TransferRecord::snapshot).collect())
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

fn lookup(transfer_id: &str) -> ServerResult<Arc<TransferControl>> {
    let tasks = queue()
        .lock()
        .map_err(|_| ServerError::internal("The transfer queue is unavailable."))?;
    tasks
        .tasks
        .get(transfer_id)
        .cloned()
        .ok_or_else(|| ServerError::transfer_not_found(transfer_id))
}

fn register(control: Arc<TransferControl>) -> ServerResult<()> {
    let mut tasks = queue()
        .lock()
        .map_err(|_| ServerError::internal("The transfer queue is unavailable."))?;
    tasks.tasks.insert(control.id.clone(), control);
    prune_finished(&mut tasks.tasks);
    Ok(())
}

/// Keep the queue map bounded: drop the oldest finished rows once there are too
/// many. Paused and running rows are never dropped.
fn prune_finished(tasks: &mut HashMap<String, Arc<TransferControl>>) {
    if tasks.len() <= MAX_FINISHED_ROWS {
        return;
    }

    let mut finished: Vec<(u64, String)> = tasks
        .iter()
        .filter_map(|(id, task)| {
            let record = task.record();
            if record.is_terminal() && !task.is_live() {
                Some((record.sequence, id.clone()))
            } else {
                None
            }
        })
        .collect();

    if finished.len() <= MAX_FINISHED_ROWS / 2 {
        return;
    }

    finished.sort_by_key(|(sequence, _)| *sequence);
    for (_, id) in finished {
        if tasks.len() <= MAX_FINISHED_ROWS / 2 {
            break;
        }
        tasks.remove(&id);
    }
}

fn spawn(control: Arc<TransferControl>) {
    control.live.store(true, Ordering::SeqCst);
    let app = control.app.clone();
    let worker = control.clone();
    let handle = tauri::async_runtime::spawn(async move {
        run_task(worker, app).await;
    });
    if let Ok(mut slot) = control.join.lock() {
        *slot = Some(handle);
    }
}

// ---------------------------------------------------------------------------
// Preparing a task: source classification, conflict resolution, plan
// ---------------------------------------------------------------------------

async fn prepare(
    handle: &SftpHandle,
    profile_id: &str,
    direction: TransferDirection,
    source: &str,
    target_dir: &str,
    policy: ConflictPolicy,
) -> ServerResult<TransferRecord> {
    let (source_path, source_entry) = match direction {
        TransferDirection::Upload => {
            let path = local_absolute(source)?;
            let entry = local_fs::stat(&path)?;
            (path, entry)
        }
        TransferDirection::Download => {
            let path = paths::normalize(source)?;
            let entry = handle.stat(&path).await?;
            (path, entry)
        }
    };

    let expected = if source_entry.kind == EntryKind::Dir && !source_entry.is_symlink {
        EntryKind::Dir
    } else {
        EntryKind::File
    };
    if expected == EntryKind::File && source_entry.is_symlink {
        log::warn!(
            "server_transfer_symlink_copy profile={profile_id} source={source_path}"
        );
    }

    let base_name = match direction {
        TransferDirection::Download => paths::sanitize_local_name(&source_entry.name),
        TransferDirection::Upload => source_entry.name.clone(),
    };

    // Resolve the top-level destination (file, or directory root) against the
    // conflict policy before any byte moves.
    let (target, skip) = match direction {
        TransferDirection::Download => {
            resolve_download_target(
                target_dir,
                &source_path,
                &base_name,
                expected,
                policy,
            )?
        }
        TransferDirection::Upload => {
            let target_dir = paths::normalize(target_dir)?;
            resolve_upload_target(handle, &target_dir, &source_path, &base_name, expected, policy)
                .await?
        }
    };

    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let id = build_transfer_id(profile_id, direction, &source_path, &target, sequence);
    let now = unix_now();

    if skip {
        return Ok(TransferRecord {
            id,
            sequence,
            profile_id: profile_id.to_string(),
            direction,
            source: source_path,
            target,
            state: TransferState::Done,
            transferred: 0,
            total: match expected {
                EntryKind::File => source_entry.size,
                EntryKind::Dir => 0,
            },
            bytes_per_sec: 0,
            error: None,
            started_at: now,
            policy,
            plan: Plan::default(),
            completed_files: 0,
        });
    }

    let plan = match (direction, expected) {
        (_, EntryKind::File) => Plan {
            directories: Vec::new(),
            files: vec![PlannedFile {
                source: source_path.clone(),
                target: target.clone(),
                size: source_entry.size,
                skip: false,
            }],
            total_bytes: source_entry.size,
            by_count: false,
        },
        (TransferDirection::Download, EntryKind::Dir) => {
            scan_remote(handle, &source_path, &target, profile_id).await?
        }
        (TransferDirection::Upload, EntryKind::Dir) => {
            let path = PathBuf::from(&source_path);
            let remote_root = target.clone();
            tokio::task::spawn_blocking(move || scan_local(&path, &remote_root))
                .await
                .map_err(|error| {
                    log::warn!("server_transfer_scan_task_failed error={error}");
                    ServerError::internal("The local directory could not be scanned.")
                })??
        }
    };

    let mut plan = plan;
    // A directory whose byte total is unknown (all-empty files, unreadable
    // metadata) still needs a progress figure, so it falls back to file counts.
    // A single empty file stays a byte transfer and simply reports 0 / 0.
    let total = if expected == EntryKind::Dir {
        plan_progress(&mut plan)
    } else {
        plan.total_bytes
    };

    Ok(TransferRecord {
        id,
        sequence,
        profile_id: profile_id.to_string(),
        direction,
        source: source_path,
        target,
        state: TransferState::Pending,
        transferred: 0,
        total,
        bytes_per_sec: 0,
        error: None,
        started_at: now,
        policy,
        plan,
        completed_files: 0,
    })
}

fn build_transfer_id(
    profile_id: &str,
    direction: TransferDirection,
    source: &str,
    target: &str,
    sequence: u64,
) -> String {
    let direction = match direction {
        TransferDirection::Upload => "upload",
        TransferDirection::Download => "download",
    };
    format!("{profile_id}:{direction}:{source}:{target}:{sequence}")
}

/// Outcome of applying the policy to an existing destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Proceed,
    Skip,
    Rename,
}

fn decide_conflict(
    policy: ConflictPolicy,
    source: &str,
    target: &str,
    existing: Option<EntryKind>,
    expected: EntryKind,
) -> ServerResult<Decision> {
    let Some(kind) = existing else {
        return Ok(Decision::Proceed);
    };

    match policy {
        ConflictPolicy::Ask => Err(conflict_choice(source, target)),
        ConflictPolicy::Skip => Ok(Decision::Skip),
        ConflictPolicy::Rename => Ok(Decision::Rename),
        ConflictPolicy::Overwrite => {
            if kind == expected {
                Ok(Decision::Proceed)
            } else {
                Err(ServerError::internal(format!(
                    "The target '{}' already exists with a different type.",
                    target
                )))
            }
        }
    }
}

fn conflict_choice(source: &str, target: &str) -> ServerError {
    ServerError::new(
        ServerErrorCode::ConflictRequiresChoice,
        "The target already exists and the conflict policy is ask.",
    )
    .with_detail(serde_json::json!({ "source": source, "target": target }))
}

fn local_absolute(path: &str) -> ServerResult<String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(ServerError::path_invalid(path));
    }
    let buffer = PathBuf::from(path);
    if !buffer.is_absolute() {
        return Err(ServerError::path_invalid(path));
    }
    Ok(path.to_string())
}

fn local_entry(path: &str) -> Option<EntryKind> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => Some(if metadata.file_type().is_dir() {
            EntryKind::Dir
        } else {
            EntryKind::File
        }),
        Err(_) => None,
    }
}

async fn remote_entry(handle: &SftpHandle, path: &str) -> ServerResult<Option<SftpEntry>> {
    match handle.stat(path).await {
        Ok(entry) => Ok(Some(entry)),
        Err(error) if error.code == ServerErrorCode::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

async fn remote_entry_kind(handle: &SftpHandle, path: &str) -> ServerResult<Option<EntryKind>> {
    Ok(remote_entry(handle, path)
        .await?
        .and_then(|entry| if entry.is_symlink { None } else { Some(entry.kind) }))
}

fn resolve_download_target(
    target_dir: &str,
    source: &str,
    base_name: &str,
    expected: EntryKind,
    policy: ConflictPolicy,
) -> ServerResult<(String, bool)> {
    let directory = PathBuf::from(local_absolute(target_dir)?);
    let directory = directory.to_string_lossy().into_owned();
    let target = local_join(&directory, base_name);

    match decide_conflict(policy, source, &target, local_entry(&target), expected)? {
        Decision::Proceed => Ok((target, false)),
        Decision::Skip => Ok((target, true)),
        Decision::Rename => {
            for index in 1..=MAX_COLLISION_PROBES {
                let name = paths::collision_name(base_name, index)?;
                let candidate = local_join(&directory, &name);
                if local_entry(&candidate).is_none() {
                    return Ok((candidate, false));
                }
            }
            Err(ServerError::internal(
                "Could not find a free name for the transfer target.",
            ))
        }
    }
}

async fn resolve_upload_target(
    handle: &SftpHandle,
    target_dir: &str,
    source: &str,
    base_name: &str,
    expected: EntryKind,
    policy: ConflictPolicy,
) -> ServerResult<(String, bool)> {
    if !paths::is_segment(base_name) {
        return Err(ServerError::path_invalid(base_name));
    }
    let target = paths::join(target_dir, base_name)?;

    let existing = remote_entry_kind(handle, &target).await?;
    match decide_conflict(policy, source, &target, existing, expected)? {
        Decision::Proceed => Ok((target, false)),
        Decision::Skip => Ok((target, true)),
        Decision::Rename => {
            for index in 1..=MAX_COLLISION_PROBES {
                let name = paths::collision_name(base_name, index)?;
                let candidate = paths::join(target_dir, &name)?;
                if remote_entry_kind(handle, &candidate).await?.is_none() {
                    return Ok((candidate, false));
                }
            }
            Err(ServerError::internal(
                "Could not find a free name for the transfer target.",
            ))
        }
    }
}

fn local_join(directory: &str, name: &str) -> String {
    PathBuf::from(directory)
        .join(name)
        .to_string_lossy()
        .into_owned()
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// Walk a remote directory tree and mirror it into the local destination.
async fn scan_remote(
    handle: &SftpHandle,
    remote_root: &str,
    local_root: &str,
    profile_id: &str,
) -> ServerResult<Plan> {
    let mut plan = Plan {
        directories: vec![local_root.to_string()],
        ..Plan::default()
    };
    let mut pending: std::collections::VecDeque<(String, String, usize)> =
        std::collections::VecDeque::new();
    pending.push_back((remote_root.to_string(), local_root.to_string(), 0));

    while let Some((remote_directory, local_directory, depth)) = pending.pop_front() {
        if depth > MAX_SCAN_DEPTH {
            return Err(ServerError::internal(
                "The directory is nested too deeply to transfer.",
            ));
        }

        for entry in handle.list(&remote_directory).await? {
            let name = paths::sanitize_local_name(&entry.name);
            let local_path = local_join(&local_directory, &name);

            if entry.kind == EntryKind::Dir && !entry.is_symlink {
                plan.directories.push(local_path.clone());
                pending.push_back((entry.path, local_path, depth + 1));
                continue;
            }

            if entry.is_symlink {
                log::warn!(
                    "server_transfer_symlink_copy profile={profile_id} source={}",
                    entry.path
                );
            }
            plan.total_bytes = plan.total_bytes.saturating_add(entry.size);
            plan.files.push(PlannedFile {
                source: entry.path,
                target: local_path,
                size: entry.size,
                skip: false,
            });
        }
    }

    plan.files.sort_by(|left, right| left.target.cmp(&right.target));
    Ok(plan)
}

/// Walk a local directory tree and mirror it into the remote destination.
///
/// Runs on the blocking pool: every call is synchronous file IO.
fn scan_local(source: &Path, remote_root: &str) -> ServerResult<Plan> {
    let mut plan = Plan {
        directories: vec![remote_root.to_string()],
        ..Plan::default()
    };
    let mut pending: Vec<(PathBuf, String, usize)> =
        vec![(source.to_path_buf(), remote_root.to_string(), 0)];

    while let Some((local_directory, remote_directory, depth)) = pending.pop() {
        if depth > MAX_SCAN_DEPTH {
            return Err(ServerError::internal(
                "The directory is nested too deeply to transfer.",
            ));
        }

        let directory = local_directory.to_string_lossy().into_owned();
        for entry in local_fs::list(&directory, true)? {
            let name = entry.name;
            if !paths::is_segment(&name) {
                continue;
            }
            let remote_path = paths::join(&remote_directory, &name)?;

            if entry.kind == EntryKind::Dir && !entry.is_symlink {
                plan.directories.push(remote_path.clone());
                pending.push((PathBuf::from(&entry.path), remote_path, depth + 1));
                continue;
            }

            if entry.is_symlink {
                // A link is never walked. One that points at a directory is
                // dropped; one that points at a file is copied as a plain file,
                // with the size of its target so the total stays honest.
                match std::fs::metadata(&entry.path) {
                    Ok(metadata) if metadata.is_dir() => {
                        log::warn!("server_transfer_symlink_dir_skipped source={}", entry.path);
                        continue;
                    }
                    Ok(metadata) => {
                        log::warn!("server_transfer_symlink_copy source={}", entry.path);
                        plan.total_bytes = plan.total_bytes.saturating_add(metadata.len());
                        plan.files.push(PlannedFile {
                            source: entry.path,
                            target: remote_path,
                            size: metadata.len(),
                            skip: false,
                        });
                        continue;
                    }
                    Err(_) => {
                        log::warn!("server_transfer_symlink_copy source={}", entry.path);
                    }
                }
            }

            plan.total_bytes = plan.total_bytes.saturating_add(entry.size);
            plan.files.push(PlannedFile {
                source: entry.path,
                target: remote_path,
                size: entry.size,
                skip: false,
            });
        }
    }

    plan.files.sort_by(|left, right| left.target.cmp(&right.target));
    Ok(plan)
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async fn run_task(control: Arc<TransferControl>, app: tauri::AppHandle) {
    let _guard = LiveGuard(control.clone());
    let record = control.record();

    let outcome = run_record(&control, &app, &record).await;

    match outcome {
        Ok(()) => {
            let total = control.record().total;
            control.update(|record| {
                record.transferred = total;
                record.bytes_per_sec = 0;
                record.state = TransferState::Done;
                record.error = None;
                // The file list is only needed to resume; a finished row keeps
                // its counters and drops the plan.
                record.plan = Plan::default();
            });
            emit_progress(&control, &app);
            emit_done(&control, &app, TransferState::Done, None);
        }
        Err(TaskFailure::Stop(Stop::Pause)) => {
            control.update(|record| {
                record.bytes_per_sec = 0;
                record.state = TransferState::Paused;
                record.error = None;
            });
            emit_progress(&control, &app);
            emit_done(&control, &app, TransferState::Paused, None);
        }
        Err(TaskFailure::Stop(Stop::Cancel)) => {
            cleanup_parts(&app, &control.record()).await;
            control.update(|record| {
                record.bytes_per_sec = 0;
                record.state = TransferState::Cancelled;
                record.error = Some("The transfer was cancelled.".to_string());
                record.plan = Plan::default();
            });
            emit_progress(&control, &app);
            emit_done(
                &control,
                &app,
                TransferState::Cancelled,
                Some("The transfer was cancelled.".to_string()),
            );
        }
        Err(TaskFailure::Error(error)) => {
            log::warn!(
                "server_transfer_failed id={} error={}",
                control.id,
                error.message
            );
            let message = error.message.clone();
            control.update(|record| {
                record.bytes_per_sec = 0;
                record.state = TransferState::Failed;
                record.error = Some(message.clone());
                // Restarting the same source resumes from the `.part` file, so
                // the in-memory file list is not needed any more.
                record.plan = Plan::default();
            });
            emit_progress(&control, &app);
            emit_done(&control, &app, TransferState::Failed, Some(message));
        }
    }
}

async fn run_record(
    control: &Arc<TransferControl>,
    app: &tauri::AppHandle,
    record: &TransferRecord,
) -> Result<(), TaskFailure> {
    // Queued work waits here; a pause or cancel requested while waiting is
    // honoured before the first byte moves.
    let _permit = slots()
        .acquire_owned()
        .await
        .map_err(|_| ServerError::internal("The transfer queue is shutting down."))?;
    control.checkpoint()?;

    let handle = app
        .state::<ServerState>()
        .connections
        .sftp(&record.profile_id)
        .await?;

    control.update(|record| {
        record.state = TransferState::Running;
        record.error = None;
    });
    let started_at = unix_now();
    control.update(|record| record.started_at = started_at);

    let mut progress = Reporter::new(app.clone(), control.clone(), record);
    let resumed_bytes: u64 = record
        .plan
        .files
        .iter()
        .take(record.completed_files)
        .map(|file| file.size)
        .sum();
    progress.set_file_done(resumed_bytes, record.completed_files);
    progress.force_emit();

    create_directories(control, &handle, record).await?;
    copy_files(control, &handle, record, &mut progress).await?;
    Ok(())
}

async fn create_directories(
    control: &TransferControl,
    handle: &SftpHandle,
    record: &TransferRecord,
) -> Result<(), TaskFailure> {
    for directory in &record.plan.directories {
        control.checkpoint()?;
        match record.direction {
            TransferDirection::Download => {
                tokio::fs::create_dir_all(directory).await.map_err(|error| {
                    ServerError::internal(format!(
                        "Failed to create the local directory '{}': {error}",
                        directory
                    ))
                })?;
            }
            TransferDirection::Upload => {
                ensure_remote_directory(handle, directory).await?;
            }
        }
    }
    Ok(())
}

async fn ensure_remote_directory(handle: &SftpHandle, path: &str) -> ServerResult<()> {
    match remote_entry(handle, path).await? {
        Some(entry) if entry.kind == EntryKind::Dir && !entry.is_symlink => Ok(()),
        Some(_) => Err(ServerError::internal(format!(
            "The remote path '{}' is not a directory.",
            path
        ))),
        None => handle.mkdir(path).await,
    }
}

async fn copy_files(
    control: &TransferControl,
    handle: &SftpHandle,
    record: &TransferRecord,
    progress: &mut Reporter,
) -> Result<(), TaskFailure> {
    let mut completed = record.completed_files;
    let mut finished_bytes: u64 = record
        .plan
        .files
        .iter()
        .take(completed)
        .map(|file| file.size)
        .sum();

    while completed < record.plan.files.len() {
        control.checkpoint()?;
        let file = record.plan.files[completed].clone();

        if file.skip {
            completed += 1;
            control.update(|record| record.completed_files = completed);
            finished_bytes = finished_bytes.saturating_add(file.size);
            progress.set_file_done(finished_bytes, completed);
            progress.tick();
            continue;
        }

        let offset = resume_offset_for(&record.direction, handle, &file).await?;
        if file.size == 0 || offset < file.size {
            copy_one(control, handle, record, &file, offset, progress, finished_bytes).await?;
        }
        finalize(control, handle, record, &file).await?;

        completed += 1;
        finished_bytes = finished_bytes.saturating_add(file.size);
        control.update(|record| record.completed_files = completed);
        progress.set_file_done(finished_bytes, completed);
        progress.tick();
    }
    Ok(())
}

/// Restart position of one file: the size of its `.part`, or zero.
async fn resume_offset_for(
    direction: &TransferDirection,
    handle: &SftpHandle,
    file: &PlannedFile,
) -> ServerResult<u64> {
    let part_size = match direction {
        TransferDirection::Download => match tokio::fs::metadata(part_path(&file.target)).await {
            Ok(metadata) => metadata.len(),
            Err(_) => 0,
        },
        TransferDirection::Upload => {
            let part = remote_part_path(&file.target);
            match remote_entry(handle, &part).await? {
                Some(entry) if entry.kind == EntryKind::File => entry.size,
                _ => 0,
            }
        }
    };
    Ok(resume_offset(part_size, file.size))
}

fn resume_offset(part_size: u64, expected: u64) -> u64 {
    if expected > 0 && part_size > expected {
        0
    } else {
        part_size
    }
}

fn part_path(target: &str) -> PathBuf {
    let mut name = PathBuf::from(target).into_os_string();
    name.push(".part");
    PathBuf::from(name)
}

fn remote_part_path(target: &str) -> String {
    format!("{target}.part")
}

async fn copy_one(
    control: &TransferControl,
    handle: &SftpHandle,
    record: &TransferRecord,
    file: &PlannedFile,
    offset: u64,
    progress: &mut Reporter,
    finished_bytes: u64,
) -> Result<(), TaskFailure> {
    match record.direction {
        TransferDirection::Download => {
            copy_remote_to_local(control, handle, file, offset, progress, finished_bytes).await
        }
        TransferDirection::Upload => {
            copy_local_to_remote(control, handle, file, offset, progress, finished_bytes).await
        }
    }
}

async fn copy_remote_to_local(
    control: &TransferControl,
    handle: &SftpHandle,
    file: &PlannedFile,
    offset: u64,
    progress: &mut Reporter,
    finished_bytes: u64,
) -> Result<(), TaskFailure> {
    let part = part_path(&file.target);
    if let Some(parent) = part.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            ServerError::internal(format!(
                "Failed to create the local directory '{}': {error}",
                parent.display()
            ))
        })?;
    }

    let mut reader = handle.open_read(&file.source, offset).await?;
    let mut writer = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(&part)
        .await
        .map_err(|error| {
            ServerError::internal(format!(
                "Failed to open the local file '{}': {error}",
                part.display()
            ))
        })?;
    if offset > 0 {
        writer.set_len(offset).await.map_err(|error| {
            ServerError::internal(format!(
                "Failed to resize the local file '{}': {error}",
                part.display()
            ))
        })?;
    }
    writer.seek(SeekFrom::Start(offset)).await.map_err(|error| {
        ServerError::internal(format!(
            "Failed to seek the local file '{}': {error}",
            part.display()
        ))
    })?;

    let mut buffer = vec![0_u8; CHUNK_SIZE];
    let mut copied = offset;
    loop {
        if let Err(stop) = control.checkpoint() {
            // Best effort: russh-sftp only sends CLOSE from `close()`.
            let _ = tokio::time::timeout(IO_TIMEOUT, reader.close()).await;
            return Err(stop);
        }
        let size = tokio::time::timeout(IO_TIMEOUT, reader.read(&mut buffer))
            .await
            .map_err(|_| ServerError::internal("The transfer read timed out."))?
            .map_err(|error| {
                ServerError::internal(format!("Failed to read the remote file: {error}"))
            })?;
        if size == 0 {
            break;
        }
        tokio::time::timeout(IO_TIMEOUT, writer.write_all(&buffer[..size]))
            .await
            .map_err(|_| ServerError::internal("The transfer write timed out."))?
            .map_err(|error| {
                ServerError::internal(format!("Failed to write the local file: {error}"))
            })?;
        copied = copied.saturating_add(size as u64);
        progress.set_progress(finished_bytes, copied);
        progress.tick();
    }

    writer.flush().await.map_err(|error| {
        ServerError::internal(format!("Failed to flush the local file: {error}"))
    })?;
    drop(writer);
    reader
        .close()
        .await
        .map_err(|error| ServerError::internal(format!("Failed to close the remote file: {error}")))?;
    Ok(())
}

async fn copy_local_to_remote(
    control: &TransferControl,
    handle: &SftpHandle,
    file: &PlannedFile,
    offset: u64,
    progress: &mut Reporter,
    finished_bytes: u64,
) -> Result<(), TaskFailure> {
    let part = remote_part_path(&file.target);
    let mut reader = tokio::fs::File::open(&file.source).await.map_err(|error| {
        ServerError::internal(format!(
            "Failed to open the local file '{}': {error}",
            file.source
        ))
    })?;
    reader.seek(SeekFrom::Start(offset)).await.map_err(|error| {
        ServerError::internal(format!(
            "Failed to seek the local file '{}': {error}",
            file.source
        ))
    })?;

    let mut writer = handle.open_write(&part, offset).await?;
    let mut buffer = vec![0_u8; CHUNK_SIZE];
    let mut copied = offset;
    loop {
        if let Err(stop) = control.checkpoint() {
            // Best effort: flush what the server already has so the paused
            // `.part` matches its size when the task resumes.
            let _ = tokio::time::timeout(IO_TIMEOUT, writer.close()).await;
            return Err(stop);
        }
        let size = tokio::time::timeout(IO_TIMEOUT, reader.read(&mut buffer))
            .await
            .map_err(|_| ServerError::internal("The transfer read timed out."))?
            .map_err(|error| {
                ServerError::internal(format!("Failed to read the local file: {error}"))
            })?;
        if size == 0 {
            break;
        }
        tokio::time::timeout(IO_TIMEOUT, writer.write_all(&buffer[..size]))
            .await
            .map_err(|_| ServerError::internal("The transfer write timed out."))?
            .map_err(|error| {
                ServerError::internal(format!("Failed to write the remote file: {error}"))
            })?;
        copied = copied.saturating_add(size as u64);
        progress.set_progress(finished_bytes, copied);
        progress.tick();
    }

    writer
        .close()
        .await
        .map_err(|error| ServerError::internal(format!("Failed to close the remote file: {error}")))?;
    Ok(())
}

/// Rename the `.part` over the destination once every chunk is on disk.
async fn finalize(
    _control: &TransferControl,
    handle: &SftpHandle,
    record: &TransferRecord,
    file: &PlannedFile,
) -> Result<(), TaskFailure> {
    let overwrite = record.policy == ConflictPolicy::Overwrite;
    match record.direction {
        TransferDirection::Download => {
            let part = part_path(&file.target);
            if tokio::fs::metadata(&part).await.is_err() {
                // Nothing was written (zero-byte file copied straight through
                // is the one case; it still has a part file, so this guards a
                // vanished part rather than the normal path).
                return Ok(());
            }
            let target = PathBuf::from(&file.target);
            if overwrite && local_entry(&file.target).is_some() {
                let _ = tokio::fs::remove_file(&target).await;
            }
            tokio::fs::rename(&part, &target).await.map_err(|error| {
                ServerError::internal(format!(
                    "Failed to finalize the local file '{}': {error}",
                    file.target
                ))
            })?;
        }
        TransferDirection::Upload => {
            let part = remote_part_path(&file.target);
            if remote_entry(handle, &part).await?.is_none() {
                return Ok(());
            }
            if overwrite && remote_entry(handle, &file.target).await?.is_some() {
                let _ = handle.remove(&file.target, false).await;
            }
            handle.rename(&part, &file.target).await?;
        }
    }
    Ok(())
}

/// Remove the `.part` of the file that was in flight when a task was cancelled.
async fn cleanup_parts(app: &tauri::AppHandle, record: &TransferRecord) {
    let index = record.completed_files.min(record.plan.files.len());
    let Some(file) = record.plan.files.get(index) else {
        return;
    };

    match record.direction {
        TransferDirection::Download => {
            let part = part_path(&file.target);
            let _ = tokio::fs::remove_file(part).await;
        }
        TransferDirection::Upload => {
            let Some(state) = app.try_state::<ServerState>() else {
                return;
            };
            let Ok(handle) = state.connections.sftp(&record.profile_id).await else {
                return;
            };
            let part = remote_part_path(&file.target);
            let _ = handle.remove(&part, false).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

/// Throttled progress writer for one running task.
///
/// It mirrors the counters it owns so a 32 KB chunk never clones the record
/// (which carries the whole file plan).
struct Reporter {
    app: tauri::AppHandle,
    control: Arc<TransferControl>,
    id: String,
    profile_id: String,
    total: u64,
    by_count: bool,
    files_done: usize,
    transferred: u64,
    last_emit: Instant,
    rate_at: Instant,
    rate_bytes: u64,
    bytes_per_sec: u64,
}

impl Reporter {
    fn new(app: tauri::AppHandle, control: Arc<TransferControl>, record: &TransferRecord) -> Self {
        control.update(|shared| shared.total = record.total);
        Self {
            app,
            control,
            id: record.id.clone(),
            profile_id: record.profile_id.clone(),
            total: record.total,
            by_count: record.plan.by_count,
            files_done: record.completed_files,
            transferred: 0,
            last_emit: Instant::now() - PROGRESS_THROTTLE,
            rate_at: Instant::now(),
            rate_bytes: 0,
            bytes_per_sec: 0,
        }
    }

    /// Bytes already moved plus the bytes of the file in flight.
    fn set_progress(&mut self, finished_bytes: u64, copied: u64) {
        let value = if self.by_count {
            self.files_done as u64
        } else {
            finished_bytes.saturating_add(copied)
        };
        self.store(value);
    }

    /// One more file finished; `files_done` counts from the task start.
    fn set_file_done(&mut self, finished_bytes: u64, files_done: usize) {
        self.files_done = files_done;
        let value = if self.by_count {
            files_done as u64
        } else {
            finished_bytes
        };
        self.store(value);
    }

    fn store(&mut self, transferred: u64) {
        self.transferred = transferred;
        let transferred = transferred;
        self.control
            .update(|record| record.transferred = transferred);
    }

    /// Emit at most once per `PROGRESS_THROTTLE`.
    fn tick(&mut self) {
        if self.last_emit.elapsed() < PROGRESS_THROTTLE {
            return;
        }
        self.emit();
    }

    fn force_emit(&mut self) {
        self.emit();
    }

    fn emit(&mut self) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.rate_at);
        if elapsed >= Duration::from_millis(200) {
            let delta = self.transferred.saturating_sub(self.rate_bytes);
            self.bytes_per_sec =
                (delta as f64 * 1000.0 / elapsed.as_millis().max(1) as f64) as u64;
            self.rate_at = now;
            self.rate_bytes = self.transferred;
        }

        events::emit(
            &self.app,
            events::SERVER_TRANSFER_PROGRESS,
            TransferProgressEvent {
                transfer_id: self.id.clone(),
                profile_id: self.profile_id.clone(),
                transferred: self.transferred,
                total: self.total,
                bytes_per_sec: self.bytes_per_sec,
                state: TransferState::Running,
            },
        );
        self.control
            .update(|record| record.bytes_per_sec = self.bytes_per_sec);
        self.last_emit = now;
    }
}

fn emit_progress(control: &TransferControl, app: &tauri::AppHandle) {
    let record = control.record();
    events::emit(
        app,
        events::SERVER_TRANSFER_PROGRESS,
        TransferProgressEvent {
            transfer_id: record.id,
            profile_id: record.profile_id,
            transferred: record.transferred,
            total: record.total,
            bytes_per_sec: record.bytes_per_sec,
            state: record.state,
        },
    );
}

fn emit_done(
    control: &TransferControl,
    app: &tauri::AppHandle,
    state: TransferState,
    error: Option<String>,
) {
    let id = control.id.clone();
    events::emit(
        app,
        events::SERVER_TRANSFER_DONE,
        TransferDoneEvent {
            transfer_id: id,
            state,
            error,
        },
    );
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn scratch(tag: &str) -> PathBuf {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "server-core-transfer-{tag}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn conflict_policy_matrix() {
        // No target: every policy proceeds.
        for policy in [
            ConflictPolicy::Ask,
            ConflictPolicy::Overwrite,
            ConflictPolicy::Skip,
            ConflictPolicy::Rename,
        ] {
            assert_eq!(
                decide_conflict(policy, "/a", "/b", None, EntryKind::File).unwrap(),
                Decision::Proceed
            );
        }

        let existing = Some(EntryKind::File);
        assert_eq!(
            decide_conflict(ConflictPolicy::Overwrite, "/a", "/b", existing, EntryKind::File)
                .unwrap(),
            Decision::Proceed
        );
        assert_eq!(
            decide_conflict(ConflictPolicy::Skip, "/a", "/b", existing, EntryKind::File).unwrap(),
            Decision::Skip
        );
        assert_eq!(
            decide_conflict(ConflictPolicy::Rename, "/a", "/b", existing, EntryKind::File).unwrap(),
            Decision::Rename
        );

        let ask =
            decide_conflict(ConflictPolicy::Ask, "/a", "/b", existing, EntryKind::File).unwrap_err();
        assert_eq!(ask.code, ServerErrorCode::ConflictRequiresChoice);
        let detail = ask.detail.unwrap();
        assert_eq!(detail["source"], "/a");
        assert_eq!(detail["target"], "/b");

        // A file cannot overwrite a directory.
        let mismatch = decide_conflict(
            ConflictPolicy::Overwrite,
            "/a",
            "/b",
            Some(EntryKind::Dir),
            EntryKind::File,
        )
        .unwrap_err();
        assert_eq!(mismatch.code, ServerErrorCode::Internal);
    }

    #[test]
    fn resume_offsets_follow_the_part_size() {
        assert_eq!(resume_offset(0, 100), 0);
        assert_eq!(resume_offset(40, 100), 40);
        assert_eq!(resume_offset(100, 100), 100);
        // A part larger than the source restarts instead of appending junk.
        assert_eq!(resume_offset(120, 100), 0);
        // Unknown size: keep whatever the part already holds.
        assert_eq!(resume_offset(120, 0), 120);
    }

    #[test]
    fn part_paths_append_the_suffix() {
        assert_eq!(part_path("C:\\tmp\\a.txt"), PathBuf::from("C:\\tmp\\a.txt.part"));
        assert_eq!(remote_part_path("/srv/a.txt"), "/srv/a.txt.part");
    }

    #[test]
    fn progress_falls_back_to_file_counts() {
        let empty_file = |source: &str, target: &str| PlannedFile {
            source: source.into(),
            target: target.into(),
            size: 0,
            skip: false,
        };

        let mut unknown = Plan {
            total_bytes: 0,
            files: vec![empty_file("/a", "/b"), empty_file("/c", "/d")],
            ..Plan::default()
        };
        assert_eq!(plan_progress(&mut unknown), 2);
        assert!(unknown.by_count);

        let mut sized = Plan {
            total_bytes: 10,
            files: vec![empty_file("/a", "/b")],
            ..Plan::default()
        };
        assert_eq!(plan_progress(&mut sized), 10);
        assert!(!sized.by_count);

        // An empty directory has nothing to count either way.
        let mut empty = Plan::default();
        assert_eq!(plan_progress(&mut empty), 0);
        assert!(!empty.by_count);
    }

    #[test]
    fn control_flags_follow_the_state_machine() {
        // The control block is pure logic; only the app handle is threaded in.
        let control = std::sync::atomic::AtomicU8::new(FLAG_RUNNING);
        assert_eq!(control.load(Ordering::SeqCst), FLAG_RUNNING);

        let _ = control.compare_exchange(FLAG_RUNNING, FLAG_PAUSE, Ordering::SeqCst, Ordering::SeqCst);
        assert_eq!(control.load(Ordering::SeqCst), FLAG_PAUSE);
        let _ = control.compare_exchange(FLAG_PAUSE, FLAG_RUNNING, Ordering::SeqCst, Ordering::SeqCst);
        assert_eq!(control.load(Ordering::SeqCst), FLAG_RUNNING);

        // Cancel always wins and cannot be undone by a resume.
        control.store(FLAG_CANCEL, Ordering::SeqCst);
        let _ = control.compare_exchange(FLAG_PAUSE, FLAG_RUNNING, Ordering::SeqCst, Ordering::SeqCst);
        assert_eq!(control.load(Ordering::SeqCst), FLAG_CANCEL);
    }

    #[test]
    fn local_scan_mirrors_the_tree() {
        let root = scratch("scan");
        let nested = root.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("a.txt"), b"abc").unwrap();
        std::fs::write(nested.join("b.txt"), b"de").unwrap();

        let plan = scan_local(&root, "/dest").unwrap();
        assert_eq!(plan.total_bytes, 5);
        assert_eq!(plan.files.len(), 2);
        let targets: Vec<&str> = plan.files.iter().map(|file| file.target.as_str()).collect();
        assert_eq!(targets, vec!["/dest/a.txt", "/dest/sub/b.txt"]);
        assert!(plan.directories.iter().any(|entry| entry == "/dest/sub"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn local_scan_refuses_deep_trees() {
        let root = scratch("depth");
        let mut current = root.clone();
        // `MAX_SCAN_DEPTH` extra levels put the deepest directory past the cap.
        for _ in 0..(MAX_SCAN_DEPTH + 2) {
            current = current.join("d");
            std::fs::create_dir(&current).unwrap();
        }
        std::fs::write(current.join("deep.txt"), b"x").unwrap();

        let error = scan_local(&root, "/dest").unwrap_err();
        assert_eq!(error.code, ServerErrorCode::Internal);
        assert!(error.message.contains("nested too deeply"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn transfer_ids_carry_every_part() {
        let id = build_transfer_id("p1", TransferDirection::Download, "/srv/a", "C:\\t\\a", 9);
        assert_eq!(id, "p1:download:/srv/a:C:\\t\\a:9");
    }
}
