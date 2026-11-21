// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::{MiseError, MiseResult};
use crate::models::MiseDashboard;

/// Aggregate the runtime probe, system information, tool and project counts,
/// environment signals and the newest history entries for the overview tab.
pub async fn load_dashboard(_app: &tauri::AppHandle) -> MiseResult<MiseDashboard> {
    Err(MiseError::not_implemented())
}
