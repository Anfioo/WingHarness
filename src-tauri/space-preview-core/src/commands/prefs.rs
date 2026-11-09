//! The persisted preferences.
//!
//! These two are the only commands A0 implements for real. The in-memory copy
//! in `PreviewState` is kept in step so the agent and other windows can read the
//! current settings without touching the disk again.

use tauri::State;

use crate::error::SpacePreviewResult;
use crate::models::PreviewPreferences;
use crate::state::PreviewState;

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
    preferences: PreviewPreferences,
) -> SpacePreviewResult<PreviewPreferences> {
    let stored = crate::prefs::save(preferences)?;
    if let Ok(mut cached) = state.prefs.lock() {
        *cached = stored.clone();
    }
    // The agent follows the switch immediately; a restart is not required.
    crate::agent::set_enabled(stored.space_enabled);
    Ok(stored)
}
