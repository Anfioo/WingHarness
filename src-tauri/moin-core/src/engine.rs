// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Queue, state machine and persistence orchestration.
//!
//! The engine never depends on Tauri: everything it reports goes out through
//! [`Emitter`], and the host (`state.rs`) turns those calls into `app.emit`.
//!
//! Bytes are moved by a [`DownloadBackend`]; the queue only decides which one
//! runs a task, watches the [`Control`] handle and turns the resulting
//! [`Outcome`] into a task status.
//!
//! Lock discipline: `Inner` guards every in-memory map with a
//! `std::sync::Mutex`, and no guard is ever held across an `.await`. Anything
//! needed after an await is cloned out of the guard first. SQLite writes are
//! serialised by the pool (`max_connections = 1`) and always happen outside the
//! locks.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderName, HeaderValue};
use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::aria2::Aria2Backend;
use crate::aria2_tool::Aria2Tool;
use crate::backend::{
    Control, DownloadBackend, NetConfig, Outcome, ProgressFn, Signal, TransferOpts,
};
use crate::category::CategoryStore;
use crate::embedded::EmbeddedBackend;
use crate::error::{MoinError, MoinResult};
use crate::models::{
    filename_from_url, now_ms, sanitize_filename, AddMethodKind, BackendInfo, Category, Settings,
    Task, TaskKind, TaskProgress, TaskStatus, ToolStatus,
};
use crate::{settings, store::Store};

/// Host callback surface. The engine reports; the host decides what to do.
pub trait Emitter: Send + Sync + 'static {
    fn added(&self, task: &Task);
    fn progress(&self, progress: TaskProgress);
    fn updated(&self, task: &Task);
    fn removed(&self, id: &str);
    fn completed(&self, _task: &Task) {}
}

#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

struct Inner {
    data_dir: PathBuf,
    downloads_dir: PathBuf,
    category_path: PathBuf,
    store: Store,
    categories: Mutex<CategoryStore>,
    settings: Mutex<Settings>,
    tasks: Mutex<HashMap<String, Task>>,
    active: Mutex<HashSet<String>>,
    controls: Mutex<HashMap<String, Control>>,
    stopping: AtomicBool,
    queue_notify: Notify,
    emitter: Arc<dyn Emitter>,
    embedded: Arc<EmbeddedBackend>,
    aria2: Arc<Aria2Backend>,
    tool: Arc<Aria2Tool>,
}

/// How often a byte rate is recomputed from the running total.
const SPEED_WINDOW: Duration = Duration::from_millis(500);

/// How often a running transfer writes its byte count to `downloads.db`.
/// Progress events are cheap; a database round trip per chunk is not.
const PERSIST_INTERVAL: Duration = Duration::from_secs(1);

/// How long `shutdown` waits for the workers to notice `Cancel`.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// How long a state-changing command waits for a worker to release its files.
const STOP_WAIT: Duration = Duration::from_secs(10);

/// Buffer size for the cross-volume copy path.
const COPY_CHUNK: usize = 256 * 1024;

/// Upper bound on the "this partial belongs to nobody" warnings a start-up
/// scan may print, so a download folder full of leftovers cannot flood the log.
const ORPHAN_WARN_LIMIT: usize = 20;

fn guard<T>(mutex: &Mutex<T>) -> MoinResult<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| MoinError::internal("A download state lock is poisoned."))
}

/// The connect timeout a backend should use for `settings`.
fn net_config(settings: &Settings) -> NetConfig {
    NetConfig {
        connect_timeout: (settings.connect_timeout_secs > 0)
            .then(|| Duration::from_secs(settings.connect_timeout_secs)),
    }
}

/// Byte-rate estimator shared by both transfer paths.
///
/// The first sample only records a baseline: a resumed download must not report
/// the bytes it already had on disk as one huge burst. Between samples the last
/// figure is reused, so a fast connection does not turn into a per-chunk
/// division and the UI still gets a value on every progress tick.
struct SpeedSampler {
    last_at: Instant,
    last_bytes: u64,
    speed: u64,
    primed: bool,
}

impl SpeedSampler {
    fn new() -> Self {
        Self {
            last_at: Instant::now(),
            last_bytes: 0,
            speed: 0,
            primed: false,
        }
    }

    /// Bytes per second at `bytes` transferred, recomputed at most every
    /// `SPEED_WINDOW`. A window with no new bytes reports `0`, which is what a
    /// stalled transfer should show.
    fn sample(&mut self, bytes: u64) -> u64 {
        if !self.primed {
            self.primed = true;
            self.last_bytes = bytes;
            self.last_at = Instant::now();
            return 0;
        }
        let elapsed = self.last_at.elapsed();
        if elapsed < SPEED_WINDOW {
            return self.speed;
        }
        let delta = bytes.saturating_sub(self.last_bytes);
        self.speed = (delta as f64 / elapsed.as_secs_f64()) as u64;
        self.last_bytes = bytes;
        self.last_at = Instant::now();
        self.speed
    }
}

impl Engine {
    pub async fn new(
        data_dir: PathBuf,
        emitter: Arc<dyn Emitter>,
        downloads_dir: PathBuf,
    ) -> MoinResult<Self> {
        tokio::fs::create_dir_all(&data_dir).await.map_err(|error| {
            MoinError::io(format!("Could not create the moin data directory: {error}"))
        })?;
        let store = Store::open(&data_dir).await.map_err(|error| {
            MoinError::io(format!("Could not open the downloads database: {}", error.message))
        })?;
        let category_path = data_dir.join("categories.json");
        let categories = CategoryStore::load(&category_path);
        let mut loaded_settings = settings::load(&data_dir);
        if loaded_settings.validate().is_err() {
            log::warn!("Invalid moin settings were replaced with defaults.");
            loaded_settings = Settings::default();
        }
        if loaded_settings.rpc_token.is_empty() {
            loaded_settings.rpc_token = Uuid::new_v4().to_string();
            settings::save(&data_dir, &loaded_settings)?;
        }
        let mut tasks = HashMap::new();
        for mut task in store.all().await.map_err(|error| {
            MoinError::io(format!("Could not load downloads: {}", error.message))
        })? {
            // A previous run died mid-transfer: fall back to paused instead of
            // silently resuming, so the user stays in control.
            if matches!(
                task.status,
                TaskStatus::Connecting | TaskStatus::Downloading | TaskStatus::Moving
            ) {
                task.status = TaskStatus::Paused;
                task.updated_at = now_ms();
                store.upsert(&task).await?;
            }
            tasks.insert(task.id.clone(), task);
        }
        warn_unowned_partials(&tasks, &downloads_dir).await;

        let embedded = Arc::new(EmbeddedBackend::new());
        embedded.reconfigure(net_config(&loaded_settings));
        let tool = Arc::new(Aria2Tool::new(loaded_settings.aria2_path.clone()));
        let aria2 = Arc::new(Aria2Backend::new(tool.clone(), data_dir.clone()));

        let engine = Self {
            inner: Arc::new(Inner {
                data_dir,
                downloads_dir,
                category_path,
                store,
                categories: Mutex::new(categories),
                settings: Mutex::new(loaded_settings),
                tasks: Mutex::new(tasks),
                active: Mutex::new(HashSet::new()),
                controls: Mutex::new(HashMap::new()),
                stopping: AtomicBool::new(false),
                queue_notify: Notify::new(),
                emitter,
                embedded,
                aria2,
                tool,
            }),
        };
        let scheduler = engine.clone();
        tokio::spawn(async move {
            scheduler.run_scheduler().await;
        });
        Ok(engine)
    }

