// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

// TODO(B3): terminate the process holding a listening port.

use crate::error::{PortsError, PortsResult};

pub fn kill(_pid: u32) -> PortsResult<()> {
    Err(PortsError::not_implemented())
}
