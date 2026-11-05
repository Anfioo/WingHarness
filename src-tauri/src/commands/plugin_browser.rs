//! The embedded browser the plugin page drives.
//!
//! The pane is a native webview rather than an iframe (see
//! [`crate::plugins::browser`] for why), so the frontend positions it, navigates
//! it and reads its address through these commands. They are thin: each one
//! resolves the plugin, then calls the module that owns the webview.
//!
//! **Every command here is `async`, and every webview call goes through a
//! blocking thread.** On Windows a panel's operations must run on the main
//! thread, and the call that gets them there blocks while it waits — which a
//! synchronous command cannot survive, because it *is* the main thread
//! (`WebviewBuilder::new`, referencing wry#583). Keeping the whole surface
//! async is the difference between "the page appears" and "nothing happens".

use tauri::AppHandle;

use crate::plugins::browser::{self, Bounds, Direction};
use crate::plugins::registry;

/// Runs one webview operation off the main thread.
///
/// `work` returns the error string the command hands back to the frontend.
async fn off_thread<F>(work: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("Browser task failed: {error}"))?
}

/// Opens a plugin's page where the caller's placeholder is.
///
/// The address comes from the manifest's `ui` unless the caller overrides it,
/// and the plugin has to be enabled — the same gate as starting it. `host` names
/// the window the page is embedded in; `document` identifies the page load that
/// asked for it, so a page replaced by a navigation cannot take the new one's
/// pages down with it (see [`crate::plugins::browser`]).
#[tauri::command]
pub async fn plugins_browser_open(
    app: AppHandle,
    host: String,
    document: String,
    id: String,
    url: Option<String>,
    bounds: Bounds,
) -> Result<(), String> {
    if !registry::is_enabled(&id) {
        return Err(format!("Plugin '{id}' is turned off."));
    }

    let address = match url {
        // An explicit address (a typed one, or a tab restoring a route).
        Some(url) if !url.trim().is_empty() => Some(url),
        // Otherwise the manifest's own `ui`, resolved the same way the tab bar
        // resolved it, so the tab and the pane always agree.
        _ => registry::ui_of(&id)?,
    }
    .ok_or_else(|| format!("Plugin '{id}' has no page to open."))?;

    off_thread(move || browser::open(&app, &host, &document, &id, &address, bounds)).await
}

/// Moves and resizes a plugin's page to the caller's placeholder.
#[tauri::command]
pub async fn plugins_browser_set_bounds(
    app: AppHandle,
    host: String,
    id: String,
    bounds: Bounds,
) -> Result<(), String> {
    off_thread(move || browser::set_bounds(&app, &host, &id, bounds)).await
}

/// Shows or hides a plugin's page, for a tab that is or is not the active one.
#[tauri::command]
pub async fn plugins_browser_set_visible(
    app: AppHandle,
    host: String,
    id: String,
    visible: bool,
) -> Result<(), String> {
    off_thread(move || browser::set_visible(&app, &host, &id, visible)).await
}

/// Navigates a plugin's page to another address on its own site.
#[tauri::command]
pub async fn plugins_browser_navigate(
    app: AppHandle,
    host: String,
    id: String,
    url: String,
) -> Result<(), String> {
    off_thread(move || browser::navigate(&app, &host, &id, &url)).await
}

/// Walks a plugin's page back through its history.
#[tauri::command]
pub async fn plugins_browser_back(app: AppHandle, host: String, id: String) -> Result<(), String> {
    off_thread(move || browser::history(&app, &host, &id, Direction::Back)).await
}

/// Walks a plugin's page forward through its history.
#[tauri::command]
pub async fn plugins_browser_forward(
    app: AppHandle,
    host: String,
    id: String,
) -> Result<(), String> {
    off_thread(move || browser::history(&app, &host, &id, Direction::Forward)).await
}

/// Reloads a plugin's page.
#[tauri::command]
pub async fn plugins_browser_reload(
    app: AppHandle,
    host: String,
    id: String,
) -> Result<(), String> {
    off_thread(move || browser::reload(&app, &host, &id)).await
}

/// The address a plugin's page is on right now.
///
/// Polled by the frontend, because a client-side route change does not tell the
/// host it happened.
#[tauri::command]
pub async fn plugins_browser_url(
    app: AppHandle,
    host: String,
    id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || browser::current_url(&app, &host, &id))
        .await
        .map_err(|error| format!("Browser task failed: {error}"))?
}

/// Closes one plugin's page, if the calling document owns it.
#[tauri::command]
pub async fn plugins_browser_close(app: AppHandle, host: String, document: String, id: String) {
    let _ = off_thread(move || {
        browser::close(&app, &host, &document, &id);
        Ok(())
    })
    .await;
}

/// Closes every plugin page in `host` that the calling document owns.
///
/// Called as the plugin page is left or reloaded: the pages belong to the
/// window, so nothing else would take them down. Scoped to the document, so a
/// call from a page being replaced cannot close the pages of the page that
/// replaced it.
#[tauri::command]
pub async fn plugins_browser_close_all(app: AppHandle, host: String, document: String) {
    let _ = off_thread(move || {
        browser::close_all(&app, &host, &document);
        Ok(())
    })
    .await;
}