    pub fn list(&self) -> Vec<Task> {
        let Ok(tasks) = guard(&self.inner.tasks) else {
            return Vec::new();
        };
        let mut tasks: Vec<_> = tasks.values().cloned().collect();
        tasks.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        tasks
    }

    pub fn has_active_transfers(&self) -> bool {
        guard(&self.inner.active)
            .map(|active| !active.is_empty())
            .unwrap_or(false)
    }

    pub async fn add_http(
        &self,
        url: String,
        dir: PathBuf,
        category: Option<String>,
        headers: BTreeMap<String, String>,
        filename: Option<String>,
    ) -> MoinResult<Task> {
        let parsed = Url::parse(url.trim())
            .map_err(|error| MoinError::invalid_input("url", error.to_string()))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(MoinError::invalid_input(
                "url",
                "Only absolute HTTP and HTTPS URLs are supported.",
            ));
        }
        if url.len() > 16_384 {
            return Err(MoinError::invalid_input("url", "The URL is too long."));
        }
        if headers.len() > 64 {
            return Err(MoinError::invalid_input(
                "headers",
                "At most 64 request headers are allowed.",
            ));
        }
        let mut header_bytes = 0usize;
        for (name, value) in &headers {
            header_bytes = header_bytes
                .saturating_add(name.len())
                .saturating_add(value.len());
            if HeaderName::from_bytes(name.as_bytes()).is_err()
                || HeaderValue::from_str(value).is_err()
            {
                return Err(MoinError::invalid_input(
                    "headers",
                    "A header name or value is invalid.",
                ));
            }
        }
        if header_bytes > 64 * 1024 {
            return Err(MoinError::invalid_input("headers", "Request headers exceed 64 KiB."));
        }
        let settings = self.settings();
        let (suggested_category, available_categories) = {
            let categories = guard(&self.inner.categories)?;
            (
                categories.suggest(
                    parsed.as_str(),
                    filename.as_deref(),
                    AddMethodKind::ManualLink,
                    None,
                ),
                categories.list(),
            )
        };
        let category_id = category.or(suggested_category);
        if category_id
            .as_ref()
            .is_some_and(|id| !available_categories.iter().any(|item| &item.id == id))
        {
            return Err(MoinError::not_found(
                "category",
                category_id.as_deref().unwrap_or_default(),
            ));
        }
        let default_folder = if dir.as_os_str().is_empty() {
            self.inner.downloads_dir.clone()
        } else {
            dir
        };
        let category = category_id
            .as_ref()
            .and_then(|id| available_categories.iter().find(|item| &item.id == id));
        let final_folder = category
            .and_then(|item| item.save_dir.as_deref())
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| default_folder.clone());
        let staging_folder = category
            .and_then(|item| item.incomplete_dir.as_deref())
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let folder = staging_folder.clone().unwrap_or_else(|| final_folder.clone());
        let final_dir = staging_folder
            .filter(|staging| staging != &final_folder)
            .map(|_| final_folder.to_string_lossy().into_owned());
        tokio::fs::create_dir_all(&folder).await.map_err(|error| {
            MoinError::io(format!("Could not create the download directory: {error}"))
        })?;
        let requested = filename
            .as_deref()
            .and_then(sanitize_filename)
            .unwrap_or_else(|| {
                sanitize_filename(&filename_from_url(parsed.as_str()))
                    .unwrap_or_else(|| "download".to_string())
            });
        let backend = self.pick_backend(TaskKind::Http).id().to_string();
        let timestamp = now_ms();
        // One critical section covers "check for a clash, pick a free name,
        // build the task, publish it": two concurrent adds of the same name
        // must never resolve to the same file. The existence probe is a plain
        // `std::fs` call so the section stays await-free.
        let task = {
            let mut tasks = guard(&self.inner.tasks)?;
            let occupied: HashSet<String> = tasks
                .values()
                .map(|task| task.dest.to_lowercase())
                .collect();
            let target = unique_destination(&folder, &requested, &occupied)?;
            let task = Task {
                id: Uuid::new_v4().to_string(),
                kind: TaskKind::Http,
                url: parsed.to_string(),
                filename: target
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("download")
                    .to_string(),
                dest: target.to_string_lossy().into_owned(),
                status: if settings.add_paused {
                    TaskStatus::Paused
                } else {
                    TaskStatus::Queued
                },
                total: None,
                received: 0,
                error: None,
                created_at: timestamp,
                updated_at: timestamp,
                completed_at: None,
                archived: false,
                active_ms: 0,
                backend: Some(backend),
                category: category_id,
                final_dir,
                headers,
            };
            tasks.insert(task.id.clone(), task.clone());
            task
        };
        self.inner.store.upsert(&task).await?;
        self.inner.emitter.added(&task);
        if task.status == TaskStatus::Queued {
            self.inner.queue_notify.notify_one();
        }
        Ok(task)
    }

    pub async fn pause(&self, id: &str) -> MoinResult<()> {
        let task = self.task(id)?;
        match task.status {
            TaskStatus::Queued => {
                self.set_status(id, TaskStatus::Paused, None).await?;
            }
            TaskStatus::Connecting | TaskStatus::Downloading => {
                self.control(id)?.set(Signal::Pause);
            }
            _ => {
                return Err(MoinError::conflict(format!(
                    "A {} download cannot be paused.",
                    task.status.as_str()
                )))
            }
        }
        Ok(())
    }

    pub async fn resume(&self, id: &str) -> MoinResult<()> {
        let task = self.task(id)?;
        if !matches!(
            task.status,
            TaskStatus::Paused | TaskStatus::Failed | TaskStatus::Stalled
        ) {
            return Err(MoinError::conflict(format!(
                "A {} download cannot be resumed.",
                task.status.as_str()
            )));
        }
        self.set_status(id, TaskStatus::Queued, None).await?;
        self.inner.queue_notify.notify_one();
        Ok(())
    }

    pub async fn cancel(&self, id: &str) -> MoinResult<()> {
        let task = self.task(id)?;
        match task.status {
            TaskStatus::Queued | TaskStatus::Paused | TaskStatus::Failed | TaskStatus::Stalled => {
                self.set_status(id, TaskStatus::Canceled, None).await?;
            }
            TaskStatus::Connecting | TaskStatus::Downloading => self.control(id)?.set(Signal::Cancel),
            _ => {
                return Err(MoinError::conflict(format!(
                    "A {} download cannot be canceled.",
                    task.status.as_str()
                )))
            }
        }
        Ok(())
    }

    pub async fn retry(&self, id: &str) -> MoinResult<()> {
        let task = self.task(id)?;
        if !matches!(
            task.status,
            TaskStatus::Failed | TaskStatus::Stalled | TaskStatus::Canceled
        ) {
            return Err(MoinError::conflict(format!(
                "A {} download cannot be retried.",
                task.status.as_str()
            )));
        }
        // The byte count is deliberately left alone: the `.part` on disk is
        // what the next attempt resumes from.
        self.set_status(id, TaskStatus::Queued, None).await?;
        self.inner.queue_notify.notify_one();
        Ok(())
    }

    /// Archive the record and keep the downloaded file.
    pub async fn remove(&self, id: &str) -> MoinResult<()> {
        let task = self.task(id)?;
        if task.archived {
            return Ok(());
        }
        self.mutate(id, |task| task.archived = true).await?;
        Ok(())
    }

    /// Archive the record and delete the downloaded file (and its partials).
    pub async fn delete(&self, id: &str) -> MoinResult<()> {
        if self.is_active(id) {
            if let Ok(control) = self.control(id) {
                control.set(Signal::Cancel);
            }
            self.wait_inactive(id).await?;
        }
        let task = self.task(id)?;
        // `.part.aria2` is the control file the external backend leaves behind;
        // a stale one would make the next attempt resume into a dead session.
        for path in [
            PathBuf::from(&task.dest),
            PathBuf::from(task.part_path()),
            PathBuf::from(task.meta_path()),
            PathBuf::from(format!("{}.aria2", task.part_path())),
        ] {
            match tokio::fs::remove_file(path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(MoinError::io(format!(
                        "Could not remove the download file: {error}"
                    )))
                }
            }
        }
        self.mutate(id, |task| task.archived = true).await?;
        Ok(())
    }

    pub async fn archive_many(&self, ids: Vec<String>, delete_file: bool) -> MoinResult<()> {
        for id in ids {
            if delete_file {
                self.delete(&id).await?;
            } else {
                self.remove(&id).await?;
            }
        }
        Ok(())
    }

    /// Drop the record and leave every file on disk alone.
    pub async fn forget(&self, id: &str) -> MoinResult<()> {
        if self.is_active(id) {
            return Err(MoinError::conflict(
                "Pause or cancel the download before removing its record.",
            ));
        }
        self.task(id)?;
        self.inner.store.delete(id).await?;
        guard(&self.inner.tasks)?.remove(id);
        self.inner.emitter.removed(id);
        Ok(())
    }

    pub fn settings(&self) -> Settings {
        guard(&self.inner.settings)
            .map(|settings| settings.clone())
            .unwrap_or_default()
    }

    pub fn set_settings(&self, mut next: Settings) -> MoinResult<()> {
        next.validate()
            .map_err(|error| MoinError::invalid_input("settings", error))?;
        settings::save(&self.inner.data_dir, &next)?;
        let concurrency_changed = {
            let mut current = guard(&self.inner.settings)?;
            let changed = current.max_concurrent != next.max_concurrent;
            *current = next.clone();
            changed
        };
        // A new connect timeout only takes effect once the client is rebuilt,
        // and a new aria2 path only after the probe cache is dropped.
        self.inner.embedded.reconfigure(net_config(&next));
        self.inner.tool.set_override(next.aria2_path.clone());
        if concurrency_changed {
            self.inner.queue_notify.notify_one();
        }
        Ok(())
    }

    /// The backend list the settings page renders. `available` is the live
    /// probe result, so the aria2 row can explain itself instead of vanishing.
    pub fn backends(&self) -> Vec<BackendInfo> {
        vec![
            BackendInfo::of(self.inner.embedded.as_ref()),
            BackendInfo::of(self.inner.aria2.as_ref()),
        ]
    }

    pub fn regenerate_rpc_token(&self) -> String {
        let mut next = self.settings();
        next.rpc_token = Uuid::new_v4().to_string();
        if let Err(error) = self.set_settings(next.clone()) {
            log::warn!("Could not persist a new moin RPC token: {}", error.message);
        }
        next.rpc_token
    }

    pub async fn tool_status(&self) -> ToolStatus {
        self.inner.tool.status().await
    }

    pub async fn set_tool_path(&self, path: Option<String>) -> ToolStatus {
        let mut next = self.settings();
        next.aria2_path = path.filter(|value| !value.trim().is_empty());
        if let Err(error) = self.set_settings(next) {
            log::warn!("Could not persist the aria2 path: {}", error.message);
        }
        self.tool_status().await
    }

    pub fn categories(&self) -> Vec<Category> {
        guard(&self.inner.categories)
            .map(|categories| categories.list())
            .unwrap_or_default()
    }

    pub fn suggest_category(&self, url: &str, filename: Option<&str>) -> Option<String> {
        guard(&self.inner.categories)
            .ok()
            .and_then(|categories| {
                categories.suggest(url, filename, AddMethodKind::ManualLink, None)
            })
    }

    pub fn categorize_capture(&self, url: &str, filename: Option<&str>) -> Option<String> {
        guard(&self.inner.categories)
            .ok()
            .and_then(|categories| {
                categories.suggest(url, filename, AddMethodKind::BrowserCapture, None)
            })
    }

    pub async fn create_category(&self, category: Category) -> MoinResult<Vec<Category>> {
        let categories = {
            let mut store = guard(&self.inner.categories)?;
            store.upsert(&self.inner.category_path, category)?
        };
        Ok(categories)
    }

    pub async fn update_category(&self, category: Category) -> MoinResult<Vec<Category>> {
        let categories = {
            let mut store = guard(&self.inner.categories)?;
            store.upsert(&self.inner.category_path, category)?
        };
        Ok(categories)
    }

    /// Remove a category and untag its downloads. Files stay where they are and
    /// `final_dir` keeps its value: dropping a label is not a reason to move
    /// somebody's data.
    pub async fn delete_category(&self, id: &str) -> MoinResult<Vec<Category>> {
        let categories = {
            let mut store = guard(&self.inner.categories)?;
            store.delete(&self.inner.category_path, id)?
        };
        let affected = {
            let mut tasks = guard(&self.inner.tasks)?;
            tasks
                .values_mut()
                .filter(|task| task.category.as_deref() == Some(id))
                .map(|task| {
                    task.category = None;
                    task.updated_at = now_ms();
                    task.clone()
                })
                .collect::<Vec<_>>()
        };
        for task in affected {
            self.inner.store.upsert(&task).await?;
            self.inner.emitter.updated(&task);
        }
        Ok(categories)
    }

    pub async fn reorder_categories(&self, ids: Vec<String>) -> MoinResult<Vec<Category>> {
        let categories = {
            let mut store = guard(&self.inner.categories)?;
            store.reorder(&self.inner.category_path, &ids)?
        };
        Ok(categories)
    }

    /// Re-tag downloads and move their artefacts into the new category folder.
    ///
    /// A running transfer is paused first and given time to release its file
    /// handles, because renaming a file another thread is writing to would
    /// corrupt it. Cross-volume moves fall back to copy + delete and report
    /// their own progress.
    pub async fn move_to_category(
        &self,
        ids: Vec<String>,
        category: Option<String>,
        default_dir: PathBuf,
    ) -> MoinResult<()> {
        let target = match category.as_deref() {
            Some(id) => Some(
                guard(&self.inner.categories)?
                    .get(id)
                    .ok_or_else(|| MoinError::not_found("category", id))?,
            ),
            None => None,
        };
        let save_dir = target
            .as_ref()
            .and_then(|item| item.save_dir.as_deref())
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or(default_dir);
        let staging_dir = target
            .as_ref()
            .and_then(|item| item.incomplete_dir.as_deref())
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);

        for id in ids {
            self.task(&id)?;
            if self.is_active(&id) {
                if let Ok(control) = self.control(&id) {
                    control.set(Signal::Pause);
                }
                self.wait_inactive(&id).await?;
            }
            let task = self.task(&id)?;
            let finished = task.status == TaskStatus::Completed;
            // An unfinished download keeps using the staging folder; a finished
            // one belongs in the category's save folder.
            let folder = if finished {
                save_dir.clone()
            } else {
                staging_dir.clone().unwrap_or_else(|| save_dir.clone())
            };
            let final_dir = (!finished && folder != save_dir)
                .then(|| save_dir.to_string_lossy().into_owned());
            let current_folder = Path::new(&task.dest).parent().map(Path::to_path_buf);
            if current_folder.as_deref() == Some(folder.as_path()) {
                // Already in the right folder: only the label and the pending
                // destination change, nothing is touched on disk.
                self.mutate(&id, |task| {
                    task.category = category.clone();
                    task.final_dir = final_dir.clone();
                })
                .await?;
                continue;
            }
            tokio::fs::create_dir_all(&folder).await.map_err(|error| {
                MoinError::io(format!("Could not create the category directory: {error}"))
            })?;
            let target_dest = self.reserve_destination(&folder, &task.filename)?;
            let sources = [
                PathBuf::from(task.part_path()),
                PathBuf::from(task.meta_path()),
                PathBuf::from(format!("{}.aria2", task.part_path())),
                PathBuf::from(&task.dest),
            ];
            for source in sources {
                let name = source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string();
                let destination = target_dest
                    .parent()
                    .unwrap_or(&folder)
                    .join(&name);
                self.move_file(&id, &source, &destination)
                    .await
                    .map_err(MoinError::io)?;
            }
            let target_name = target_dest
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&task.filename)
                .to_string();
            self.mutate(&id, |task| {
                task.dest = target_dest.to_string_lossy().into_owned();
                task.filename = target_name;
                task.category = category.clone();
                task.final_dir = final_dir;
            })
            .await?;
        }
        Ok(())
    }

    pub fn category_folder(&self, category: Option<String>, default_dir: PathBuf) -> String {
        let categories = self.categories();
        category
            .and_then(|id| categories.into_iter().find(|item| item.id == id))
            .and_then(|item| item.save_dir)
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or(default_dir)
            .to_string_lossy()
            .into_owned()
    }

    pub async fn shutdown(&self) {
        self.inner.stopping.store(true, Ordering::Release);
        self.inner.queue_notify.notify_waiters();
        let controls: Vec<_> = guard(&self.inner.controls)
            .map(|items| items.values().cloned().collect())
            .unwrap_or_default();
        // `Cancel`, not `Pause`: the process is going away, so a worker that
        // lingers is a worker that keeps a file handle open.
        for control in controls {
            control.set(Signal::Cancel);
        }
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while self.has_active_transfers() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.inner.embedded.shutdown().await;
        self.inner.aria2.shutdown().await;
    }

    fn task(&self, id: &str) -> MoinResult<Task> {
        guard(&self.inner.tasks)?
            .get(id)
            .cloned()
            .ok_or_else(|| MoinError::not_found("download", id))
    }

    fn control(&self, id: &str) -> MoinResult<Control> {
        guard(&self.inner.controls)?
            .get(id)
            .cloned()
            .ok_or_else(|| MoinError::conflict("The download is no longer running."))
    }

    fn is_active(&self, id: &str) -> bool {
        guard(&self.inner.active)
            .map(|active| active.contains(id))
            .unwrap_or(false)
    }

    async fn wait_inactive(&self, id: &str) -> MoinResult<()> {
        let deadline = Instant::now() + STOP_WAIT;
        while self.is_active(id) {
            if Instant::now() >= deadline {
                return Err(MoinError::conflict(
                    "The download did not stop in time; its files were left untouched.",
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(())
    }

    async fn mutate<F>(&self, id: &str, update: F) -> MoinResult<Task>
    where
        F: FnOnce(&mut Task),
    {
        let task = {
            let mut tasks = guard(&self.inner.tasks)?;
            let task = tasks
                .get_mut(id)
                .ok_or_else(|| MoinError::not_found("download", id))?;
            update(task);
            task.updated_at = now_ms();
            task.clone()
        };
        self.inner.store.upsert(&task).await?;
        self.inner.emitter.updated(&task);
        Ok(task)
    }

    async fn set_status(
        &self,
        id: &str,
        status: TaskStatus,
        error: Option<String>,
    ) -> MoinResult<Task> {
        self.mutate(id, |task| {
            task.status = status;
            task.error = error;
            if status == TaskStatus::Completed && task.completed_at.is_none() {
                task.completed_at = Some(now_ms());
            }
        })
        .await
    }

    /// Pick the backend for `kind`: the external engine when it is installed and
    /// can handle the source, the built-in one otherwise.
    /// Resolve the backend for a task. `settings.http_backend` names the
    /// *preferred* engine, exactly like upstream: when it is not installed, was
    /// removed, or cannot handle this kind, the first usable backend wins, so a
    /// stale preference can never block a download.
    fn pick_backend(&self, kind: TaskKind) -> Arc<dyn DownloadBackend> {
        let aria2 = self.inner.aria2.clone() as Arc<dyn DownloadBackend>;
        let embedded = self.inner.embedded.clone() as Arc<dyn DownloadBackend>;
        let preferred = self.settings().http_backend;
        let candidates: [&Arc<dyn DownloadBackend>; 2] = [&aria2, &embedded];
        if let Some(chosen) = candidates.iter().find(|backend| {
            backend.id() == preferred && backend.supports(kind) && backend.available()
        }) {
            return Arc::clone(chosen);
        }
        candidates
            .iter()
            .find(|backend| backend.supports(kind) && backend.available())
            .map(|backend| Arc::clone(backend))
            .unwrap_or(embedded)
    }

    /// A path inside `folder` that neither another task nor the filesystem has
    /// claimed yet. Callers hold the task lock, so the probe is the plain
    /// `std::fs` one: this must not await.
    fn reserve_destination(&self, folder: &Path, filename: &str) -> MoinResult<PathBuf> {
        let occupied: HashSet<String> = guard(&self.inner.tasks)?
            .values()
            .map(|task| task.dest.to_lowercase())
            .collect();
        unique_destination(folder, filename, &occupied)
    }

    async fn run_scheduler(&self) {
        loop {
            if self.inner.stopping.load(Ordering::Acquire) {
                break;
            }
            self.pump().await;
            self.inner.queue_notify.notified().await;
        }
    }

    async fn pump(&self) {
        if self.inner.stopping.load(Ordering::Acquire) {
            return;
        }
        let settings = self.settings();
        let mut queued: Vec<Task> = match guard(&self.inner.tasks) {
            Ok(tasks) => tasks
                .values()
                .filter(|task| task.status == TaskStatus::Queued)
                .cloned()
                .collect(),
            Err(_) => return,
        };
        queued.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        let selected = {
            let Ok(mut active) = guard(&self.inner.active) else {
                return;
            };
            let capacity = if settings.max_concurrent == 0 {
                queued.len()
            } else {
                settings.max_concurrent.saturating_sub(active.len())
            };
            let selected: Vec<_> = queued
                .into_iter()
                .filter(|task| !active.contains(&task.id))
                .take(capacity)
                .collect();
            for task in &selected {
                active.insert(task.id.clone());
            }
            selected
        };
        for task in selected {
            let control = Control::new();
            if let Ok(mut controls) = guard(&self.inner.controls) {
                controls.insert(task.id.clone(), control.clone());
            }
            if self
                .set_status(&task.id, TaskStatus::Connecting, None)
                .await
                .is_err()
            {
                self.finish_active(&task.id);
                continue;
            }
            let engine = self.clone();
            let task_id = task.id.clone();
            tokio::spawn(async move {
                engine.run_task(task_id, control).await;
            });
        }
    }

    async fn run_task(&self, id: String, control: Control) {
        let task = match self.task(&id) {
            Ok(task) => task,
            Err(_) => {
                self.finish_active(&id);
                return;
            }
        };
        let backend = self.pick_backend(task.kind);
        let backend_id = backend.id().to_string();
        if task.backend.as_deref() != Some(backend_id.as_str()) {
            let _ = self
                .mutate(&id, |current| current.backend = Some(backend_id))
                .await;
        }
        let settings = self.settings();
        let opts = TransferOpts {
            connections: settings.connections,
            min_split_size: settings.min_split_size,
            hide_part: settings.hide_part_files,
            stall_timeout: Duration::from_secs(settings.stall_timeout_secs),
        };
        let progress = self.make_progress(&id);
        let started = Instant::now();
        let mut run = backend.run(task, opts, control, progress);
        let mut ticker = tokio::time::interval(PERSIST_INTERVAL);
        // The first tick of a fresh interval fires immediately; skip it so the
        // database is not written before a single byte moved.
        ticker.tick().await;
        let outcome = loop {
            tokio::select! {
                outcome = &mut run => break outcome,
                _ = ticker.tick() => self.persist_progress(&id).await,
            }
        };
        // `active_ms` is the wall time this attempt spent transferring. The row
        // shows `received / active_ms`, so a resumed download accumulates across
        // attempts instead of reporting the speed of its last slice.
        let elapsed = started.elapsed().as_millis().min(i64::MAX as u128) as i64;
        let _ = self
            .mutate(&id, |task| task.active_ms = task.active_ms.saturating_add(elapsed))
            .await;
        self.finish(&id, outcome).await;
    }

    /// Turn a backend outcome into a task status.
    async fn finish(&self, id: &str, outcome: Outcome) {
        if matches!(outcome, Outcome::Completed) {
            let needs_move = self
                .task(id)
                .map(|task| task.final_dir.is_some())
                .unwrap_or(false);
            if needs_move {
                let task = match self.task(id) {
                    Ok(task) => task,
                    Err(_) => {
                        self.finish_active(id);
                        return;
                    }
                };
                let _ = self.set_status(id, TaskStatus::Moving, None).await;
                if let Err(message) = self.relocate_to_final(&task).await {
                    self.settle(id, TaskStatus::Failed, Some(message)).await;
                    self.finish_active(id);
                    self.wake_queue();
                    return;
                }
            }
            let previous = self.task(id).map(|task| task.status).ok();
            let updated = self.settle(id, TaskStatus::Completed, None).await;
            if previous != Some(TaskStatus::Completed) {
                if let Some(task) = updated {
                    self.inner.emitter.completed(&task);
                }
            }
        } else {
            let (status, error) = match outcome {
                Outcome::Completed => unreachable!("handled above"),
                Outcome::Paused => (TaskStatus::Paused, None),
                Outcome::Canceled => (TaskStatus::Canceled, None),
                Outcome::Stalled => (
                    TaskStatus::Stalled,
                    Some("No data was received before the stall timeout.".to_string()),
                ),
                Outcome::Failed(message) => (TaskStatus::Failed, Some(message)),
            };
            self.settle(id, status, error).await;
        }
        self.finish_active(id);
        self.wake_queue();
    }

    /// Record the terminal status together with the byte count the files on
    /// disk actually hold, so a paused or failed row never over-reports.
    async fn settle(
        &self,
        id: &str,
        status: TaskStatus,
        error: Option<String>,
    ) -> Option<Task> {
        let current = self.task(id).ok()?;
        let measured = if status == TaskStatus::Completed {
            tokio::fs::metadata(&current.dest)
                .await
                .ok()
                .map(|metadata| metadata.len())
        } else {
            tokio::fs::metadata(current.part_path())
                .await
                .ok()
                .map(|metadata| metadata.len())
        };
        self.mutate(id, |task| {
            if let Some(size) = measured {
                task.received = size;
                if status == TaskStatus::Completed {
                    task.total = Some(size);
                }
            }
            task.status = status;
            task.error = error;
            if status == TaskStatus::Completed && task.completed_at.is_none() {
                task.completed_at = Some(now_ms());
            }
        })
        .await
        .ok()
    }

    fn wake_queue(&self) {
        if !self.inner.stopping.load(Ordering::Acquire) {
            self.inner.queue_notify.notify_one();
        }
    }

    fn finish_active(&self, id: &str) {
        if let Ok(mut active) = guard(&self.inner.active) {
            active.remove(id);
        }
        if let Ok(mut controls) = guard(&self.inner.controls) {
            controls.remove(id);
        }
    }

    /// Write the in-memory byte count to the database. Called on a timer while
    /// a transfer runs, so a crash loses at most one interval of progress.
    async fn persist_progress(&self, id: &str) {
        let snapshot = match guard(&self.inner.tasks) {
            Ok(tasks) => tasks.get(id).cloned(),
            Err(_) => None,
        };
        let Some(task) = snapshot else { return };
        if !matches!(
            task.status,
            TaskStatus::Connecting | TaskStatus::Downloading | TaskStatus::Moving
        ) {
            return;
        }
        if let Err(error) = self.inner.store.upsert(&task).await {
            log::debug!("Could not persist download progress: {}", error.message);
        }
    }

    /// The callback a backend reports through. It keeps the in-memory task in
    /// step with the transfer and hands a smoothed reading to the host, which
    /// batches it.
    fn make_progress(&self, id: &str) -> ProgressFn {
        let engine = self.clone();
        let task_id = id.to_string();
        let sampler = Arc::new(Mutex::new(SpeedSampler::new()));
        Arc::new(move |received: u64, total: Option<u64>| {
            let speed = sampler
                .lock()
                .map(|mut sampler| sampler.sample(received))
                .unwrap_or(0);
            if let Ok(mut tasks) = guard(&engine.inner.tasks) {
                if let Some(current) = tasks.get_mut(&task_id) {
                    current.received = received;
                    if total.is_some() {
                        current.total = total;
                    }
                    if current.status == TaskStatus::Connecting {
                        current.status = TaskStatus::Downloading;
                    }
                }
            }
            engine.inner.emitter.progress(TaskProgress {
                id: task_id.clone(),
                received,
                total,
                speed,
                status: TaskStatus::Downloading,
            });
        })
    }

    /// Move a finished download out of the staging folder into its category
    /// destination, then point the record at the new path.
    async fn relocate_to_final(&self, task: &Task) -> Result<(), String> {
        let Some(final_dir) = task.final_dir.as_deref() else {
            return Ok(());
        };
        let folder = PathBuf::from(final_dir);
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|error| format!("Could not create the category destination directory: {error}"))?;
        let target = self
            .reserve_destination(&folder, &task.filename)
            .map_err(|error| error.message)?;
        let source = PathBuf::from(&task.dest);
        self.move_file(&task.id, &source, &target).await?;
        let target_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&task.filename)
            .to_string();
        self.mutate(&task.id, |current| {
            current.dest = target.to_string_lossy().into_owned();
            current.filename = target_name;
            current.final_dir = None;
        })
        .await
        .map_err(|error| error.message)?;
        Ok(())
    }

    /// Rename `source` onto `target`, falling back to copy + delete across
    /// volumes. The copy path reports progress so a large cross-drive move does
    /// not look frozen.
    async fn move_file(&self, id: &str, source: &Path, target: &Path) -> Result<(), String> {
        if !tokio::fs::try_exists(source).await.unwrap_or(false) {
            return Ok(());
        }
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                format!("Could not create {}: {error}", parent.display())
            })?;
        }
        if tokio::fs::rename(source, target).await.is_ok() {
            return Ok(());
        }
        let mut input = tokio::fs::File::open(source)
            .await
            .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
        let total = input.metadata().await.ok().map(|metadata| metadata.len());
        let mut output = tokio::fs::File::create(target)
            .await
            .map_err(|error| format!("Could not create {}: {error}", target.display()))?;
        let mut buffer = vec![0u8; COPY_CHUNK];
        let mut copied = 0u64;
        loop {
            let read = match input.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) => return Err(format!("Could not read {}: {error}", source.display())),
            };
            output
                .write_all(&buffer[..read])
                .await
                .map_err(|error| format!("Could not write {}: {error}", target.display()))?;
            copied = copied.saturating_add(read as u64);
            self.inner.emitter.progress(TaskProgress {
                id: id.to_string(),
                received: copied,
                total,
                speed: 0,
                status: TaskStatus::Moving,
            });
        }
        if let Err(error) = output.flush().await {
            return Err(format!("Could not flush {}: {error}", target.display()));
        }
        drop(output);
        if let Err(error) = tokio::fs::remove_file(source).await {
            let _ = tokio::fs::remove_file(target).await;
            return Err(format!(
                "The file was copied but its previous copy could not be removed: {error}"
            ));
        }
        Ok(())
    }
}

