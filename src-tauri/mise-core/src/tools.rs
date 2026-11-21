// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::{MiseError, MiseResult};
use crate::models::MiseTool;
use crate::MiseState;

/// Every tool `mise ls --json` reports, with the active version selected.
pub async fn list_tools() -> MiseResult<Vec<MiseTool>> {
    Err(MiseError::not_implemented())
}

/// One tool with its remote versions loaded on demand.
pub async fn tool_detail(_state: &MiseState, _tool: &str) -> MiseResult<MiseTool> {
    Err(MiseError::not_implemented())
}

/// Cancel a running detail request for one tool.
pub async fn tool_detail_cancel(_state: &MiseState, _tool: &str) -> MiseResult<()> {
    Err(MiseError::not_implemented())
}
