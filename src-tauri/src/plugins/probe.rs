//! Waits for a plugin's page to start answering.
//!
//! A plugin that serves a page needs a moment between being launched and its
//! socket accepting connections. The page shows a spinner until then, which
//! means something has to answer "is it up yet?" -- and a TCP connect is
//! enough. The page is served over HTTP, so a listening socket is the only
//! thing worth waiting for, and checking it costs no HTTP client.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

/// How long to wait for a TCP handshake before calling the address unreachable.
const TIMEOUT: Duration = Duration::from_millis(400);

/// True when something accepts a TCP connection at `url`'s host and port.
pub fn reachable(url: &str) -> bool {
    let Some(authority) = authority_of(url) else {
        return false;
    };
    let Ok(addresses) = authority.to_socket_addrs() else {
        return false;
    };
    addresses
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, TIMEOUT).is_ok())
}

/// The `host:port` of an http(s) URL, with the scheme's default port filled in.
///
/// Returns `None` for anything that is not http(s): the same check the manifest
/// applies, repeated here because this is what decides whether a socket gets
/// opened.
fn authority_of(url: &str) -> Option<String> {
    let url = url.trim();
    let lowered = url.to_ascii_lowercase();
    let (rest, default_port) = if let Some(rest) = lowered.strip_prefix("http://") {
        (rest, 80)
    } else if let Some(rest) = lowered.strip_prefix("https://") {
        (rest, 443)
    } else {
        return None;
    };

    // Split off the path, query and fragment, leaving the authority.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    // A port may already be there, in which case the default does not apply.
    if authority.contains(':') {
        Some(authority.to_string())
    } else {
        Some(format!("{authority}:{default_port}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_in_the_default_port_of_the_scheme() {
        assert_eq!(
            authority_of("http://127.0.0.1:11212/").as_deref(),
            Some("127.0.0.1:11212")
        );
        assert_eq!(
            authority_of("http://127.0.0.1/").as_deref(),
            Some("127.0.0.1:80")
        );
        assert_eq!(
            authority_of("https://example.com").as_deref(),
            Some("example.com:443")
        );
        // Path, query and fragment are not part of the authority.
        assert_eq!(
            authority_of("http://host:9/a/b?c#d").as_deref(),
            Some("host:9")
        );
        assert_eq!(authority_of("  http://host/  ").as_deref(), Some("host:80"));
    }

    #[test]
    fn only_http_addresses_can_be_probed() {
        assert!(authority_of("file:///c:/x").is_none());
        assert!(authority_of("javascript:alert(1)").is_none());
        assert!(authority_of("http://").is_none());
        assert!(authority_of("").is_none());
    }
}