/// `folder/filename`, or the first `stem (n).ext` variant that is neither used
/// by a task nor present on disk.
fn unique_destination(
    folder: &Path,
    filename: &str,
    occupied: &HashSet<String>,
) -> MoinResult<PathBuf> {
    let (stem, extension) = split_extension(filename);
    let mut candidate = folder.join(filename);
    let mut suffix = 1usize;
    loop {
        let taken_by_task = occupied.contains(&candidate.to_string_lossy().to_lowercase());
        let exists = candidate.try_exists().unwrap_or(true);
        if !taken_by_task && !exists {
            return Ok(candidate);
        }
        let next = if extension.is_empty() {
            format!("{stem} ({suffix})")
        } else {
            format!("{stem} ({suffix}).{extension}")
        };
        candidate = folder.join(next);
        suffix += 1;
        if suffix > 10_000 {
            return Err(MoinError::conflict(
                "Could not find an available destination filename.",
            ));
        }
    }
}

/// Report partial files that no task owns. They are left alone on purpose: a
/// user who renamed a task's record still wants the bytes, and guessing wrong
/// means deleting somebody's half-finished download.
async fn warn_unowned_partials(tasks: &HashMap<String, Task>, downloads_dir: &Path) {
    let mut owned: HashSet<String> = HashSet::new();
    let mut folders: HashSet<PathBuf> = HashSet::new();
    for task in tasks.values() {
        for path in [task.part_path(), task.meta_path()] {
            owned.insert(path.to_lowercase());
        }
        if let Some(parent) = Path::new(&task.dest).parent() {
            folders.insert(parent.to_path_buf());
        }
    }
    folders.insert(downloads_dir.to_path_buf());
    let mut reported = 0usize;
    for folder in folders {
        let Ok(mut entries) = tokio::fs::read_dir(&folder).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".part") && !name.ends_with(".part.meta") {
                continue;
            }
            let path = entry.path().to_string_lossy().to_string();
            if owned.contains(&path.to_lowercase()) {
                continue;
            }
            if reported >= ORPHAN_WARN_LIMIT {
                return;
            }
            reported += 1;
            log::warn!("Leaving a partial file that no download owns untouched: {path}");
        }
    }
}

