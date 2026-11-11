use std::sync::Mutex;

use futures_util::{
    future::{select, Either},
    pin_mut,
};
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::watch;
use url::Url;

/// Emitted with the endpoint label before each endpoint is tried, and with
/// `null` once the check is over. The About and update windows show it while
/// they spin.
const CHECKING_EVENT: &str = "updater:checking";

#[derive(Default)]
pub struct UpdateDownloadState {
    cancel: Mutex<Option<watch::Sender<bool>>>,
    /// The update the last successful check settled on. Installing uses it
    /// directly, so the download and signature come from the endpoint that
    /// answered rather than from a second round of endpoint probing.
    update: Mutex<Option<Update>>,
}

/// What the frontend needs to render the prompt; the installer keeps the
/// `Update` object itself on the backend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckView {
    pub version: String,
    pub current_version: String,
    pub date: Option<String>,
    pub body: Option<String>,
    /// `GitHub`, `Cloudflare`, `Gitee`, or the endpoint's host when unknown.
    pub endpoint: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum UpdateProgressEvent {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
    },
    Finished,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateInstallResult {
    Installed,
    Cancelled,
    UpToDate,
}

async fn run_update(
    app: &AppHandle,
    stored: Option<Update>,
    on_progress: Channel<UpdateProgressEvent>,
    mut cancel: watch::Receiver<bool>,
) -> Result<UpdateInstallResult, String> {
    let update = match stored {
        Some(update) => Some(update),
        None => {
            // The prompt can outlive the check that opened it (or the check may
            // have failed to persist one), so fall back to the plugin's own
            // endpoint sweep.
            let updater = app.updater().map_err(|error| error.to_string())?;
            let cancelled = cancel.changed();
            let check = updater.check();
            pin_mut!(cancelled, check);
            match select(cancelled, check).await {
                Either::Left(_) => return Ok(UpdateInstallResult::Cancelled),
                Either::Right((result, _)) => result.map_err(|error| error.to_string())?,
            }
        }
    };

    let Some(update) = update else {
        return Ok(UpdateInstallResult::UpToDate);
    };

    let mut started = false;
    let download = update.download(
        |chunk_length, content_length| {
            if !started {
                started = true;
                let _ = on_progress.send(UpdateProgressEvent::Started { content_length });
            }
            let _ = on_progress.send(UpdateProgressEvent::Progress { chunk_length });
        },
        || {
            let _ = on_progress.send(UpdateProgressEvent::Finished);
        },
    );
    tokio::pin!(download);

    let bytes = {
        let cancelled = cancel.changed();
        pin_mut!(cancelled, download);
        match select(cancelled, download).await {
            Either::Left(_) => return Ok(UpdateInstallResult::Cancelled),
            Either::Right((result, _)) => result.map_err(|error| error.to_string())?,
        }
    };

    update.install(bytes).map_err(|error| error.to_string())?;
    Ok(UpdateInstallResult::Installed)
}

/// Check the endpoints one at a time, in configuration order, announcing each
/// attempt so the UI can say which mirror it is waiting on.
///
/// The plugin's own `check()` walks the same list but cannot report which entry
/// answered. Doing the walk here also leaves the settled `Update` in state, so
/// the install shares its download URL and signature.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
) -> Result<Option<UpdateCheckView>, String> {
    if cfg!(debug_assertions) {
        return Err("Updates are disabled in development builds.".to_string());
    }

    let endpoints = configured_endpoints(&app)?;
    let mut last_error: Option<String> = None;

    for endpoint in endpoints {
        let label = endpoint_label(&endpoint);
        let _ = app.emit(CHECKING_EVENT, Some(label.clone()));

        let updater = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|error| error.to_string())?
            .build()
            .map_err(|error| error.to_string())?;

        match updater.check().await {
            Ok(Some(update)) => {
                let view = UpdateCheckView {
                    version: update.version.clone(),
                    current_version: update.current_version.clone(),
                    date: update
                        .raw_json
                        .get("pub_date")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    body: update.body.clone(),
                    endpoint: label,
                };
                if let Ok(mut slot) = state.update.lock() {
                    *slot = Some(update);
                }
                let _ = app.emit(CHECKING_EVENT, None::<String>);
                return Ok(Some(view));
            }
            // 204 (or a manifest for the running version) means "nothing
            // newer"; the plugin stops here too instead of trying fallbacks.
            Ok(None) => {
                if let Ok(mut slot) = state.update.lock() {
                    *slot = None;
                }
                let _ = app.emit(CHECKING_EVENT, None::<String>);
                return Ok(None);
            }
            Err(error) => last_error = Some(format!("{label}: {error}")),
        }
    }

    let _ = app.emit(CHECKING_EVENT, None::<String>);
    Err(last_error.unwrap_or_else(|| "No update endpoint is configured.".to_string()))
}

fn configured_endpoints(app: &AppHandle) -> Result<Vec<Url>, String> {
    let endpoints = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("endpoints"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| "The updater has no configured endpoints.".to_string())?
        .iter()
        .filter_map(|value| value.as_str())
        .filter_map(|value| Url::parse(value).ok())
        .collect::<Vec<_>>();

    if endpoints.is_empty() {
        return Err("The updater has no usable endpoints.".to_string());
    }
    Ok(endpoints)
}

/// A display name for the mirror behind an endpoint. The three shipped URLs are
/// GitHub, Cloudflare R2 and Gitee; anything else is shown by its host.
fn endpoint_label(endpoint: &Url) -> String {
    let host = endpoint.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "github.com" || host.ends_with(".github.com") || host.ends_with("githubusercontent.com")
    {
        "GitHub".to_string()
    } else if host == "gitee.com" || host.ends_with(".gitee.com") {
        "Gitee".to_string()
    } else if host.contains("cloudflare") || host.ends_with(".r2.dev") || host == "wingharness.dpdns.org"
    {
        "Cloudflare".to_string()
    } else {
        host
    }
}

#[tauri::command]
pub async fn download_and_install_update(
    app: AppHandle,
    state: State<'_, UpdateDownloadState>,
    on_progress: Channel<UpdateProgressEvent>,
) -> Result<UpdateInstallResult, String> {
    let (cancel_sender, cancel_receiver) = watch::channel(false);
    {
        let mut active = state
            .cancel
            .lock()
            .map_err(|_| "Update download state is unavailable".to_string())?;
        if active.is_some() {
            return Err("An update download is already running".to_string());
        }
        *active = Some(cancel_sender);
    }

    let stored = state.update.lock().ok().and_then(|slot| slot.clone());
    let result = run_update(&app, stored, on_progress, cancel_receiver).await;
    state
        .cancel
        .lock()
        .map_err(|_| "Update download state is unavailable".to_string())?
        .take();
    result
}

#[tauri::command]
pub fn cancel_update_download(state: State<'_, UpdateDownloadState>) -> Result<bool, String> {
    let active = state
        .cancel
        .lock()
        .map_err(|_| "Update download state is unavailable".to_string())?;
    Ok(active
        .as_ref()
        .is_some_and(|cancel_sender| cancel_sender.send(true).is_ok()))
}

#[tauri::command]
pub fn is_update_download_active(state: State<'_, UpdateDownloadState>) -> Result<bool, String> {
    let active = state
        .cancel
        .lock()
        .map_err(|_| "Update download state is unavailable".to_string())?;
    Ok(active.is_some())
}
