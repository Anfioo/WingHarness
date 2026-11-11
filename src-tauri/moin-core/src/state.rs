// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Host glue: the Tauri-managed state, the `Emitter` implementation and the one
//! global progress batcher.
//!
//! The engine reports on every chunk; emitting an IPC event that often would
//! flood the webview. `TauriEmitter::progress` therefore only drops the reading
//! into a map and wakes the flusher, which drains it at most once per
//! `settings.progress_flush_interval()` and skips readings it already sent.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter as TauriEmitterTrait, Manager};
use tokio::sync::{Notify, OnceCell};

use crate::engine::{Emitter, Engine};
use crate::error::MoinResult;
use crate::events;
use crate::models::{Category, Settings, Task, TaskProgress};
use crate::paths;

/// Flush cadence mirror of `Settings::progress_flush_ms`, readable from the
/// flusher task without touching the engine's locks.
static FLUSH_INTERVAL_MS: AtomicU64 = AtomicU64::new(250);

/// Mirrors `Settings::notify_on_complete` for the completion notification.
static NOTIFY_ON_COMPLETE: AtomicBool = AtomicBool::new(true);

struct ProgressBatch {
    flush: Arc<Mutex<HashMap<String, TaskProgress>>>,
    notify: Arc<Notify>,
}

fn progress_batch() -> &'static ProgressBatch {
    static BATCH: OnceLock<ProgressBatch> = OnceLock::new();
    BATCH.get_or_init(|| ProgressBatch {
        flush: Arc::new(Mutex::new(HashMap::new())),
        notify: Arc::new(Notify::new()),
    })
}

/// Handles for the single flusher task. `setup` passes them to
/// [`spawn_progress_flusher`]; the emitter writes through the same pair.
pub fn progress_handles() -> (Arc<Mutex<HashMap<String, TaskProgress>>>, Arc<Notify>) {
    let batch = progress_batch();
    (batch.flush.clone(), batch.notify.clone())
}

/// Keep the batcher in step with the settings the engine just loaded or saved.
pub fn apply_settings(settings: &Settings) {
    FLUSH_INTERVAL_MS.store(
        settings.progress_flush_interval().as_millis() as u64,
        Ordering::Relaxed,
    );
    NOTIFY_ON_COMPLETE.store(settings.notify_on_complete, Ordering::Relaxed);
}

/// Cheap to clone, and every clone shares one engine.
///
/// The browser-extension listener (`rpc::serve`) needs its own handle, and a
/// second `OnceCell` would open a second SQLite pool on the same file, so the
/// cell itself lives behind an `Arc`.
#[derive(Clone)]
pub struct MoinState {
    pub app: AppHandle,
    pub downloads_dir: PathBuf,
    engine: Arc<OnceCell<Engine>>,
}

impl MoinState {
    pub fn new(app: AppHandle) -> Self {
        let downloads_dir = app
            .path()
            .download_dir()
            .unwrap_or_else(|_| std::env::temp_dir());
        Self {
            app,
            downloads_dir,
            engine: Arc::new(OnceCell::new()),
        }
    }

    /// Rebuild the download client after the app's proxy settings changed.
    pub async fn refresh_network(&self) -> MoinResult<()> {
        self.engine().await?.refresh_network();
        Ok(())
    }

    /// Build the engine on first use and cache it. A `OnceCell` (not a plain
    /// flag) is what stops two concurrent first calls from opening two SQLite
    /// pools on the same file.
    pub async fn engine(&self) -> MoinResult<Engine> {
        let data_dir = paths::ensure_dir()?;
        let emitter: Arc<dyn Emitter> = Arc::new(TauriEmitter { app: self.app.clone() });
        let downloads_dir = self.downloads_dir.clone();
        let engine = self
            .engine
            .get_or_try_init(|| async move {
                Engine::new(data_dir, emitter, downloads_dir).await
            })
            .await?;
        apply_settings(&engine.settings());
        Ok(engine.clone())
    }

