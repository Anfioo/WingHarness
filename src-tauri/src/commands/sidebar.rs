//! The sidebar layout, edited in the sidebar manager window.

use crate::sidebar::icons::{self, CustomIcon};
use crate::sidebar::{self, SidebarConfig};

/// The saved layout, or `None` before it has ever been written.
#[tauri::command]
pub fn sidebar_get() -> Option<SidebarConfig> {
    sidebar::load()
}

/// Replaces the whole layout with the document the manager just edited.
#[tauri::command]
pub fn sidebar_set(config: SidebarConfig) -> Result<(), String> {
    sidebar::save(&config)
}

/// Every custom SVG in the icons folder. The folder is created when missing.
#[tauri::command]
pub fn sidebar_icons_list() -> Vec<CustomIcon> {
    icons::list()
}

/// Where the SVG files are read from, shown in the picker so a user knows where
/// to drop one.
#[tauri::command]
pub fn sidebar_icons_dir() -> String {
    match icons::ensure_dir() {
        Ok(dir) => dir.display().to_string(),
        Err(error) => {
            eprintln!("{error}");
            icons::dir().display().to_string()
        }
    }
}

/// Opens the icons folder in Explorer, after making sure it exists.
#[tauri::command]
pub fn sidebar_icons_open_dir() -> Result<(), String> {
    let dir = icons::ensure_dir()?;

    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|error| format!("Failed to open {}: {error}", dir.display()))?;

    Ok(())
}
