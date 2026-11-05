//! Reconnect policy: backoff timing, crash classification and the set of
//! messages that make retrying pointless.

use std::time::Duration;

use super::types::{CRASH_WINDOW, MAX_BACKOFF, MAX_CONSECUTIVE_CRASHES};

/// Exponential backoff: attempt 1 => 1s, 2 => 2s, 3 => 4s ... capped at 60s.
pub(crate) fn reconnect_delay(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(6);
    let seconds = 1u64
        .checked_shl(shift)
        .unwrap_or(MAX_BACKOFF.as_secs())
        .min(MAX_BACKOFF.as_secs());
    Duration::from_secs(seconds)
}

/// An exit this soon after spawn counts towards the circuit breaker.
pub(crate) fn should_count_as_crash(lived: Duration) -> bool {
    lived < CRASH_WINDOW
}

pub(crate) fn tripped_circuit_breaker(consecutive_crashes: u32) -> bool {
    consecutive_crashes >= MAX_CONSECUTIVE_CRASHES
}

/// Authentication and configuration failures are permanent: retrying only
/// hammers the server with the same rejected credentials.
pub(crate) fn is_permanent_failure_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("login to server failed")
        || lower.contains("authorization failed")
        || lower.contains("authentication failed")
        || lower.contains("token rejected")
        || lower.contains("invalid token")
        || lower.contains("auth failed")
        || lower.contains("config verify")
        || lower.contains("no such file")
        || lower.contains("permission denied")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps_at_60s() {
        assert_eq!(reconnect_delay(1), Duration::from_secs(1));
        assert_eq!(reconnect_delay(2), Duration::from_secs(2));
        assert_eq!(reconnect_delay(3), Duration::from_secs(4));
        assert_eq!(reconnect_delay(4), Duration::from_secs(8));
        assert_eq!(reconnect_delay(7), Duration::from_secs(60));
        assert_eq!(reconnect_delay(20), Duration::from_secs(60));
    }

    #[test]
    fn classifies_auth_failures_as_permanent() {
        assert!(is_permanent_failure_message(
            "login to server failed: token rejected"
        ));
        assert!(is_permanent_failure_message("authorization failed"));
        assert!(is_permanent_failure_message("invalid token"));
        assert!(!is_permanent_failure_message("connection refused"));
        assert!(!is_permanent_failure_message("read tcp 127.0.0.1:7000: i/o timeout"));
    }

    #[test]
    fn short_runtime_counts_as_crash() {
        assert!(should_count_as_crash(Duration::from_secs(3)));
        assert!(should_count_as_crash(Duration::from_secs(14)));
        assert!(!should_count_as_crash(Duration::from_secs(15)));
        assert!(!should_count_as_crash(Duration::from_secs(45)));
    }

    #[test]
    fn circuit_breaker_trips_after_five_rapid_crashes() {
        assert!(!tripped_circuit_breaker(4));
        assert!(tripped_circuit_breaker(MAX_CONSECUTIVE_CRASHES));
        assert!(tripped_circuit_breaker(9));
    }
}
