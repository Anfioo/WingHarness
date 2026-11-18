//! Public data-transfer objects shared by the host commands and the frontend.

use serde::{Deserialize, Serialize};

/// Fastest sampling interval the page accepts, in milliseconds.
pub const MIN_INTERVAL_MS: u64 = 250;
/// Slowest sampling interval the page accepts, in milliseconds.
pub const MAX_INTERVAL_MS: u64 = 5000;
/// The interval a fresh install starts with.
pub const DEFAULT_INTERVAL_MS: u64 = 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ArgusSettings {
    pub interval_ms: u64,
}

impl Default for ArgusSettings {
    fn default() -> Self {
        Self {
            interval_ms: DEFAULT_INTERVAL_MS,
        }
    }
}

impl ArgusSettings {
    pub fn with_interval_ms(interval_ms: u64) -> Self {
        Self { interval_ms }.clamped()
    }

    /// Keep the interval inside the range the sampler can actually honour.
    pub fn clamped(self) -> Self {
        Self {
            interval_ms: self.interval_ms.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_one_second() {
        assert_eq!(ArgusSettings::default().interval_ms, 1000);
    }

    #[test]
    fn interval_is_clamped_to_the_supported_range() {
        assert_eq!(ArgusSettings::with_interval_ms(0).interval_ms, MIN_INTERVAL_MS);
        assert_eq!(
            ArgusSettings::with_interval_ms(60_000).interval_ms,
            MAX_INTERVAL_MS
        );
        assert_eq!(ArgusSettings::with_interval_ms(1500).interval_ms, 1500);
    }
}
