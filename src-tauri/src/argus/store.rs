//! The task manager's settings file, forwarded from `argus-core`.
//!
//! `argus-core` owns the on-disk format (atomic staged write, corrupt-file
//! backup, clamping); this module only names the operations the commands use.

use argus_core::ArgusError;
use argus_core::models::ArgusSettings;

pub use argus_core::store::{load, save};

/// Keep an interval inside the range the sampler can honour. This is the same
/// clamp `argus-core` applies when reading and writing, exposed for callers
/// that only need the number.
pub fn clamp_interval(interval_ms: u64) -> u64 {
    ArgusSettings::with_interval_ms(interval_ms).interval_ms
}

pub fn get() -> Result<ArgusSettings, ArgusError> {
    load()
}

pub fn set(settings: ArgusSettings) -> Result<ArgusSettings, ArgusError> {
    save(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use argus_core::models::{DEFAULT_INTERVAL_MS, MAX_INTERVAL_MS, MIN_INTERVAL_MS};

    #[test]
    fn intervals_are_clamped_to_the_supported_range() {
        assert_eq!(clamp_interval(0), MIN_INTERVAL_MS);
        assert_eq!(clamp_interval(249), MIN_INTERVAL_MS);
        assert_eq!(clamp_interval(1000), DEFAULT_INTERVAL_MS);
        assert_eq!(clamp_interval(5000), MAX_INTERVAL_MS);
        assert_eq!(clamp_interval(u64::MAX), MAX_INTERVAL_MS);
    }
}
