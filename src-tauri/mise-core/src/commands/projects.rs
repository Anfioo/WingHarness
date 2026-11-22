// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::MiseResult;
use crate::models::{MiseProjectCoverage, MiseScanDirectory};
use crate::projects;

#[tauri::command]
pub async fn mise_projects_scan(app: tauri::AppHandle) -> MiseResult<MiseProjectCoverage> {
    projects::scan_projects(&app).await
}

#[tauri::command]
pub async fn mise_scan_dirs_list() -> MiseResult<Vec<MiseScanDirectory>> {
    projects::list_scan_dirs()
}

#[tauri::command]
pub async fn mise_scan_dirs_add(path: String) -> MiseResult<Vec<MiseScanDirectory>> {
    projects::add_scan_dir(&path)
}

#[tauri::command]
pub async fn mise_scan_dirs_remove(path: String) -> MiseResult<Vec<MiseScanDirectory>> {
    projects::remove_scan_dir(&path)
}

#[tauri::command]
pub async fn mise_scan_dirs_set_enabled(
    path: String,
    enabled: bool,
) -> MiseResult<Vec<MiseScanDirectory>> {
    projects::set_scan_dir_enabled(&path, enabled)
}
