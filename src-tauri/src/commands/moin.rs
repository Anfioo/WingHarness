use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use moin_core::{Category, Engine, EventSink, MoinResult, MoinSettings, Task, TaskProgress};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::OnceCell;

pub struct MoinState {
    app: AppHandle,
    data_dir: PathBuf,
    downloads_dir: PathBuf,
    engine: OnceCell<Engine>,
}

impl MoinState {
    pub fn new(app: AppHandle, data_dir: PathBuf, downloads_dir: PathBuf) -> Self {
        Self { app, data_dir, downloads_dir, engine: OnceCell::new() }
    }

    async fn engine(&self) -> MoinResult<Engine> {
        let app = self.app.clone();
        let data_dir = self.data_dir.clone();
        let downloads_dir = self.downloads_dir.clone();
        let proxy_url = crate::config::load().proxy.url;
        let engine = self.engine.get_or_try_init(|| async move {
            Engine::open(data_dir, downloads_dir, proxy_url, Arc::new(TauriEmitter { app })).await
        }).await?;
        Ok(engine.clone())
    }

    pub async fn shutdown(&self) {
        if let Some(engine) = self.engine.get() {
            engine.shutdown().await;
        }
    }
}

struct TauriEmitter { app: AppHandle }

impl EventSink for TauriEmitter {
    fn task_added(&self, task: &Task) { let _ = self.app.emit("moin:task-added", task); }
    fn task_updated(&self, task: &Task) { let _ = self.app.emit("moin:task-updated", task); }
    fn task_removed(&self, id: &str) { let _ = self.app.emit("moin:task-removed", id); }
    fn task_progress(&self, items: &[TaskProgress]) { let _ = self.app.emit("moin:task-progress", items); }
    fn task_completed(&self, task: &Task) { let _ = self.app.emit("moin:task-completed", task); }
    fn settings_changed(&self, settings: &MoinSettings) { let _ = self.app.emit("moin:settings-changed", settings); }
    fn categories_changed(&self, categories: &[Category]) { let _ = self.app.emit("moin:categories-changed", categories); }
}

#[tauri::command]
pub async fn moin_list_downloads(state: State<'_, MoinState>) -> MoinResult<Vec<Task>> {
    Ok(state.engine().await?.list().await)
}

#[tauri::command]
pub async fn moin_add_download(
    state: State<'_, MoinState>,
    url: String,
    filename: Option<String>,
    category: Option<String>,
    headers: Option<BTreeMap<String, String>>,
) -> MoinResult<Task> {
    state.engine().await?.add_http(url, filename, category, headers.unwrap_or_default()).await
}

#[tauri::command]
pub async fn moin_pause_download(state: State<'_, MoinState>, id: String) -> MoinResult<()> {
    state.engine().await?.pause(&id).await
}

#[tauri::command]
pub async fn moin_resume_download(state: State<'_, MoinState>, id: String) -> MoinResult<()> {
    state.engine().await?.resume(&id).await
}

#[tauri::command]
pub async fn moin_cancel_download(state: State<'_, MoinState>, id: String) -> MoinResult<()> {
    state.engine().await?.cancel(&id).await
}

#[tauri::command]
pub async fn moin_remove_download(state: State<'_, MoinState>, id: String) -> MoinResult<()> {
    state.engine().await?.remove(&id).await
}

#[tauri::command]
pub async fn moin_delete_download(state: State<'_, MoinState>, id: String) -> MoinResult<()> {
    state.engine().await?.delete(&id).await
}

#[tauri::command]
pub async fn moin_forget_download(state: State<'_, MoinState>, id: String) -> MoinResult<()> {
    state.engine().await?.forget(&id).await
}

#[tauri::command]
pub async fn moin_list_categories(state: State<'_, MoinState>) -> MoinResult<Vec<Category>> {
    Ok(state.engine().await?.categories().await)
}

#[tauri::command]
pub async fn moin_suggest_category(
    state: State<'_, MoinState>,
    url: String,
    filename: Option<String>,
) -> MoinResult<Option<String>> {
    Ok(state.engine().await?.suggest_category(&url, filename.as_deref()).await)
}

#[tauri::command]
pub async fn moin_create_category(state: State<'_, MoinState>, category: Category) -> MoinResult<Vec<Category>> {
    state.engine().await?.upsert_category(category).await
}

#[tauri::command]
pub async fn moin_update_category(state: State<'_, MoinState>, category: Category) -> MoinResult<Vec<Category>> {
    state.engine().await?.upsert_category(category).await
}

#[tauri::command]
pub async fn moin_delete_category(state: State<'_, MoinState>, id: String) -> MoinResult<Vec<Category>> {
    state.engine().await?.delete_category(&id).await
}

#[tauri::command]
pub async fn moin_reorder_categories(state: State<'_, MoinState>, ids: Vec<String>) -> MoinResult<Vec<Category>> {
    state.engine().await?.reorder_categories(&ids).await
}

#[tauri::command]
pub async fn moin_get_settings(state: State<'_, MoinState>) -> MoinResult<MoinSettings> {
    Ok(state.engine().await?.settings().await)
}

#[tauri::command]
pub async fn moin_patch_settings(
    state: State<'_, MoinState>,
    patch: serde_json::Value,
) -> MoinResult<MoinSettings> {
    state.engine().await?.patch_settings(patch).await
}
