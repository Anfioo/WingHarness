// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Queue, state machine and persistence orchestration.
//!
//! The engine never depends on Tauri: everything it reports goes out through
//! [`Emitter`], and the host (`state.rs`) turns those calls into `app.emit`.
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

use futures_util::StreamExt;
use reqwest::header::{HeaderName, HeaderValue, CONTENT_RANGE, RANGE};
use reqwest::{Client, Url};
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;
use uuid::Uuid;

use crate::backend::{Control, Outcome, Signal};
use crate::category::CategoryStore;
use crate::error::{MoinError, MoinResult};
use crate::models::{
    filename_from_url, now_ms, sanitize_filename, AddMethodKind, BackendInfo, Category, Settings,
    Task, TaskKind, TaskProgress, TaskStatus, ToolSource, ToolStatus,
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
}

/// How often a byte rate is recomputed from the running total.
const SPEED_WINDOW: Duration = Duration::from_millis(500);

fn guard<T>(mutex: &Mutex<T>) -> MoinResult<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| MoinError::internal("A download state lock is poisoned."))
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
        tokio::fs::create_dir_all(&data_dir)
            .await
            .map_err(|error| MoinError::io(format!("Could not create the moin data directory: {error}")))?;
        let store = Store::open(&data_dir)
            .await
            .map_err(|error| MoinError::io(format!("Could not open the downloads database: {error}")))?;
        let category_path = data_dir.join("categories.json");
        let categories = CategoryStore::load(&category_path);
        let mut loaded_settings = settings::load(&data_dir);
        if loaded_settings.validate().is_err() {
            log::warn!("Invalid moin settings were replaced with defaults.");
            loaded_settings = Settings::default();
        }
        if loaded_settings.rpc_token.is_empty() {
            loaded_settings.rpc_token = Uuid::new_v4().to_string();
            settings::save(&data_dir, &loaded_settings)
                .map_err(|error| MoinError::io(format!("Could not save default moin settings: {}", error.message)))?;
        }
        let mut tasks = HashMap::new();
        for mut task in store
            .all()
            .await
            .map_err(|error| MoinError::io(format!("Could not load downloads: {error}")))?
        {
            // A previous run died mid-transfer: fall back to paused instead of
            // silently resuming, so the user stays in control.
            if matches!(
                task.status,
                TaskStatus::Connecting | TaskStatus::Downloading | TaskStatus::Moving
            ) {
                task.status = TaskStatus::Paused;
                task.updated_at = now_ms();
                store.upsert(&task).await.map_err(|error| MoinError::io(error))?;
            }
            tasks.insert(task.id.clone(), task);
        }
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
            right.created_at.cmp(&left.created_at).then_with(|| right.id.cmp(&left.id))
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
        let settings = self.settings();
        let (suggested_category, available_categories) = {
            let categories = guard(&self.inner.categories)?;
            (
                categories.suggest(parsed.as_str(), filename.as_deref(), AddMethodKind::ManualLink, None),
                categories.list(),
            )
        };
        let category_id = category.or(suggested_category);
        if category_id
            .as_ref()
            .is_some_and(|id| !available_categories.iter().any(|item| &item.id == id))
        {
            return Err(MoinError::not_found("category", category_id.as_deref().unwrap_or_default()));
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
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|error| MoinError::io(format!("Could not create the download directory: {error}")))?;
        let requested = filename
            .as_deref()
            .and_then(sanitize_filename)
            .unwrap_or_else(|| {
                sanitize_filename(&filename_from_url(parsed.as_str()))
                    .unwrap_or_else(|| "download".to_string())
            });
        let target = self.unique_destination(&folder, &requested).await?;
        let timestamp = now_ms();
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
            status: if settings.add_paused { TaskStatus::Paused } else { TaskStatus::Queued },
            total: None,
            received: 0,
            error: None,
            created_at: timestamp,
            updated_at: timestamp,
            completed_at: None,
            archived: false,
            active_ms: 0,
            backend: Some("embedded".to_string()),
            category: category_id,
            final_dir,
            headers,
        };
        self.inner.store.upsert(&task).await.map_err(|error| MoinError::io(error))?;
        guard(&self.inner.tasks)?.insert(task.id.clone(), task.clone());
        self.inner.emitter.added(&task);
        if task.status == TaskStatus::Queued {
            self.inner.queue_notify.notify_one();
        }
        Ok(task)
    }

    async fn unique_destination(&self, folder: &Path, filename: &str) -> MoinResult<PathBuf> {
        let mut candidate = folder.join(filename);
        let (stem, extension) = split_extension(filename);
        let occupied_destinations: HashSet<String> = guard(&self.inner.tasks)?
            .values()
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
        for path in [
            PathBuf::from(&task.dest),
            PathBuf::from(task.part_path()),
            PathBuf::from(task.meta_path()),
        ] {
            match tokio::fs::remove_file(path).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(MoinError::io(format!("Could not remove the download file: {error}")))
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
            return Err(MoinError::conflict("Pause or cancel the download before removing its record."));
        }
        self.task(id)?;
        self.inner.store.delete(id).await.map_err(|error| MoinError::io(error))?;
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
            *current = next;
            changed
        };
        if concurrency_changed {
            self.inner.queue_notify.notify_one();
        }
        Ok(())
    }

    /// The backend list the settings page renders. `aria2` stays unavailable
    /// until the aria2c backend is ported; it is listed so the row can explain
    /// itself instead of disappearing.
    pub fn backends(&self) -> Vec<BackendInfo> {
        vec![
            BackendInfo {
                id: "embedded".to_string(),
                label: "Built-in".to_string(),
                http: true,
                available: true,
            },
            BackendInfo {
                id: "aria2".to_string(),
                label: "aria2c".to_string(),
                http: true,
                available: false,
            },
        ]
    }

    pub fn regenerate_rpc_token(&self) -> String {
        let mut next = self.settings();
        next.rpc_token = Uuid::new_v4().to_string();
        if let Err(error) = self.set_settings(next.clone()) {
            log::warn!("Could not persist a new moin RPC token: {error}");
        }
        next.rpc_token
    }

    pub async fn tool_status(&self) -> ToolStatus {
        let settings = self.settings();
        let path = settings.aria2_path.filter(|value| !value.trim().is_empty());
        ToolStatus {
            id: "aria2".to_string(),
            present: false,
            path: path.clone(),
            version: None,
            source: path.map(|_| ToolSource::Override),
        }
    }

    pub async fn set_tool_path(&self, path: Option<String>) -> ToolStatus {
        let mut next = self.settings();
        next.aria2_path = path.filter(|value| !value.trim().is_empty());
        if let Err(error) = self.set_settings(next) {
            log::warn!("Could not persist the aria2 path: {error}");
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
                    task.final_dir = None;
                    task.updated_at = now_ms();
                    task.clone()
                })
                .collect::<Vec<_>>()
        };
        for task in affected {
            self.inner.store.upsert(&task).await.map_err(|error| MoinError::io(error))?;
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

    pub async fn move_to_category(
        &self,
        ids: Vec<String>,
        category: Option<String>,
        _default_dir: PathBuf,
    ) -> MoinResult<()> {
        if let Some(id) = category.as_deref() {
            if guard(&self.inner.categories)?.get(id).is_none() {
                return Err(MoinError::not_found("category", id));
            }
        }
        for id in ids {
            // Files are left where they are: moving a finished download is a
            // separate action the download list offers, not a side effect of
            // re-tagging a record.
            self.mutate(&id, |task| task.category = category.clone()).await?;
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
        let controls: Vec<_> = guard(&self.inner.controls)
            .map(|items| items.values().cloned().collect())
            .unwrap_or_default();
        for control in controls {
            control.set(Signal::Pause);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.has_active_transfers() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
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
        let deadline = Instant::now() + Duration::from_secs(10);
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
        self.inner.store.upsert(&task).await.map_err(|error| MoinError::io(error))?;
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
        let task = match self.task(&id) {
            Ok(task) => task,
            Err(_) => {
                self.finish_active(&id);
                return;
            }
        };
        let mut outcome = self.download_http(&task, &control).await;
        if matches!(outcome, Outcome::Completed) {
            if let Ok(current) = self.task(&id) {
                if current.final_dir.is_some() {
                    let _ = self.set_status(&id, TaskStatus::Moving, None).await;
                    if let Err(error) = self.relocate_completed(&current).await {
                        outcome = Outcome::Failed(error);
                    }
                }
            }
        }
        if matches!(outcome, Outcome::Completed) {
            if let Ok(current) = self.task(&id) {
                if let Ok(metadata) = tokio::fs::metadata(&current.dest).await {
                    let size = metadata.len();
                    let _ = self
                        .mutate(&id, |task| {
                            task.received = size;
                            task.total = Some(size);
                        })
                        .await;
                }
            }
        } else if let Ok(current) = self.task(&id) {
            if let Ok(metadata) = tokio::fs::metadata(current.part_path()).await {
                let size = metadata.len();
                let _ = self.mutate(&id, |task| task.received = size).await;
            }
        }
        let (status, error) = match outcome {
            Outcome::Completed => (TaskStatus::Completed, None),
            Outcome::Paused => (TaskStatus::Paused, None),
            Outcome::Canceled => (TaskStatus::Canceled, None),
            Outcome::Stalled => (
                TaskStatus::Stalled,
                Some("No data was received before the stall timeout.".to_string()),
            ),
            Outcome::Failed(message) => (TaskStatus::Failed, Some(message)),
        };
        if let Ok(updated) = self.set_status(&id, status, error).await {
            if status == TaskStatus::Completed {
                self.inner.emitter.completed(&updated);
            }
        }
        self.finish_active(&id);
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

    async fn download_http(&self, task: &Task, control: &Control) -> Outcome {
        let settings = self.settings();
        let mut builder = Client::builder();
        if settings.connect_timeout_secs > 0 {
            builder = builder.connect_timeout(Duration::from_secs(settings.connect_timeout_secs));
        }
        let client = match builder.build() {
            Ok(client) => client,
            Err(error) => return Outcome::Failed(format!("Could not configure the HTTP client: {error}")),
        };
        let part = task.part_path();
        let meta_path = task.meta_path();
        let destination = PathBuf::from(&task.dest);
        let mut offset = tokio::fs::metadata(&part)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let mut request_headers = reqwest::header::HeaderMap::new();
        for (name, value) in &task.headers {
            let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) else {
                continue;
            };
            request_headers.insert(name, value);
        }
        let has_resume_plan = tokio::fs::try_exists(&meta_path).await.unwrap_or(false);
        let mut range_total = None;
        let mut ranges_supported = false;
        if settings.connections > 1 || has_resume_plan {
            if let Ok(response) = client
                .get(&task.url)
                .headers(request_headers.clone())
                .header(RANGE, "bytes=0-0")
                .send()
                .await
            {
                if response.status().as_u16() == 206 {
                    if let Some((0, Some(total))) = response
                        .headers()
                        .get(CONTENT_RANGE)
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
                    return Outcome::Failed(format!(
                        "Could not discard an incompatible segmented partial: {error}"
                    ));
                }
            }
            if let Err(error) = tokio::fs::remove_file(&meta_path).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Outcome::Failed(format!(
                        "Could not discard an incompatible segmented resume plan: {error}"
                    ));
                }
            }
            offset = 0;
        }
        if use_segments {
            let total = range_total.unwrap_or_default();
            let _ = self.set_status(&task.id, TaskStatus::Downloading, None).await;
            let task_id = task.id.clone();
            let emitter = self.inner.emitter.clone();
            // Segmented workers all push into the same running total, so one
            // sampler over `received` yields the combined throughput.
            let sampler = Arc::new(Mutex::new(SpeedSampler::new()));
            let progress = Arc::new(move |received: u64, total: Option<u64>| {
                let speed = sampler
                    .lock()
                    .map(|mut sampler| sampler.sample(received))
                    .unwrap_or(0);
                emitter.progress(TaskProgress {
                    id: task_id.clone(),
                    received,
                    total,
                    speed,
                    status: TaskStatus::Downloading,
                });
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
            )
            .await;
            let outcome = transfer.outcome;
            let received = transfer.received;
            if let Err(error) = self
                .mutate(&task.id, |current| {
                    current.received = received;
                    current.total = Some(total);
                    current.backend = Some("embedded".to_string());
                })
                .await
            {
                return Outcome::Failed(error.message);
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
            let total = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_unsatisfied_total);
            if total == Some(offset) {
                return self.finalize(&part, &destination).await;
            }
            return Outcome::Failed(
                "The server rejected the resume offset; retry the download to restart it.".to_string(),
            );
        }
        if !status.is_success() {
            return Outcome::Failed(format!("The server returned HTTP {status}."));
        }
        let resuming = status.as_u16() == 206 && offset > 0;
        let total = if resuming {
            let Some((range_start, total)) = response
                .headers()
                .get(CONTENT_RANGE)
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
        let mut sampler = SpeedSampler::new();
        self.record_progress(task, received, total, 0, TaskStatus::Downloading);
        let _ = self.set_status(&task.id, TaskStatus::Downloading, None).await;
        loop {
            match control.signal() {
                Signal::Pause => {
                    let _ = file.flush().await;
                    return Outcome::Paused;
                }
                Signal::Cancel => {
                    let _ = file.flush().await;
                    return Outcome::Canceled;
                }
                Signal::Run => {}
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
            self.record_progress(task, received, total, speed, TaskStatus::Downloading);
            if last_persist.elapsed() >= Duration::from_secs(1) {
                let _ = self
                    .mutate(&task.id, |current| {
                        current.received = received;
                        current.total = total;
                        current.backend = Some("embedded".to_string());
                    })
                    .await;
                last_persist = Instant::now();
            }
        }
        if let Err(error) = file.flush().await {
            return Outcome::Failed(format!("Could not flush the partial file: {error}"));
        }
        drop(file);
        if total.is_some_and(|expected| expected != received) {
            return Outcome::Failed(format!(
                "The connection ended after {received} of {} bytes.",
                total.unwrap_or_default()
            ));
        }
        if control.signal() == Signal::Pause {
            return Outcome::Paused;
        }
        if control.signal() == Signal::Cancel {
            return Outcome::Canceled;
        }
        self.finalize(&part, &destination).await
    }

    async fn relocate_completed(&self, task: &Task) -> Result<(), String> {
        let Some(final_dir) = task.final_dir.as_deref() else {
            return Ok(());
        };
        let folder = PathBuf::from(final_dir);
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|error| format!("Could not create the category destination directory: {error}"))?;
        let target = self
            .unique_destination(&folder, &task.filename)
            .await
            .map_err(|error| error.message)?;
        let source = PathBuf::from(&task.dest);
        match tokio::fs::rename(&source, &target).await {
            Ok(()) => {}
            Err(rename_error) => {
                tokio::fs::copy(&source, &target).await.map_err(|copy_error| {
                    format!(
                        "Could not move the completed file ({rename_error}); cross-volume copy failed: {copy_error}"
                    )
                })?;
                if let Err(remove_error) = tokio::fs::remove_file(&source).await {
                    let _ = tokio::fs::remove_file(&target).await;
                    return Err(format!(
                        "The completed file was copied but its staging copy could not be removed: {remove_error}"
                    ));
                }
            }
        }
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

    /// Update the in-memory task and hand the reading to the host. The host
    /// batches these, so this stays cheap enough for a per-chunk call.
    fn record_progress(
        &self,
        task: &Task,
        received: u64,
        total: Option<u64>,
        speed: u64,
        status: TaskStatus,
    ) {
        if let Ok(mut tasks) = guard(&self.inner.tasks) {
            if let Some(current) = tasks.get_mut(&task.id) {
                current.received = received;
                current.total = total;
                current.status = status;
            }
        }
        self.inner.emitter.progress(TaskProgress {
            id: task.id.clone(),
            received,
            total,
            speed,
            status,
        });
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
    use super::{Engine, Emitter};
    use crate::models::{Settings, Task, TaskProgress, TaskStatus};
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

    #[tokio::test]
    async fn speed_sampler_primes_then_measures() {
        let mut sampler = super::SpeedSampler::new();
        assert_eq!(sampler.sample(1024), 0, "the first sample only records a baseline");

        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(sampler.sample(1024 + 512 * 1024) > 0, "a window with new bytes reports a rate");

        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(sampler.sample(1024 + 512 * 1024), 0, "a window without bytes reports zero");
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
        assert!(engine.backends().iter().any(|backend| backend.id == "embedded"));
        assert_eq!(engine.settings().max_concurrent, Settings::default().max_concurrent);
        engine.shutdown().await;
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
        let mut settings = Settings::default();
        settings.connections = 4;
        settings.min_split_size = 1;
        std::fs::write(
            data_dir.path().join("settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        let sink = Arc::new(SpeedSink { max_speed: AtomicU64::new(0) });
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
                let current = engine.list().into_iter().find(|item| item.id == task.id).unwrap();
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

    async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            let count = tokio::io::AsyncReadExt::read(socket, &mut chunk).await.unwrap();
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
    async fn queued_http_download_falls_back_when_range_is_not_supported() {
        let body = b"wingharness download smoke test".to_vec();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
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
                tokio::io::AsyncWriteExt::write_all(&mut socket, header.as_bytes()).await.unwrap();
                tokio::io::AsyncWriteExt::write_all(&mut socket, &payload).await.unwrap();
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
                let current = engine.list().into_iter().find(|item| item.id == task.id).unwrap();
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
