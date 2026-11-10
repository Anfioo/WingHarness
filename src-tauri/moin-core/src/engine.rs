// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See UPSTREAM.md for the porting record.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{HeaderName, HeaderValue, CONTENT_RANGE, RANGE};
use reqwest::Client;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Notify, RwLock};
use url::Url;
use uuid::Uuid;

use crate::categories::{AddMethodKind, Category, CategoryStore};
use crate::error::{MoinError, MoinResult};
use crate::models::{filename_from_url, now_ms, sanitize_filename, MoinSettings, Task, TaskKind, TaskProgress, TaskStatus};
use crate::{settings, store::Store};

pub trait EventSink: Send + Sync + 'static {
    fn task_added(&self, task: &Task);
    fn task_updated(&self, task: &Task);
    fn task_removed(&self, id: &str);
    fn task_progress(&self, items: &[TaskProgress]);
    fn task_completed(&self, task: &Task);
    fn settings_changed(&self, settings: &MoinSettings);
    fn categories_changed(&self, categories: &[Category]);
}

#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

struct Inner {
    data_dir: PathBuf,
    default_download_dir: PathBuf,
    category_path: PathBuf,
    store: Store,
    categories: RwLock<CategoryStore>,
    settings: RwLock<MoinSettings>,
    tasks: RwLock<HashMap<String, Task>>,
    active: Mutex<HashSet<String>>,
    controls: Mutex<HashMap<String, Control>>,
    progress: Mutex<HashMap<String, TaskProgress>>,
    progress_notify: Notify,
    queue_notify: Notify,
    stopping: AtomicBool,
    sink: Arc<dyn EventSink>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ControlSignal {
    Run,
    Pause,
    Cancel,
}

#[derive(Clone, Default)]
pub(crate) struct Control(Arc<Mutex<ControlSignal>>);

impl Default for ControlSignal {
    fn default() -> Self {
        Self::Run
    }
}

impl Control {
    pub(crate) fn signal(&self) -> ControlSignal {
        self.0.lock().map(|signal| *signal).unwrap_or(ControlSignal::Cancel)
    }

    fn set(&self, value: ControlSignal) {
        if let Ok(mut signal) = self.0.lock() {
            *signal = value;
        }
    }
}

#[derive(Debug)]
pub(crate) enum Outcome {
    Completed,
    Paused,
    Canceled,
    Stalled,
    Failed(String),
}

/// How often a byte rate is recomputed from the running total.
const SPEED_WINDOW: Duration = Duration::from_millis(500);

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
    pub async fn open(
        data_dir: PathBuf,
        default_download_dir: PathBuf,
        proxy_url: String,
        sink: Arc<dyn EventSink>,
    ) -> MoinResult<Self> {
        tokio::fs::create_dir_all(&data_dir)
            .await
            .map_err(|error| MoinError::io(format!("Could not create the moin data directory: {error}")))?;
        let store = Store::open(&data_dir)
            .await
            .map_err(|error| MoinError::io(format!("Could not open the downloads database: {error}")))?;
        let category_path = data_dir.join("categories.json");
        let categories = CategoryStore::load(&category_path);
        let mut settings = settings::load(&data_dir);
        if settings.validate().is_err() {
            log::warn!("Invalid moin settings were replaced with defaults.");
            settings = MoinSettings::default();
        }
        settings.proxy_url = if proxy_url.trim().is_empty() { None } else { Some(proxy_url) };
        if settings.rpc_token.is_empty() {
            settings.rpc_token = Uuid::new_v4().to_string();
            settings::save(&data_dir, &settings)
                .map_err(|error| MoinError::io(format!("Could not save default moin settings: {error}")))?;
        }
        let mut tasks = HashMap::new();
        for mut task in store
            .all()
            .await
            .map_err(|error| MoinError::io(format!("Could not load downloads: {error}")))?
        {
            if matches!(task.status, TaskStatus::Connecting | TaskStatus::Downloading | TaskStatus::Moving) {
                task.status = TaskStatus::Paused;
                task.updated_at = now_ms();
                store.upsert(&task).await.map_err(|error| MoinError::io(error))?;
            }
            tasks.insert(task.id.clone(), task);
        }
        let engine = Self {
            inner: Arc::new(Inner {
                data_dir,
                default_download_dir,
                category_path,
                store,
                categories: RwLock::new(categories),
                settings: RwLock::new(settings),
                tasks: RwLock::new(tasks),
                active: Mutex::new(HashSet::new()),
                controls: Mutex::new(HashMap::new()),
                progress: Mutex::new(HashMap::new()),
                progress_notify: Notify::new(),
                queue_notify: Notify::new(),
                stopping: AtomicBool::new(false),
                sink,
            }),
        };
        let flusher = engine.clone();
        tokio::spawn(async move {
            flusher.flush_progress().await;
        });
        let scheduler = engine.clone();
        tokio::spawn(async move {
            scheduler.run_scheduler().await;
        });
        Ok(engine)
    }

