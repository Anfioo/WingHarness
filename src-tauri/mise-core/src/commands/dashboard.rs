// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::dashboard;
use crate::error::MiseResult;
use crate::models::MiseDashboard;

#[tauri::command]
pub async fn mise_dashboard(app: tauri::AppHandle) -> MiseResult<MiseDashboard> {
    dashboard::load_dashboard(&app).await
}
