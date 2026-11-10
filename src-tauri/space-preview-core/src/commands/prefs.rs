//! The persisted preferences.
//!
//! These two are the only commands A0 implements for real. The in-memory copy
//! in `PreviewState` is kept in step so the agent and other windows can read the
//! current settings without touching the disk again.

use tauri::{Emitter, State};

use crate::error::SpacePreviewResult;
use crate::models::PreviewPreferences;
use crate::state::PreviewState;

/// Broadcast after any command changes the stored preferences, so a page, the
/// preview window and the settings window all follow the same copy.
pub(crate) const PREFERENCES_EVENT: &str = "sp:preferences-changed";

#[tauri::command]
pub fn sp_preferences_get(state: State<'_, PreviewState>) -> SpacePreviewResult<PreviewPreferences> {
    let preferences = crate::prefs::load()?;
    if let Ok(mut cached) = state.prefs.lock() {
        *cached = preferences.clone();
    }
    Ok(preferences)
}

#[tauri::command]
pub fn sp_preferences_save(
    state: State<'_, PreviewState>,
    app: tauri::AppHandle,
    preferences: PreviewPreferences,
) -> SpacePreviewResult<PreviewPreferences> {
    let stored = crate::prefs::save(preferences)?;
    if let Ok(mut cached) = state.prefs.lock() {
        *cached = stored.clone();
    }
    // The agent follows the switch immediately; a restart is not required.
    crate::agent::set_enabled(stored.space_enabled);
    emit_preferences(&app, &stored);
    Ok(stored)
}

/// Tell every window the new preferences. A failure only costs the other
/// windows their live update; the value is already on disk.
pub(crate) fn emit_preferences(app: &tauri::AppHandle, preferences: &PreviewPreferences) {
    if let Err(error) = app.emit(PREFERENCES_EVENT, preferences) {
        log::warn!("space_preview_preferences_emit_failed error={error}");
    }
}