    pub async fn list(&self) -> Vec<Task> {
        let mut tasks: Vec<_> = self.inner.tasks.read().await.values().cloned().collect();
        tasks.sort_by(|left, right| {
            right.created_at.cmp(&left.created_at).then_with(|| right.id.cmp(&left.id))
        });
        tasks
    }

    pub async fn add_http(
        &self,
        url: String,
        filename: Option<String>,
        category: Option<String>,
        headers: BTreeMap<String, String>,
    ) -> MoinResult<Task> {
        let parsed = Url::parse(url.trim())
            .map_err(|error| MoinError::invalid_input("url", error.to_string()))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(MoinError::invalid_input("url", "Only absolute HTTP and HTTPS URLs are supported."));
        }
        if url.len() > 16_384 {
            return Err(MoinError::invalid_input("url", "The URL is too long."));
        }
        if headers.len() > 64 {
            return Err(MoinError::invalid_input("headers", "At most 64 request headers are allowed."));
        }
        let mut header_bytes = 0usize;
        for (name, value) in &headers {
            header_bytes = header_bytes.saturating_add(name.len()).saturating_add(value.len());
            if HeaderName::from_bytes(name.as_bytes()).is_err() || HeaderValue::from_str(value).is_err() {
                return Err(MoinError::invalid_input("headers", "A header name or value is invalid."));
            }
        }
        if header_bytes > 64 * 1024 {
            return Err(MoinError::invalid_input("headers", "Request headers exceed 64 KiB."));
        }
        let settings = self.inner.settings.read().await.clone();
        let (suggested_category, available_categories) = {
            let categories = self.inner.categories.read().await;
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
        if category_id.as_ref().is_some_and(|id| !available_categories.iter().any(|item| &item.id == id)) {
            return Err(MoinError::not_found("category", category_id.as_deref().unwrap_or_default()));
        }
        let default_folder = settings
            .download_dir
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.inner.default_download_dir.clone());
        let category = category_id.as_ref().and_then(|id| available_categories.iter().find(|item| &item.id == id));
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
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|error| MoinError::io(format!("Could not create the download directory: {error}")))?;
        let requested = filename
            .as_deref()
            .and_then(sanitize_filename)
            .unwrap_or_else(|| sanitize_filename(&filename_from_url(parsed.as_str())).unwrap_or_else(|| "download".into()));
        let target = self.unique_destination(&folder, &requested).await?;
        let timestamp = now_ms();
        let task = Task {
            id: Uuid::new_v4().to_string(),
            kind: TaskKind::Http,
            url: parsed.to_string(),
            filename: target.file_name().and_then(|name| name.to_str()).unwrap_or("download").to_string(),
            dest: target.to_string_lossy().into_owned(),
            status: if settings.add_paused { TaskStatus::Paused } else { TaskStatus::Queued },
            total: None,
            received: 0,
            error: None,
            created_at: timestamp,
            updated_at: timestamp,
            completed_at: None,
            archived: false,
            active_ms: 0,
            backend: Some("embedded".into()),
            category: category_id,
            final_dir,
            headers,
        };
        self.inner.store.upsert(&task).await.map_err(|error| MoinError::io(error))?;
        self.inner.tasks.write().await.insert(task.id.clone(), task.clone());
        self.inner.sink.task_added(&task);
        if task.status == TaskStatus::Queued {
            self.inner.queue_notify.notify_one();
        }
        Ok(task)
    }

    async fn unique_destination(&self, folder: &Path, filename: &str) -> MoinResult<PathBuf> {
        let mut candidate = folder.join(filename);
        let (stem, extension) = split_extension(filename);
        let occupied_destinations: HashSet<String> = self.inner.tasks.read().await.values()
            .map(|task| task.dest.to_lowercase())
            .collect();
        let mut suffix = 1usize;
        loop {
            let path = candidate.to_string_lossy().to_lowercase();
            let occupied_by_task = occupied_destinations.contains(path.as_str());
            let exists = tokio::fs::try_exists(&candidate).await.unwrap_or(true);
            if !occupied_by_task && !exists {
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
                return Err(MoinError::conflict("Could not find an available destination filename."));
            }
        }
    }

    pub async fn pause(&self, id: &str) -> MoinResult<()> {
        let task = self.task(id).await?;
        match task.status {
            TaskStatus::Queued => {
                self.set_status(id, TaskStatus::Paused, None).await?;
            }
            TaskStatus::Connecting | TaskStatus::Downloading => {
                let control = self.control(id)?;
                control.set(ControlSignal::Pause);
            }
            _ => return Err(MoinError::conflict(format!("A {} download cannot be paused.", task.status.as_str()))),
        }
        Ok(())
    }

    pub async fn resume(&self, id: &str) -> MoinResult<()> {
        let task = self.task(id).await?;
        if !matches!(task.status, TaskStatus::Paused | TaskStatus::Failed | TaskStatus::Stalled) {
            return Err(MoinError::conflict(format!("A {} download cannot be resumed.", task.status.as_str())));
        }
        self.set_status(id, TaskStatus::Queued, None).await?;
        self.inner.queue_notify.notify_one();
        Ok(())
    }

    pub async fn cancel(&self, id: &str) -> MoinResult<()> {
        let task = self.task(id).await?;
        match task.status {
            TaskStatus::Queued | TaskStatus::Paused | TaskStatus::Failed | TaskStatus::Stalled => {
                self.set_status(id, TaskStatus::Canceled, None).await?;
            }
            TaskStatus::Connecting | TaskStatus::Downloading => self.control(id)?.set(ControlSignal::Cancel),
            _ => return Err(MoinError::conflict(format!("A {} download cannot be canceled.", task.status.as_str()))),
        }
        Ok(())
    }

    pub async fn remove(&self, id: &str) -> MoinResult<()> {
        let task = self.task(id).await?;
        if task.archived {
            return Ok(());
        }
        self.mutate(id, |task| task.archived = true).await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> MoinResult<()> {
        if self.is_active(id) {
            self.control(id)?.set(ControlSignal::Cancel);
            self.wait_inactive(id).await?;
        }
        let task = self.task(id).await?;
        for path in [PathBuf::from(&task.dest), PathBuf::from(task.part_path()), PathBuf::from(task.meta_path())] {
            match tokio::fs::remove_file(path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(MoinError::io(format!("Could not remove the download file: {error}"))),
            }
        }
        self.inner.store.delete(id).await.map_err(|error| MoinError::io(error))?;
        self.inner.tasks.write().await.remove(id);
        self.inner.sink.task_removed(id);
        Ok(())
    }

    pub async fn forget(&self, id: &str) -> MoinResult<()> {
        if self.is_active(id) {
            return Err(MoinError::conflict("Pause or cancel the download before removing its record."));
        }
        self.task(id).await?;
        self.inner.store.delete(id).await.map_err(|error| MoinError::io(error))?;
        self.inner.tasks.write().await.remove(id);
        self.inner.sink.task_removed(id);
        Ok(())
    }

    pub async fn categories(&self) -> Vec<Category> {
        self.inner.categories.read().await.list()
    }

    pub async fn suggest_category(&self, url: &str, filename: Option<&str>) -> Option<String> {
        self.inner.categories.read().await.suggest(url, filename, AddMethodKind::ManualLink, None)
    }

    pub async fn upsert_category(&self, category: Category) -> MoinResult<Vec<Category>> {
        let categories = {
            let mut store = self.inner.categories.write().await;
            store.upsert(&self.inner.category_path, category)?
        };
        self.inner.sink.categories_changed(&categories);
        Ok(categories)
    }

    pub async fn delete_category(&self, id: &str) -> MoinResult<Vec<Category>> {
        let categories = {
            let mut store = self.inner.categories.write().await;
            store.delete(&self.inner.category_path, id)?
        };
        let affected = {
            let mut tasks = self.inner.tasks.write().await;
            tasks.values_mut()
                .filter(|task| task.category.as_deref() == Some(id))
                .map(|task| {
                    task.category = None;
                    task.final_dir = None;
                    task.updated_at = now_ms();
                    task.clone()
                })
                .collect::<Vec<_>>()
        };
        for task in affected {
            self.inner.store.upsert(&task).await.map_err(|error| MoinError::io(error))?;
            self.inner.sink.task_updated(&task);
        }
        self.inner.sink.categories_changed(&categories);
        Ok(categories)
    }

    pub async fn reorder_categories(&self, ids: &[String]) -> MoinResult<Vec<Category>> {
        let categories = {
            let mut store = self.inner.categories.write().await;
            store.reorder(&self.inner.category_path, ids)?
        };
        self.inner.sink.categories_changed(&categories);
        Ok(categories)
    }

    pub async fn settings(&self) -> MoinSettings {
        self.inner.settings.read().await.clone()
    }

    pub async fn patch_settings(&self, patch: serde_json::Value) -> MoinResult<MoinSettings> {
        let mut value = serde_json::to_value(self.inner.settings.read().await.clone())
            .map_err(|error| MoinError::internal(error.to_string()))?;
        let patch = patch.as_object().ok_or_else(|| MoinError::invalid_input("patch", "Expected an object."))?;
        let object = value.as_object_mut().ok_or_else(|| MoinError::internal("Settings could not be encoded."))?;
        for (key, value) in patch {
            if !object.contains_key(key) {
                return Err(MoinError::invalid_input("patch", format!("Unknown setting '{key}'.")));
            }
            object.insert(key.clone(), value.clone());
        }
        let mut next: MoinSettings = serde_json::from_value(value)
            .map_err(|error| MoinError::invalid_input("patch", error.to_string()))?;
        next.validate().map_err(|error| MoinError::invalid_input("patch", error))?;
        if next.http_backend == "aria2" {
            return Err(MoinError::backend_unavailable("The aria2 backend is not integrated yet."));
        }
        settings::save(&self.inner.data_dir, &next)
            .map_err(|error| MoinError::io(format!("Could not save moin settings: {error}")))?;
        let concurrency_changed = {
            let mut current = self.inner.settings.write().await;
            let changed = current.max_concurrent != next.max_concurrent;
            *current = next.clone();
            changed
        };
        if concurrency_changed {
            self.inner.queue_notify.notify_one();
        }
        self.inner.sink.settings_changed(&next);
        Ok(next)
    }

    pub async fn shutdown(&self) {
        self.inner.stopping.store(true, Ordering::Release);
        let controls: Vec<_> = self.inner.controls.lock().map(|items| items.values().cloned().collect()).unwrap_or_default();
        for control in controls {
            control.set(ControlSignal::Pause);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.inner.active.lock().map(|active| active.is_empty()).unwrap_or(true) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.inner.progress_notify.notify_one();
        self.flush_progress_once();
    }

    async fn task(&self, id: &str) -> MoinResult<Task> {
        self.inner.tasks.read().await.get(id).cloned().ok_or_else(|| MoinError::not_found("download", id))
    }

    fn control(&self, id: &str) -> MoinResult<Control> {
        self.inner.controls.lock()
            .map_err(|_| MoinError::internal("The download control lock is unavailable."))?
            .get(id)
            .cloned()
            .ok_or_else(|| MoinError::conflict("The download is no longer running."))
    }

    fn is_active(&self, id: &str) -> bool {
        self.inner.active.lock().map(|active| active.contains(id)).unwrap_or(false)
    }

    async fn wait_inactive(&self, id: &str) -> MoinResult<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while self.is_active(id) {
            if Instant::now() >= deadline {
                return Err(MoinError::conflict("The download did not stop in time; its files were left untouched."));
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
            let mut tasks = self.inner.tasks.write().await;
            let task = tasks.get_mut(id).ok_or_else(|| MoinError::not_found("download", id))?;
            update(task);
            task.updated_at = now_ms();
            task.clone()
        };
        self.inner.store.upsert(&task).await.map_err(|error| MoinError::io(error))?;
        self.inner.sink.task_updated(&task);
        Ok(task)
    }

    async fn set_status(&self, id: &str, status: TaskStatus, error: Option<String>) -> MoinResult<Task> {
        self.mutate(id, |task| {
            task.status = status;
            task.error = error;
            if status == TaskStatus::Completed && task.completed_at.is_none() {
                task.completed_at = Some(now_ms());
            }
        }).await
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
        let settings = self.inner.settings.read().await.clone();
        let mut queued: Vec<Task> = self.inner.tasks.read().await.values()
            .filter(|task| task.status == TaskStatus::Queued)
            .cloned()
            .collect();
        queued.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        let selected = {
            let mut active = match self.inner.active.lock() {
                Ok(active) => active,
                Err(_) => return,
            };
            let capacity = if settings.max_concurrent == 0 {
                queued.len()
            } else {
                settings.max_concurrent.saturating_sub(active.len())
            };
            let selected: Vec<_> = queued.into_iter()
                .filter(|task| !active.contains(&task.id))
                .take(capacity)
                .collect();
            for task in &selected {
                active.insert(task.id.clone());
            }
            selected
        };
        for task in selected {
            let control = Control::default();
            if let Ok(mut controls) = self.inner.controls.lock() {
                controls.insert(task.id.clone(), control.clone());
            }
            if self.set_status(&task.id, TaskStatus::Connecting, None).await.is_err() {
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
        let task = match self.task(&id).await {
            Ok(task) => task,
            Err(_) => {
                self.finish_active(&id);
                return;
            }
        };
        let mut outcome = self.download_http(&task, &control).await;
        if matches!(outcome, Outcome::Completed) {
            if let Ok(current) = self.task(&id).await {
                if current.final_dir.is_some() {
                    let _ = self.set_status(&id, TaskStatus::Moving, None).await;
                    if let Err(error) = self.relocate_completed(&current).await {
                        outcome = Outcome::Failed(error);
                    }
                }
            }
        }
        let completed_file_size = if matches!(outcome, Outcome::Completed) {
            self.task(&id).await.ok().and_then(|current| Some(PathBuf::from(current.dest)))
        } else {
            None
        };
        if let Some(path) = completed_file_size {
            if let Ok(metadata) = tokio::fs::metadata(path).await {
                let size = metadata.len();
                let _ = self.mutate(&id, |current| {
                    current.received = size;
                    current.total = Some(size);
                }).await;
            }
        } else if let Ok(current) = self.task(&id).await {
            if let Ok(metadata) = tokio::fs::metadata(current.part_path()).await {
                let size = metadata.len();
                let _ = self.mutate(&id, |task| task.received = size).await;
            }
        }
        let (status, error) = match outcome {
            Outcome::Completed => (TaskStatus::Completed, None),
            Outcome::Paused => (TaskStatus::Paused, None),
            Outcome::Canceled => (TaskStatus::Canceled, None),
            Outcome::Stalled => (TaskStatus::Stalled, Some("No data was received before the stall timeout.".to_string())),
            Outcome::Failed(message) => (TaskStatus::Failed, Some(message)),
        };
        if let Ok(updated) = self.set_status(&id, status, error).await {
            if status == TaskStatus::Completed {
                self.inner.sink.task_completed(&updated);
            }
        }
        self.finish_active(&id);
        if !self.inner.stopping.load(Ordering::Acquire) {
            self.inner.queue_notify.notify_one();
        }
    }

    fn finish_active(&self, id: &str) {
        if let Ok(mut active) = self.inner.active.lock() {
            active.remove(id);
        }
        if let Ok(mut controls) = self.inner.controls.lock() {
            controls.remove(id);
        }
        if let Ok(mut progress) = self.inner.progress.lock() {
            progress.remove(id);
        }
    }

    async fn download_http(&self, task: &Task, control: &Control) -> Outcome {
        let settings = self.inner.settings.read().await.clone();
        let mut builder = Client::builder();
        if settings.connect_timeout_secs > 0 {
            builder = builder.connect_timeout(Duration::from_secs(settings.connect_timeout_secs));
        }
        builder = builder.no_proxy();
        if let Some(proxy_url) = settings.proxy_url.as_deref().filter(|value| !value.trim().is_empty()) {
            match reqwest::Proxy::all(proxy_url) {
                Ok(proxy) => builder = builder.proxy(proxy),
                Err(error) => return Outcome::Failed(format!("The configured proxy URL is invalid: {error}")),
            }
        }
        let client = match builder.build() {
            Ok(client) => client,
            Err(error) => return Outcome::Failed(format!("Could not configure the HTTP client: {error}")),
        };
        let part = task.part_path();
        let meta_path = task.meta_path();
        let destination = PathBuf::from(&task.dest);
        let mut offset = tokio::fs::metadata(&part).await.map(|metadata| metadata.len()).unwrap_or(0);
        let mut request_headers = reqwest::header::HeaderMap::new();
        for (name, value) in &task.headers {
            let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.as_bytes()), HeaderValue::from_str(value)) else {
                continue;
            };
            request_headers.insert(name, value);
        }
        let has_resume_plan = tokio::fs::try_exists(&meta_path).await.unwrap_or(false);
        let mut range_total = None;
        let mut ranges_supported = false;
        if settings.connections > 1 || has_resume_plan {
            if let Ok(response) = client.get(&task.url)
                .headers(request_headers.clone())
                .header(RANGE, "bytes=0-0")
                .send()
                .await
            {
                if response.status().as_u16() == 206 {
                    if let Some((0, Some(total))) = response.headers().get(CONTENT_RANGE)
                        .and_then(|value| value.to_str().ok())
                        .and_then(parse_content_range)
                    {
                        ranges_supported = total > 0;
                        range_total = Some(total);
                    }
                }
            }
        }
        let use_segments = settings.connections > 1
            && ranges_supported
            && range_total.is_some_and(|total| total >= settings.min_split_size);
        if has_resume_plan && !use_segments {
            if let Err(error) = tokio::fs::remove_file(&part).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Outcome::Failed(format!("Could not discard an incompatible segmented partial: {error}"));
                }
            }
            if let Err(error) = tokio::fs::remove_file(&meta_path).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Outcome::Failed(format!("Could not discard an incompatible segmented resume plan: {error}"));
                }
            }
            offset = 0;
        }
        if use_segments {
            let total = range_total.unwrap_or_default();
            let _ = self.set_status(&task.id, TaskStatus::Downloading, None).await;
            let weak = Arc::downgrade(&self.inner);
            let task_id = task.id.clone();
            // Segmented workers all push into the same running total, so one
            // sampler over `received` yields the combined throughput.
            let sampler = Arc::new(Mutex::new(SpeedSampler::new()));
            let progress = Arc::new(move |received: u64, total: Option<u64>| {
                let speed = sampler
                    .lock()
                    .map(|mut sampler| sampler.sample(received))
                    .unwrap_or(0);
                if let Some(inner) = weak.upgrade() {
                    if let Ok(mut items) = inner.progress.lock() {
                        items.insert(task_id.clone(), TaskProgress {
                            id: task_id.clone(),
                            received,
                            total,
                            speed,
                            status: TaskStatus::Downloading,
                        });
                    }
                    inner.progress_notify.notify_one();
                }
            });
            let transfer = crate::segmented::download(
                &client,
                &task.url,
                &request_headers,
                &part,
                &destination,
                &meta_path,
                total,
                settings.connections,
                settings.min_split_size,
                Duration::from_secs(settings.stall_timeout_secs),
                control,
                progress,
            ).await;
            let outcome = transfer.outcome;
            let received = transfer.received;
            if let Err(error) = self.mutate(&task.id, |current| {
                current.received = received;
                current.total = Some(total);
                current.backend = Some("embedded".into());
            }).await {
                return Outcome::Failed(error.to_string());
            }
            return outcome;
        }
        let mut request = client.get(&task.url).headers(request_headers);
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => return Outcome::Failed(friendly_http_error(&error)),
        };
        let status = response.status();
        if status.as_u16() == 416 && offset > 0 {
            let total = response.headers().get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_unsatisfied_total);
            if total == Some(offset) {
                return self.finalize(&part, &destination).await;
            }
            return Outcome::Failed("The server rejected the resume offset; retry the download to restart it.".to_string());
        }
        if !status.is_success() {
            return Outcome::Failed(format!("The server returned HTTP {status}."));
        }
        let resuming = status.as_u16() == 206 && offset > 0;
        let total = if resuming {
            let Some((range_start, total)) = response.headers().get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_content_range)
            else {
                return Outcome::Failed("The server returned an invalid Content-Range header.".to_string());
            };
            if range_start != offset {
                return Outcome::Failed("The server resumed from an unexpected byte offset.".to_string());
            }
            total
        } else {
            response.content_length()
        };
        let mut options = tokio::fs::OpenOptions::new();
        options.create(true).write(true);
        if resuming {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let mut file = match options.open(&part).await {
            Ok(file) => file,
            Err(error) => return Outcome::Failed(format!("Could not open the partial file: {error}")),
        };
        let received_start = if resuming { offset } else { 0 };
        let mut received = received_start;
        let mut stream = response.bytes_stream();
        let mut last_byte = Instant::now();
        let mut last_persist = Instant::now();
        let mut last_progress = Instant::now() - Duration::from_secs(1);
        let mut sampler = SpeedSampler::new();
        self.record_progress(task, received, total, 0, TaskStatus::Downloading).await;
        let _ = self.set_status(&task.id, TaskStatus::Downloading, None).await;
        loop {
            match control.signal() {
                ControlSignal::Pause => {
                    let _ = file.flush().await;
                    return Outcome::Paused;
                }
                ControlSignal::Cancel => {
                    let _ = file.flush().await;
                    return Outcome::Canceled;
                }
                ControlSignal::Run => {}
            }
            let chunk = match tokio::time::timeout(Duration::from_secs(1), stream.next()).await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => {
                    if settings.stall_timeout_secs > 0
                        && last_byte.elapsed() >= Duration::from_secs(settings.stall_timeout_secs)
                    {
                        let _ = file.flush().await;
                        return Outcome::Stalled;
                    }
                    continue;
                }
            };
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = file.flush().await;
                    return Outcome::Failed(friendly_http_error(&error));
                }
            };
            if let Err(error) = file.write_all(&bytes).await {
                return Outcome::Failed(format!("Could not write the partial file: {error}"));
            }
            received = received.saturating_add(bytes.len() as u64);
            last_byte = Instant::now();
            let speed = sampler.sample(received);
            self.record_progress(task, received, total, speed, TaskStatus::Downloading).await;
            if last_progress.elapsed() >= Duration::from_millis(200) {
                self.inner.progress_notify.notify_one();
                last_progress = Instant::now();
            }
            if last_persist.elapsed() >= Duration::from_secs(1) {
                if let Ok(updated) = self.mutate(&task.id, |current| {
                    current.received = received;
                    current.total = total;
                    current.backend = Some("embedded".into());
                }).await {
                    let _ = updated;
                }
                last_persist = Instant::now();
            }
        }
        if let Err(error) = file.flush().await {
            return Outcome::Failed(format!("Could not flush the partial file: {error}"));
        }
        drop(file);
        if total.is_some_and(|expected| expected != received) {
            return Outcome::Failed(format!("The connection ended after {received} of {} bytes.", total.unwrap_or_default()));
        }
        if control.signal() == ControlSignal::Pause {
            return Outcome::Paused;
        }
        if control.signal() == ControlSignal::Cancel {
            return Outcome::Canceled;
        }
        self.finalize(&part, &destination).await
    }

    async fn relocate_completed(&self, task: &Task) -> Result<(), String> {
        let Some(final_dir) = task.final_dir.as_deref() else {
            return Ok(());
        };
        let folder = PathBuf::from(final_dir);
        tokio::fs::create_dir_all(&folder).await.map_err(|error| format!("Could not create the category destination directory: {error}"))?;
        let target = self.unique_destination(&folder, &task.filename).await.map_err(|error| error.to_string())?;
        let source = PathBuf::from(&task.dest);
        match tokio::fs::rename(&source, &target).await {
            Ok(()) => {}
            Err(rename_error) => {
                tokio::fs::copy(&source, &target).await.map_err(|copy_error| {
                    format!("Could not move the completed file ({rename_error}); cross-volume copy failed: {copy_error}")
                })?;
                if let Err(remove_error) = tokio::fs::remove_file(&source).await {
                    let _ = tokio::fs::remove_file(&target).await;
                    return Err(format!("The completed file was copied but its staging copy could not be removed: {remove_error}"));
                }
            }
        }
        let target_name = target.file_name().and_then(|name| name.to_str()).unwrap_or(&task.filename).to_string();
        self.mutate(&task.id, |current| {
            current.dest = target.to_string_lossy().into_owned();
            current.filename = target_name;
            current.final_dir = None;
        }).await.map_err(|error| error.to_string())?;
        Ok(())
    }

    async fn finalize(&self, part: &str, destination: &Path) -> Outcome {
        if tokio::fs::try_exists(destination).await.unwrap_or(true) {
            return Outcome::Failed("The destination file already exists; it was not overwritten.".to_string());
        }
        if let Some(parent) = destination.parent() {
            if let Err(error) = tokio::fs::create_dir_all(parent).await {
                return Outcome::Failed(format!("Could not create the destination directory: {error}"));
            }
        }
        match tokio::fs::rename(part, destination).await {
            Ok(()) => Outcome::Completed,
            Err(error) => Outcome::Failed(format!("Could not finalize the download: {error}")),
        }
    }

    async fn record_progress(&self, task: &Task, received: u64, total: Option<u64>, speed: u64, status: TaskStatus) {
        let mut tasks = self.inner.tasks.write().await;
        if let Some(current) = tasks.get_mut(&task.id) {
            current.received = received;
            current.total = total;
            current.status = status;
        }
        drop(tasks);
        if let Ok(mut progress) = self.inner.progress.lock() {
            progress.insert(task.id.clone(), TaskProgress {
                id: task.id.clone(), received, total, speed, status,
            });
        }
    }

    async fn flush_progress(&self) {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                _ = interval.tick() => {},
                _ = self.inner.progress_notify.notified() => {},
            }
            self.flush_progress_once();
            if self.inner.stopping.load(Ordering::Acquire)
                && self.inner.active.lock().map(|active| active.is_empty()).unwrap_or(true)
            {
                self.flush_progress_once();
                break;
            }
        }
    }

    fn flush_progress_once(&self) {
        let items = self.inner.progress.lock().map(|mut progress| {
            let mut items: Vec<_> = progress.drain().map(|(_, item)| item).collect();
            items.sort_by(|left, right| left.id.cmp(&right.id));
            items
        }).unwrap_or_default();
        if !items.is_empty() {
            self.inner.sink.task_progress(&items);
        }
    }
}

