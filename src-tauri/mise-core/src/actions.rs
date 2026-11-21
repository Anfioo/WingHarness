// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::{MiseError, MiseResult};
use crate::models::MiseActionResult;
use crate::MiseState;

/// Validate and run a multi-line mise script, reporting progress through the
/// `mise:action-progress` event and recording one history entry.
pub async fn run_script(
    _app: &tauri::AppHandle,
    _state: &MiseState,
    _script: &str,
    _working_directory: Option<&str>,
) -> MiseResult<MiseActionResult> {
    Err(MiseError::not_implemented())
}
