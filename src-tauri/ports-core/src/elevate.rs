// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

// TODO(B3): run `taskkill /PID <pid> /F` through one UAC prompt.

use crate::error::{PortsError, PortsResult};

pub fn kill_elevated(_pid: u32) -> PortsResult<()> {
    Err(PortsError::not_implemented())
}
