//! Liveness of the frps control port: one TCP handshake, no frps-specific
//! protocol, plus the wall-clock check that detects a laptop waking up.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// A wall-clock gap this large means the health loop missed real time: the
/// machine slept, or the network was suspended.
pub const SUSPEND_GAP: Duration = Duration::from_secs(30);

pub fn wall_clock_suggests_suspend(gap: Duration) -> bool {
    gap >= SUSPEND_GAP
}

/// Round-trip time of a TCP handshake to the frps control port.
///
/// DNS resolution happens before the clock starts so the number tracks the live
/// path instead of a cached resolver hit.
pub fn probe_latency_ms(endpoint: &str) -> Option<u32> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return None;
    }
    let addresses = endpoint.to_socket_addrs().ok()?;
    for address in addresses {
        let started = Instant::now();
        if TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).is_ok() {
            return Some(started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn empty_endpoint_is_unreachable() {
        assert!(probe_latency_ms("").is_none());
        assert!(probe_latency_ms("   ").is_none());
    }

    #[test]
    fn suspend_gap_ignores_short_pauses() {
        assert!(!wall_clock_suggests_suspend(Duration::from_secs(2)));
        assert!(!wall_clock_suggests_suspend(Duration::from_secs(29)));
        assert!(wall_clock_suggests_suspend(SUSPEND_GAP));
        assert!(wall_clock_suggests_suspend(Duration::from_secs(120)));
    }

    #[test]
    fn probe_measures_a_loopback_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("local addr").port();
        let latency = probe_latency_ms(&format!("127.0.0.1:{port}"));
        assert!(latency.is_some(), "loopback listener must answer");
    }

    #[test]
    fn malformed_endpoint_is_unreachable() {
        assert!(probe_latency_ms("not a host:port").is_none());
    }
}
