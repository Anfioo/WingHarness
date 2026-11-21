// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use crate::error::{MiseError, MiseResult};
use crate::models::MiseRuntimeInfo;

/// Probe the local mise executable and its shims without failing when mise is
/// missing; the frontend shows an install guide instead.
pub async fn probe_runtime() -> MiseResult<MiseRuntimeInfo> {
    Err(MiseError::not_implemented())
}
