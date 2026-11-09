// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
//! The Windows space agent: the low-level keyboard hook, the Shell COM
//! selection reader, the Everything result reader and the preview window host.
//!
//! The root crate calls `start` from its setup hook and `stop` when the process
//! exits, and the preferences store calls `set_enabled`, so those signatures are
//! frozen here. Everything platform-specific lives behind `#[cfg(windows)]`; the
//! window handling below is shared so the non-Windows build still compiles.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::models::{AgentStatus, InitialPaths};

#[cfg(windows)]
mod everything;
#[cfg(windows)]
mod shortcut;
#[cfg(windows)]
mod windows_agent;

/// The preview window's label, as declared in `tauri.conf.json`.
pub(crate) const PREVIEW_WINDOW: &str = "preview";
/// Hands a selection to the preview window.
const PREVIEW_FILES_EVENT: &str = "sp:preview-files";
/// Tells the pages the preview window is gone.
const PREVIEW_CLOSED_EVENT: &str = "sp:preview-closed";

/// A newly shown window can emit before its page subscribes; one delayed
/// repeat a moment later covers that gap without repeating every navigation.
const FIRST_SHOW_RETRY: Duration = Duration::from_millis(350);

/// Whether the Space key may open the preview at all.
static ENABLED: AtomicBool = AtomicBool::new(true);
/// The newest payload, kept until the window has had a chance to listen.
static PENDING_EMIT: OnceLock<Mutex<Option<PendingEmit>>> = OnceLock::new();
/// Bumped on every hand-off so a stale retry can tell it has been overtaken.
static EMIT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct PendingEmit {
    sequence: u64,
    paths: Vec<String>,
    text: bool,
    file_manager: bool,
}

/// Start the agent. Reads the persisted switch first, then installs the hook.
pub fn start(app: tauri::AppHandle) {
    if let Ok(preferences) = crate::prefs::load() {
        ENABLED.store(preferences.space_enabled, Ordering::SeqCst);
    }
    #[cfg(windows)]
    windows_agent::start(app);
    #[cfg(not(windows))]
    let _ = app;
}

/// Stop the agent. Idempotent: a second call has nothing left to release.
pub fn stop() {
    #[cfg(windows)]
    windows_agent::stop();
}

/// Turn the space handler on or off without a restart.
pub fn set_enabled(enabled: bool) {
    if ENABLED.swap(enabled, Ordering::SeqCst) != enabled {
        log::debug!("space_preview_agent_toggled enabled={enabled}");
    }
    #[cfg(windows)]
    windows_agent::set_enabled(enabled);
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

pub fn status() -> AgentStatus {
    AgentStatus {
        enabled: is_enabled(),
        #[cfg(windows)]
        running: windows_agent::is_running(),
        #[cfg(not(windows))]
        running: false,
        #[cfg(windows)]
        com_ready: windows_agent::is_com_ready(),
        #[cfg(not(windows))]
        com_ready: false,
    }
}

/// Show the window with `paths`, then hand them over as `sp:preview-files`.
pub fn show_preview_files(
    app: &tauri::AppHandle,
    paths: Vec<String>,
    text: bool,
    file_manager: bool,
) {
    let Some(window) = app.get_webview_window(PREVIEW_WINDOW) else {
        log::warn!("space_preview_window_missing label={PREVIEW_WINDOW}");
        return;
    };
    let was_visible = window.is_visible().unwrap_or(false);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    if paths.is_empty() {
        return;
    }

    let sequence = EMIT_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    let pending = PendingEmit {
        sequence,
        paths,
        text,
        file_manager,
    };
    store_pending(&pending);

    if let Err(error) = emit_preview_files(&window, &pending) {
        log::warn!("space_preview_emit_failed error={error}");
    }
    if !was_visible {
        retry_first_emit(app.clone(), sequence);
    }
}

/// Hide the preview window and tell the pages it is gone.
pub fn hide_preview(app: &tauri::AppHandle) -> tauri::Result<()> {
    cancel_navigation();
    forget_pending();

    #[cfg(windows)]
    let result = windows_agent::hide_preview(app);
    #[cfg(not(windows))]
    let result = match app.get_webview_window(PREVIEW_WINDOW) {
        Some(window) => window.hide(),
        None => Ok(()),
    };

    if result.is_ok() {
        let _ = app.emit(PREVIEW_CLOSED_EVENT, ());
    }
    result
}

/// Move the file manager selection by `direction`, returning the new path.
///
/// A refused or out-of-range move is `Ok(None)`, not an error: the caller
/// falls back to its own list.
pub fn navigate(
    app: tauri::AppHandle,
    current: Option<String>,
    direction: i32,
) -> SpacePreviewResult<Option<String>> {
    #[cfg(windows)]
    {
        windows_agent::navigate(app, current, direction).map_err(|error| {
            SpacePreviewError::internal(format!(
                "The file manager selection could not be navigated: {error}"
            ))
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (app, current, direction);
        Ok(None)
    }
}

/// Drop any in-flight move; the preview no longer follows the file manager.
pub fn cancel_navigation() {
    #[cfg(windows)]
    windows_agent::cancel_navigation();
}

/// The selection a fresh preview window should open with.
///
/// The window is normally hidden but loaded, so it receives `sp:preview-files`
/// directly. If its page mounted after a hand-off, the unclaimed payload is
/// still pending; returning it here lets the page pull once instead of waiting
/// for an event it missed. Nothing is registered with the shell yet, so a run
/// that starts without any hand-off still has nothing to open.
pub fn initial_paths() -> InitialPaths {
    let pending = PENDING_EMIT
        .get()
        .and_then(|slot| slot.lock().ok().and_then(|pending| pending.clone()));
    match pending {
        Some(pending) => InitialPaths {
            paths: pending.paths,
            text: pending.text,
            file_manager: pending.file_manager,
        },
        None => InitialPaths::default(),
    }
}

fn store_pending(pending: &PendingEmit) {
    let slot = PENDING_EMIT.get_or_init(|| Mutex::new(None));
    if let Ok(mut pending_emit) = slot.lock() {
        *pending_emit = Some(pending.clone());
    }
}

fn forget_pending() {
    EMIT_SEQUENCE.fetch_add(1, Ordering::SeqCst);
    if let Some(slot) = PENDING_EMIT.get() {
        if let Ok(mut pending_emit) = slot.lock() {
            *pending_emit = None;
        }
    }
}

fn emit_preview_files(
    window: &tauri::WebviewWindow,
    pending: &PendingEmit,
) -> tauri::Result<()> {
    window.emit(
        PREVIEW_FILES_EVENT,
        serde_json::json!({
            "paths": pending.paths.clone(),
            "text": pending.text,
            "fileManager": pending.file_manager,
        }),
    )
}

fn retry_first_emit(app: tauri::AppHandle, sequence: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_SHOW_RETRY);
        if EMIT_SEQUENCE.load(Ordering::SeqCst) != sequence {
            return;
        }
        let Some(window) = app.get_webview_window(PREVIEW_WINDOW) else {
            return;
        };
        if !window.is_visible().unwrap_or(false) {
            return;
        }
        let pending = PENDING_EMIT
            .get()
            .and_then(|slot| slot.lock().ok().and_then(|pending| pending.clone()));
        let Some(pending) = pending.filter(|pending| pending.sequence == sequence) else {
            return;
        };
        if let Err(error) = emit_preview_files(&window, &pending) {
            log::warn!("space_preview_emit_retry_failed error={error}");
        }
    });
}
