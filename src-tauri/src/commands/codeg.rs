//! The commands the Codeg page and its settings section call.
//!
//! Two groups. The server commands ([`codeg_state`], [`codeg_start`], …) are
//! plain async calls: starting a process and polling it until it answers have
//! nothing to do with the window system. The page commands
//! (`codeg_browser_*`) follow [`crate::commands::plugin_browser`] exactly — each
//! is `async` and every webview call goes through a blocking thread, because on
//! Windows a child webview's operations must run on the main thread and the call
//! that gets them there blocks while it waits.

use tauri::AppHandle;

use crate::codeg::server::{self, CodegView, Status};
use crate::codeg::webview::{self, Theme};
use crate::plugins::browser::Bounds;

/// Runs one webview operation off the main thread.
async fn off_thread<F>(work: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("Codeg task failed: {error}"))?
}

/// The configuration, the server's state, the token and the server's output.
///
/// Read by the settings section (status, token, log) and by the Codeg page
/// (whether it can show anything yet), so one call answers both.
#[tauri::command]
pub fn codeg_state(app: AppHandle) -> CodegView {
    server::view(&app)
}

/// Starts the server and waits until it answers.
#[tauri::command]
pub async fn codeg_start(app: AppHandle) -> Result<Status, String> {
    server::start(app).await
}

/// Stops the server and everything it spawned.
#[tauri::command]
pub fn codeg_stop(app: AppHandle) -> Status {
    server::stop(&app)
}

/// Restarts the server, so a changed path or port takes effect.
#[tauri::command]
pub async fn codeg_restart(app: AppHandle) -> Result<Status, String> {
    server::stop(&app);
    server::start(app).await
}

/// Sets Codeg's own language (`zh_cn` or `en`).
///
/// Codeg keeps the language in its database, not in the page, so this is the
/// only way for the embedded copy to speak the app's language.
#[tauri::command]
pub async fn codeg_set_language(app: AppHandle, language: String) -> Result<(), String> {
    server::set_language(&app, &language).await
}

/// Opens the Codeg page where the caller's placeholder is.
///
/// `host` names the window the page is embedded in, `document` the page load
/// that asked for it and `run` the effect run inside it — the same three-part
/// ownership the plugin browser uses, and for the same two races (see
/// [`crate::codeg::webview`]). `route` is the Codeg route the tab stands for.
#[tauri::command]
pub async fn codeg_browser_open(
    app: AppHandle,
    host: String,
    document: String,
    run: String,
    route: String,
    bounds: Bounds,
    theme: Theme,
) -> Result<(), String> {
    off_thread(move || webview::open(&app, &host, &document, &run, &route, bounds, &theme)).await
}

/// Moves and resizes the page to the caller's placeholder.
#[tauri::command]
pub async fn codeg_browser_set_bounds(
    app: AppHandle,
    host: String,
    bounds: Bounds,
) -> Result<(), String> {
    off_thread(move || webview::set_bounds(&app, &host, bounds)).await
}

/// Shows or hides the page; CSS cannot hide a native view.
#[tauri::command]
pub async fn codeg_browser_set_visible(
    app: AppHandle,
    host: String,
    visible: bool,
) -> Result<(), String> {
    off_thread(move || webview::set_visible(&app, &host, visible)).await
}

/// Navigates the page to another Codeg route.
#[tauri::command]
pub async fn codeg_browser_navigate(
    app: AppHandle,
    host: String,
    route: String,
) -> Result<(), String> {
    off_thread(move || webview::navigate(&app, &host, &route)).await
}

/// Reloads the page.
#[tauri::command]
pub async fn codeg_browser_reload(app: AppHandle, host: String) -> Result<(), String> {
    off_thread(move || webview::reload(&app, &host)).await
}

/// Repaints the page in a new appearance without reloading it.
#[tauri::command]
pub async fn codeg_browser_apply_theme(
    app: AppHandle,
    host: String,
    theme: Theme,
) -> Result<(), String> {
    off_thread(move || webview::apply_theme(&app, &host, &theme)).await
}

/// The address the page is on right now, polled by the tab bar.
#[tauri::command]
pub async fn codeg_browser_url(app: AppHandle, host: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || webview::current_url(&app, &host))
        .await
        .map_err(|error| format!("Codeg task failed: {error}"))?
}

/// Opens the page's own inspector.
#[tauri::command]
pub async fn codeg_browser_devtools(app: AppHandle, host: String) -> Result<(), String> {
    off_thread(move || webview::devtools(&app, &host)).await
}

/// Closes the page, if the calling effect run still owns it.
#[tauri::command]
pub async fn codeg_browser_close(app: AppHandle, host: String, document: String, run: String) {
    let _ = off_thread(move || {
        webview::close(&app, &host, &document, &run);
        Ok(())
    })
    .await;
}

/// Closes the page this document opened in `host`.
#[tauri::command]
pub async fn codeg_browser_close_all(app: AppHandle, host: String, document: String) {
    let _ = off_thread(move || {
        webview::close_all(&app, &host, &document);
        Ok(())
    })
    .await;
}
