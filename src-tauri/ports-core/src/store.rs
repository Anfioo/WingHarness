// Ported from Porter (https://github.com/t21dev/porter-app), MIT License.
// See ../UPSTREAM.md for the porting record.

// TODO(B2): persist the settings atomically under `<data dir>/ports`.

use crate::error::PortsResult;
use crate::models::{PortsSettings, DEFAULT_PINNED_PORTS};

pub fn load() -> PortsResult<PortsSettings> {
    Ok(defaults())
}

pub fn save(settings: PortsSettings) -> PortsResult<PortsSettings> {
    Ok(settings)
}

pub fn defaults() -> PortsSettings {
    PortsSettings {
        pinned_ports: DEFAULT_PINNED_PORTS.to_vec(),
        pinned_only: false,
    }
}
