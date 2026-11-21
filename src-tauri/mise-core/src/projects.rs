// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::{MiseError, MiseResult};
use crate::models::{MiseProjectCoverage, MiseScanDirectory};

/// Scan the open project windows and the enabled custom roots for mise
/// configuration and resolve each project's bindings.
pub async fn scan_projects(_app: &tauri::AppHandle) -> MiseResult<MiseProjectCoverage> {
    Err(MiseError::not_implemented())
}

/// The persisted custom scan roots, normalized and ordered by depth.
pub fn list_scan_dirs() -> MiseResult<Vec<MiseScanDirectory>> {
    Ok(Vec::new())
}

pub fn add_scan_dir(_path: &str) -> MiseResult<Vec<MiseScanDirectory>> {
    Err(MiseError::not_implemented())
}

pub fn remove_scan_dir(_path: &str) -> MiseResult<Vec<MiseScanDirectory>> {
    Err(MiseError::not_implemented())
}

pub fn set_scan_dir_enabled(_path: &str, _enabled: bool) -> MiseResult<Vec<MiseScanDirectory>> {
    Err(MiseError::not_implemented())
}

/// The roots of the currently open project windows, read from the window
/// labels and the `?path=` query of their URLs.
#[allow(dead_code)]
pub(crate) fn opened_project_roots(_app: &tauri::AppHandle) -> Vec<String> {
    Vec::new()
}
