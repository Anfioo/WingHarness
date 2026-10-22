//! Application configuration commands.

use serde::Serialize;

use crate::config::{self, Config};

/// The configuration plus the context the settings UI needs to render it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub config: Config,
    /// Where the file lives, shown in the UI so it can be edited by hand.
    pub path: String,
    /// Directory everything is stored in right now.
    pub data_dir: String,
    /// Directory the pointer names, which a restart would switch to. Unset when
    /// the data directory is at its default.
    pub data_dir_configured: Option<String>,
    /// Directory used when no data directory is configured.
    pub data_dir_default: String,
    /// The pointer file, shown so it can be edited by hand.
    pub data_dir_pointer: String,
}

fn view() -> ConfigView {
    ConfigView {
        config: config::load(),
        path: config::path().display().to_string(),
        data_dir: config::dir().display().to_string(),
        data_dir_configured: config::configured_data_dir().map(|dir| dir.display().to_string()),
        data_dir_default: config::default_dir().display().to_string(),
        data_dir_pointer: config::pointer_path().display().to_string(),
    }
}

#[tauri::command]
pub fn get_config() -> ConfigView {
    view()
}

/// Saves the configuration and returns the reloaded view.
#[tauri::command]
pub fn save_config(config: Config) -> Result<ConfigView, String> {
    config::save(&config)?;
    Ok(view())
}

/// Points the data directory at `dir`, or clears it when `None`.
///
/// Only the pointer file changes here: the running app keeps using the
/// directory it resolved at startup, so the change takes effect on the next
/// launch. That is deliberate — moving state out from under open log handles and
/// the config auto-save would split data across two roots.
#[tauri::command]
pub fn set_data_dir(dir: Option<String>) -> Result<ConfigView, String> {
    let target = dir
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);

    if let Some(path) = &target {
        if !path.is_absolute() {
            return Err(format!(
                "The data directory must be an absolute path: {}",
                path.display()
            ));
        }
    }

    config::write_pointer_at(&config::default_dir(), target.as_deref())?;
    Ok(view())
}
