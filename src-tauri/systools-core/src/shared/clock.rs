use std::time::{SystemTime, UNIX_EPOCH};

/// Wall-clock milliseconds used by persisted observations and history.
///
/// Traversal throttling keeps using monotonic [`std::time::Instant`]; only the
/// values written into snapshots and history records use this clock.
pub(crate) fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}