fn split_extension(filename: &str) -> (&str, &str) {
    match filename.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, extension),
        _ => (filename, ""),
    }
}

fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, _end) = range.split_once('-')?;
    let total = if total == "*" { None } else { total.parse().ok() };
    Some((start.parse().ok()?, total))
}

fn parse_unsatisfied_total(value: &str) -> Option<u64> {
    value.strip_prefix("bytes */")?.parse().ok()
}

fn friendly_http_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "The connection timed out.".to_string()
    } else if error.is_connect() {
        "Could not reach the server.".to_string()
    } else {
        format!("The HTTP request failed: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::{Category, Engine, EventSink};
    use crate::models::{MoinSettings, Task, TaskProgress, TaskStatus};
    use std::sync::Arc;
    use std::time::Duration;

    struct NoopSink;

    impl EventSink for NoopSink {
        fn task_added(&self, _: &Task) {}
        fn task_updated(&self, _: &Task) {}
        fn task_removed(&self, _: &str) {}
        fn task_progress(&self, _: &[TaskProgress]) {}
        fn task_completed(&self, _: &Task) {}
        fn settings_changed(&self, _: &MoinSettings) {}
        fn categories_changed(&self, _: &[Category]) {}
    }

    /// Keeps the highest speed any progress batch carried.
    struct SpeedSink {
        max_speed: std::sync::atomic::AtomicU64,
    }

    impl EventSink for SpeedSink {
        fn task_added(&self, _: &Task) {}
        fn task_updated(&self, _: &Task) {}
        fn task_removed(&self, _: &str) {}
        fn task_progress(&self, items: &[TaskProgress]) {
            for item in items {
                self.max_speed
                    .fetch_max(item.speed, std::sync::atomic::Ordering::Relaxed);
            }
        }
        fn task_completed(&self, _: &Task) {}
        fn settings_changed(&self, _: &MoinSettings) {}
        fn categories_changed(&self, _: &[Category]) {}
    }

    #[tokio::test]
    async fn speed_sampler_primes_then_measures() {
        let mut sampler = super::SpeedSampler::new();
        assert_eq!(sampler.sample(1024), 0, "the first sample only records a baseline");

        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(sampler.sample(1024 + 512 * 1024) > 0, "a window with new bytes reports a rate");

        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(sampler.sample(1024 + 512 * 1024), 0, "a window without bytes reports zero");
    }

    /// The multi-connection path used to hardcode `speed: 0`, which left the
    /// card showing `0 B/s` for every download big enough to be segmented.
    #[tokio::test]
    async fn segmented_download_reports_a_live_speed() {
        let body: Vec<u8> = (0..256 * 1024).map(|value| (value % 251) as u8).collect();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let source = Arc::new(body.clone());
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
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
                    tokio::io::AsyncWriteExt::write_all(&mut socket, header.as_bytes()).await.unwrap();
                    // Trickle the body so the transfer outlives one speed window.
                    for chunk in payload.chunks(4096) {
                        tokio::io::AsyncWriteExt::write_all(&mut socket, chunk).await.unwrap();
                        tokio::time::sleep(Duration::from_millis(80)).await;
                    }
                });
            }
        });

        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let mut settings = MoinSettings::default();
        settings.connections = 4;
        settings.min_split_size = 1;
        std::fs::write(
            data_dir.path().join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        ).unwrap();
        let sink = Arc::new(SpeedSink { max_speed: std::sync::atomic::AtomicU64::new(0) });
        let engine = Engine::open(
            data_dir.path().to_path_buf(),
            download_dir.path().to_path_buf(),
            String::new(),
            sink.clone(),
        ).await.unwrap();
        let task = engine.add_http(
            format!("http://{address}/payload.bin"),
            None,
            None,
            Default::default(),
        ).await.unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let current = engine.list().await.into_iter().find(|item| item.id == task.id).unwrap();
                if matches!(current.status, TaskStatus::Completed | TaskStatus::Failed) {
                    break current;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        server.abort();
        assert_eq!(tokio::fs::read(&task.dest).await.unwrap(), body);
        assert!(
            sink.max_speed.load(std::sync::atomic::Ordering::Relaxed) > 0,
            "a segmented download must report a non-zero speed"
        );
        engine.shutdown().await;
    }

    async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let count = tokio::io::AsyncReadExt::read(socket, &mut chunk).await.unwrap();
            if count == 0 { break; }
            request.extend_from_slice(&chunk[..count]);
            if request.windows(4).any(|window| window == b"\r\n\r\n") { break; }
        }
        String::from_utf8_lossy(&request).to_string()
    }

    #[tokio::test]
    async fn queued_http_download_falls_back_when_range_is_not_supported() {
        let body = b"wingharness download smoke test".to_vec();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let payload = body.clone();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_request(&mut socket).await;
                if request.to_ascii_lowercase().contains("range: bytes=0-0") {
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        payload.len()
                    );
                    tokio::io::AsyncWriteExt::write_all(&mut socket, header.as_bytes()).await.unwrap();
                    tokio::io::AsyncWriteExt::write_all(&mut socket, &payload).await.unwrap();
                } else {
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        payload.len()
                    );
                    tokio::io::AsyncWriteExt::write_all(&mut socket, header.as_bytes()).await.unwrap();
                    tokio::io::AsyncWriteExt::write_all(&mut socket, &payload).await.unwrap();
                }
            }
        });

        let data_dir = tempfile::tempdir().unwrap();
        let download_dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(
            data_dir.path().to_path_buf(),
            download_dir.path().to_path_buf(),
            String::new(),
            Arc::new(NoopSink),
        ).await.unwrap();
        let task = engine.add_http(
            format!("http://{address}/payload.bin"),
            None,
            None,
            Default::default(),
        ).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let current = engine.list().await.into_iter().find(|item| item.id == task.id).unwrap();
                if matches!(current.status, TaskStatus::Completed | TaskStatus::Failed) {
                    break current;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        server.await.unwrap();
        assert_eq!(tokio::fs::read(&task.dest).await.unwrap(), body);
        engine.shutdown().await;
    }
}
