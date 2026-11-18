//! The task manager's settings file, forwarded from `argus-core`.

use argus_core::models::ArgusSettings;
use argus_core::{store as core_store, ArgusError};

pub fn get() -> Result<ArgusSettings, ArgusError> {
    core_store::load()
}

pub fn set(settings: ArgusSettings) -> Result<ArgusSettings, ArgusError> {
    core_store::save(settings)
}