fn split_extension(filename: &str) -> (&str, &str) {
    match filename.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, extension),
        _ => (filename, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::{Engine, Emitter};
    use crate::models::{
        Category, Settings, Task, TaskKind, TaskProgress, TaskStatus,
    };
    use crate::store::Store;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    struct NoopSink;

    impl Emitter for NoopSink {
        fn added(&self, _: &Task) {}
        fn progress(&self, _: TaskProgress) {}
        fn updated(&self, _: &Task) {}
        fn removed(&self, _: &str) {}
    }

    /// Keeps the highest speed any progress batch carried.
    struct SpeedSink {
        max_speed: AtomicU64,
    }

    impl Emitter for SpeedSink {
        fn added(&self, _: &Task) {}
        fn progress(&self, progress: TaskProgress) {
            self.max_speed.fetch_max(progress.speed, Ordering::Relaxed);
        }
        fn updated(&self, _: &Task) {}
        fn removed(&self, _: &str) {}
    }

    /// A task that stays paused, so a test never touches the network.
    async fn paused_engine(data: &Path, downloads: &Path) -> Engine {
        let settings = Settings {
            add_paused: true,
            ..Default::default()
        };
        write_settings(data, &settings);
        Engine::new(
            data.to_path_buf(),
            Arc::new(NoopSink),
            downloads.to_path_buf(),
        )
        .await
        .unwrap()
    }

    fn write_settings(dir: &Path, settings: &Settings) {
        std::fs::write(
            dir.join("settings.json"),
            serde_json::to_vec(settings).unwrap(),
        )
        .unwrap();
    }

    fn sample_task(dest: &Path, status: TaskStatus) -> Task {
        Task {
            id: "record".to_string(),
            kind: TaskKind::Http,
            url: "https://example.test/file.bin".to_string(),
            filename: dest
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("file.bin")
                .to_string(),
            dest: dest.to_string_lossy().into_owned(),
            status,
            total: None,
            received: 0,
            error: None,
            created_at: 1,
            updated_at: 1,
            completed_at: None,
            archived: false,
            active_ms: 0,
            backend: None,
            category: None,
            final_dir: None,
            headers: BTreeMap::new(),
        }
    }

    fn sample_category(id: &str, save_dir: &Path) -> Category {
        Category {
            id: id.to_string(),
            name: id.to_string(),
            color: String::new(),
            icon: None,
            hidden_from_all: false,
            save_dir: Some(save_dir.to_string_lossy().into_owned()),
            incomplete_dir: None,
            sources: Vec::new(),
            triggers: Vec::new(),
            order: 10,
            legacy: BTreeMap::new(),
        }
    }

    async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let count = tokio::io::AsyncReadExt::read(socket, &mut chunk)
                .await
                .unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..count]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        String::from_utf8_lossy(&request).to_string()
    }

    #[tokio::test]
    async fn speed_sampler_primes_then_measures() {
        let mut sampler = super::SpeedSampler::new();
        assert_eq!(
            sampler.sample(1024),
            0,
            "the first sample only records a baseline"
        );

        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(
            sampler.sample(1024 + 512 * 1024) > 0,
            "a window with new bytes reports a rate"
        );

        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(
            sampler.sample(1024 + 512 * 1024),
            0,
            "a window without bytes reports zero"
        );
    }

    #[tokio::test]
    async fn terminal_actions_are_rejected_on_running_downloads() {
        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let engine = Engine::new(
            data_dir.path().to_path_buf(),
            Arc::new(NoopSink),
            download_dir.path().to_path_buf(),
        )
        .await
        .unwrap();
        assert!(!engine.has_active_transfers());
        assert_eq!(
            engine.pause("missing").await.unwrap_err().code,
            crate::MoinErrorCode::NotFound
        );
        let backends = engine.backends();
        assert_eq!(backends.len(), 2, "both engines are always listed");
        let embedded = backends
            .iter()
            .find(|backend| backend.id == "embedded")
            .unwrap();
        assert!(embedded.available);
        assert!(backends.iter().any(|backend| backend.id == "aria2"));
        assert_eq!(
            engine.settings().max_concurrent,
            Settings::default().max_concurrent
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn illegal_state_transitions_return_conflict() {
        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let engine = paused_engine(data_dir.path(), download_dir.path()).await;
        let task = engine
            .add_http(
                "https://example.test/a.bin".to_string(),
                download_dir.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(task.status, TaskStatus::Paused);
        assert_eq!(
            engine.pause(&task.id).await.unwrap_err().code,
            crate::MoinErrorCode::Conflict,
            "a paused download cannot be paused again"
        );
        assert_eq!(
            engine.retry(&task.id).await.unwrap_err().code,
            crate::MoinErrorCode::Conflict,
            "only failed, stalled and canceled downloads are retried"
        );
        engine.resume(&task.id).await.unwrap();
        assert_eq!(
            engine.resume(&task.id).await.unwrap_err().code,
            crate::MoinErrorCode::Conflict,
            "a queued download cannot be resumed"
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn archiving_keeps_the_file_and_the_record() {
        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let engine = paused_engine(data_dir.path(), download_dir.path()).await;
        let task = engine
            .add_http(
                "https://example.test/keep.bin".to_string(),
                download_dir.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        tokio::fs::write(&task.dest, b"payload").await.unwrap();
        engine.archive_many(vec![task.id.clone()], false).await.unwrap();
        let listed = engine.list();
        let archived = listed.iter().find(|item| item.id == task.id).unwrap();
        assert!(archived.archived);
        assert!(
            tokio::fs::try_exists(&task.dest).await.unwrap(),
            "archiving must not delete the file"
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn deleting_removes_every_artifact_and_keeps_the_record() {
        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let engine = paused_engine(data_dir.path(), download_dir.path()).await;
        let task = engine
            .add_http(
                "https://example.test/drop.bin".to_string(),
                download_dir.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        let artifacts = [
            PathBuf::from(&task.dest),
            PathBuf::from(task.part_path()),
            PathBuf::from(task.meta_path()),
            PathBuf::from(format!("{}.aria2", task.part_path())),
        ];
        for path in &artifacts {
            tokio::fs::write(path, b"payload").await.unwrap();
        }
        engine.archive_many(vec![task.id.clone()], true).await.unwrap();
        for path in &artifacts {
            assert!(
                !tokio::fs::try_exists(path).await.unwrap(),
                "{} should be gone",
                path.display()
            );
        }
        let listed = engine.list();
        let kept = listed.iter().find(|item| item.id == task.id).unwrap();
        assert!(kept.archived);
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn retry_requeues_a_failed_download_without_clearing_progress() {
        // Phase 1: a body shorter than its own Content-Length fails the
        // transfer after 40 bytes, leaving a `.part` behind.
        let short_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let short_address = short_listener.local_addr().unwrap();
        let short_server = tokio::spawn(async move {
            let (mut socket, _) = short_listener.accept().await.unwrap();
            let _ = read_request(&mut socket).await;
            let header = "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n";
            tokio::io::AsyncWriteExt::write_all(&mut socket, header.as_bytes())
                .await
                .unwrap();
            tokio::io::AsyncWriteExt::write_all(&mut socket, &[7u8; 40])
                .await
                .unwrap();
        });

        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        // One connection and one slot: the probe is skipped and the queue can
        // be occupied deterministically below.
        let settings = Settings {
            connections: 1,
            max_concurrent: 1,
            stall_timeout_secs: 5,
            ..Default::default()
        };
        write_settings(data_dir.path(), &settings);
        let engine = Engine::new(
            data_dir.path().to_path_buf(),
            Arc::new(NoopSink),
            download_dir.path().to_path_buf(),
        )
        .await
        .unwrap();
        let task = engine
            .add_http(
                format!("http://{short_address}/short.bin"),
                download_dir.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        let failed = wait_for(&engine, &task.id, |task| {
            task.status == TaskStatus::Failed
        })
        .await;
        short_server.await.unwrap();
        assert_eq!(failed.received, 40, "the partial holds the received bytes");

        // Phase 2: occupy the only slot with a request the server never
        // answers, so the retried task has to wait in the queue.
        let hang_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let hang_address = hang_listener.local_addr().unwrap();
        let holder = tokio::spawn(async move {
            let mut sockets = Vec::new();
            loop {
                let Ok((socket, _)) = hang_listener.accept().await else {
                    return;
                };
                sockets.push(socket);
            }
        });
        let blocker = engine
            .add_http(
                format!("http://{hang_address}/hang.bin"),
                download_dir.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        wait_for(&engine, &blocker.id, |task| {
            task.status == TaskStatus::Connecting
        })
        .await;

        engine.retry(&task.id).await.unwrap();
        let requeued = engine
            .list()
            .into_iter()
            .find(|item| item.id == task.id)
            .unwrap();
        assert_eq!(requeued.status, TaskStatus::Queued);
        assert_eq!(requeued.received, 40, "retrying keeps the byte count");
        // The hanging worker never finishes; the runtime drops it with the test.
        holder.abort();
    }

    #[tokio::test]
    async fn forget_drops_the_record_from_memory_and_the_store() {
        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let engine = paused_engine(data_dir.path(), download_dir.path()).await;
        let task = engine
            .add_http(
                "https://example.test/forget.bin".to_string(),
                download_dir.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        tokio::fs::write(&task.dest, b"payload").await.unwrap();
        engine.forget(&task.id).await.unwrap();
        assert!(engine.list().is_empty());
        let store = Store::open(data_dir.path()).await.unwrap();
        assert!(store.all().await.unwrap().is_empty());
        assert!(
            tokio::fs::try_exists(&task.dest).await.unwrap(),
            "forgetting a record must leave the file alone"
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn add_http_rejects_blank_urls_and_deduplicates_names() {
        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let engine = paused_engine(data_dir.path(), download_dir.path()).await;
        assert_eq!(
            engine
                .add_http(
                    String::new(),
                    download_dir.path().to_path_buf(),
                    None,
                    Default::default(),
                    None,
                )
                .await
                .unwrap_err()
                .code,
            crate::MoinErrorCode::InvalidInput
        );
        let first = engine
            .add_http(
                "https://example.test/same.bin".to_string(),
                download_dir.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        let second = engine
            .add_http(
                "https://example.test/same.bin".to_string(),
                download_dir.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        assert_ne!(first.dest, second.dest, "the same name must not be reused");
        assert_eq!(second.filename, "same (1).bin");
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn set_settings_persists_the_download_directory() {
        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let category_dir = tempfile::tempdir().unwrap();
        let engine = paused_engine(data_dir.path(), download_dir.path()).await;
        let mut next = engine.settings();
        next.download_dir = Some(download_dir.path().to_string_lossy().into_owned());
        engine.set_settings(next.clone()).unwrap();
        let saved = engine.settings();
        assert_eq!(saved.download_dir, next.download_dir);
        assert_eq!(
            engine.category_folder(None, PathBuf::from(saved.download_dir.clone().unwrap())),
            download_dir.path().to_string_lossy()
        );
        engine
            .create_category(sample_category("docs", category_dir.path()))
            .await
            .unwrap();
        assert_eq!(
            engine.category_folder(Some("docs".to_string()), PathBuf::from("/elsewhere")),
            category_dir.path().to_string_lossy(),
            "a category save directory wins over the default"
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn restart_demotes_unfinished_downloads_to_paused() {
        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let dest = download_dir.path().join("movie.bin");
        {
            let store = Store::open(data_dir.path()).await.unwrap();
            store
                .upsert(&sample_task(&dest, TaskStatus::Downloading))
                .await
                .unwrap();
        }
        let engine = Engine::new(
            data_dir.path().to_path_buf(),
            Arc::new(NoopSink),
            download_dir.path().to_path_buf(),
        )
        .await
        .unwrap();
        let listed = engine.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].status,
            TaskStatus::Paused,
            "a crashed transfer must not resume on its own"
        );
        assert!(!engine.has_active_transfers());
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn move_to_category_relocates_the_partial_files() {
        let data_dir = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        let category_dir = tempfile::tempdir().unwrap();
        let engine = paused_engine(data_dir.path(), staging.path()).await;
        let task = engine
            .add_http(
                "https://example.test/report.pdf".to_string(),
                staging.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        tokio::fs::write(task.part_path(), b"half a document")
            .await
            .unwrap();
        engine
            .create_category(sample_category("docs", category_dir.path()))
            .await
            .unwrap();
        engine
            .move_to_category(
                vec![task.id.clone()],
                Some("docs".to_string()),
                staging.path().to_path_buf(),
            )
            .await
            .unwrap();
        let moved = engine
            .list()
            .into_iter()
            .find(|item| item.id == task.id)
            .unwrap();
        assert_eq!(moved.category.as_deref(), Some("docs"));
        assert_eq!(moved.final_dir, None);
        assert_eq!(
            Path::new(&moved.dest).parent().unwrap(),
            category_dir.path(),
            "the destination follows the category"
        );
        assert!(tokio::fs::try_exists(moved.part_path()).await.unwrap());
        assert!(!tokio::fs::try_exists(task.part_path()).await.unwrap());
        assert_eq!(
            tokio::fs::read(moved.part_path()).await.unwrap(),
            b"half a document"
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn deleting_a_category_untags_without_moving_files() {
        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let category_dir = tempfile::tempdir().unwrap();
        let engine = paused_engine(data_dir.path(), download_dir.path()).await;
        engine
            .create_category(sample_category("docs", category_dir.path()))
            .await
            .unwrap();
        let task = engine
            .add_http(
                "https://example.test/report.pdf".to_string(),
                download_dir.path().to_path_buf(),
                Some("docs".to_string()),
                Default::default(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(task.category.as_deref(), Some("docs"));
        engine.delete_category("docs").await.unwrap();
        let untagged = engine
            .list()
            .into_iter()
            .find(|item| item.id == task.id)
            .unwrap();
        assert_eq!(untagged.category, None);
        assert_eq!(untagged.dest, task.dest, "files are not moved");
        engine.shutdown().await;
    }

    async fn wait_for(
        engine: &Engine,
        id: &str,
        predicate: impl Fn(&Task) -> bool,
    ) -> Task {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let current = engine
                .list()
                .into_iter()
                .find(|item| item.id == id)
                .expect("the task stays in the list");
            if predicate(&current) {
                return current;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out while waiting for {} (last status {:?})",
                id,
                current.status
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// The multi-connection path used to hardcode `speed: 0`, which left the
    /// card showing `0 B/s` for every download big enough to be segmented.
    #[tokio::test]
    async fn segmented_download_reports_a_live_speed() {
        let body: Vec<u8> = (0..256 * 1024).map(|value| (value % 251) as u8).collect();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let source = Arc::new(body.clone());
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let source = source.clone();
                tokio::spawn(async move {
                    let request = read_request(&mut socket).await;
                    let Some((start, end)) = request
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("range").then_some(value.trim())
                        })
                        .and_then(|value| value.strip_prefix("bytes="))
                        .and_then(|value| value.split_once('-'))
                    else {
                        return;
                    };
                    let start: usize = start.parse().unwrap();
                    let end: usize = match end {
                        "" => source.len() - 1,
                        value => value.parse().unwrap(),
                    };
                    let payload = &source[start..=end];
                    let header = format!(
                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        source.len(),
                        payload.len()
                    );
                    tokio::io::AsyncWriteExt::write_all(&mut socket, header.as_bytes())
                        .await
                        .unwrap();
                    // Trickle the body so the transfer outlives one speed window.
                    for chunk in payload.chunks(4096) {
                        tokio::io::AsyncWriteExt::write_all(&mut socket, chunk)
                            .await
                            .unwrap();
                        tokio::time::sleep(Duration::from_millis(80)).await;
                    }
                });
            }
        });

        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.connections = 4;
        settings.min_split_size = 1;
        write_settings(data_dir.path(), &settings);
        let sink = Arc::new(SpeedSink {
            max_speed: AtomicU64::new(0),
        });
        let engine = Engine::new(
            data_dir.path().to_path_buf(),
            sink.clone(),
            download_dir.path().to_path_buf(),
        )
        .await
        .unwrap();
        let task = engine
            .add_http(
                format!("http://{address}/payload.bin"),
                download_dir.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let current = engine
                    .list()
                    .into_iter()
                    .find(|item| item.id == task.id)
                    .unwrap();
                if matches!(current.status, TaskStatus::Completed | TaskStatus::Failed) {
                    break current;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        server.abort();
        assert_eq!(tokio::fs::read(&task.dest).await.unwrap(), body);
        assert!(
            sink.max_speed.load(Ordering::Relaxed) > 0,
            "a segmented download must report a non-zero speed"
        );
        engine.shutdown().await;
    }

    #[tokio::test]
    async fn queued_http_download_falls_back_when_range_is_not_supported() {
        let body = b"wingharness download smoke test".to_vec();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let payload = body.clone();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let _request = read_request(&mut socket).await;
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                tokio::io::AsyncWriteExt::write_all(&mut socket, header.as_bytes())
                    .await
                    .unwrap();
                tokio::io::AsyncWriteExt::write_all(&mut socket, &payload)
                    .await
                    .unwrap();
            }
        });

        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let engine = Engine::new(
            data_dir.path().to_path_buf(),
            Arc::new(NoopSink),
            download_dir.path().to_path_buf(),
        )
        .await
        .unwrap();
        let task = engine
            .add_http(
                format!("http://{address}/payload.bin"),
                download_dir.path().to_path_buf(),
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let current = engine
                    .list()
                    .into_iter()
                    .find(|item| item.id == task.id)
                    .unwrap();
                if matches!(current.status, TaskStatus::Completed | TaskStatus::Failed) {
                    break current;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(tokio::fs::read(&task.dest).await.unwrap(), body);
        engine.shutdown().await;
    }
}