    pub fn has_active_transfers(&self) -> bool {
        self.engine
            .get()
            .map(|engine| engine.has_active_transfers())
            .unwrap_or(false)
    }
}

pub struct TauriEmitter {
    app: AppHandle,
}

impl Emitter for TauriEmitter {
    fn added(&self, task: &Task) {
        emit_task_added(&self.app, task);
    }

    fn progress(&self, progress: TaskProgress) {
        let batch = progress_batch();
        if let Ok(mut flush) = batch.flush.lock() {
            flush.insert(progress.id.clone(), progress);
        }
        batch.notify.notify_one();
    }

    fn updated(&self, task: &Task) {
        emit_task_updated(&self.app, task);
    }

    fn removed(&self, id: &str) {
        emit_task_removed(&self.app, id);
    }

    fn completed(&self, task: &Task) {
        emit_task_completed(&self.app, task);
        if NOTIFY_ON_COMPLETE.load(Ordering::Relaxed) {
            // The title is the app name and the body is the file name, so the
            // notification carries no untranslated prose.
            let title = self.app.package_info().name.clone();
            if let Err(error) = tauri_plugin_notification::NotificationExt::notification(&self.app)
                .builder()
                .title(title)
                .body(task.filename.clone())
                .show()
            {
                log::warn!("Could not show the download notification: {error}");
            }
        }
    }
}

pub fn emit_task_added(app: &AppHandle, task: &Task) {
    let _ = app.emit(events::TASK_ADDED, task);
}

pub fn emit_task_updated(app: &AppHandle, task: &Task) {
    let _ = app.emit(events::TASK_UPDATED, task);
}

pub fn emit_task_removed(app: &AppHandle, id: &str) {
    let _ = app.emit(events::TASK_REMOVED, id);
}

pub fn emit_task_progress(app: &AppHandle, items: &[TaskProgress]) {
    let _ = app.emit(events::TASK_PROGRESS, items);
}

pub fn emit_task_completed(app: &AppHandle, task: &Task) {
    let _ = app.emit(events::TASK_COMPLETED, task);
}

pub fn emit_settings_changed(app: &AppHandle, settings: &Settings) {
    let _ = app.emit(events::SETTINGS_CHANGED, settings);
}

pub fn emit_categories_changed(app: &AppHandle, list: &[Category]) {
    let _ = app.emit(events::CATEGORIES_CHANGED, list);
}

/// The single global progress flusher. Starting a second one per page would
/// double the IPC traffic, so the page never spawns its own.
pub fn spawn_progress_flusher(
    app: AppHandle,
    flush: Arc<Mutex<HashMap<String, TaskProgress>>>,
    notify: Arc<Notify>,
) {
    tauri::async_runtime::spawn(async move {
        let mut last: HashMap<String, TaskProgress> = HashMap::new();
        loop {
            let interval = Duration::from_millis(FLUSH_INTERVAL_MS.load(Ordering::Relaxed).max(50));
            tokio::select! {
                _ = notify.notified() => {}
                _ = tokio::time::sleep(interval) => {}
            }
            let drained: Vec<TaskProgress> = match flush.lock() {
                Ok(mut items) => items.drain().map(|(_, progress)| progress).collect(),
                Err(_) => continue,
            };
            let mut batch: Vec<TaskProgress> = Vec::new();
            for progress in drained {
                // A reading identical to the one already sent carries nothing.
                if last.get(&progress.id) != Some(&progress) {
                    last.insert(progress.id.clone(), progress.clone());
                    batch.push(progress);
                }
            }
            if batch.is_empty() {
                continue;
            }
            batch.sort_by(|left, right| left.id.cmp(&right.id));
            emit_task_progress(&app, &batch);
        }
    });
}

/// Called from `RunEvent::Exit`: stop the transfers and give the active workers
/// a moment to flush their partial files.
pub fn shutdown(state: &MoinState) {
    let Some(engine) = state.engine.get().cloned() else {
        return;
    };
    tauri::async_runtime::block_on(engine.shutdown());
}
