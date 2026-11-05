//! Registry mapping an in-flight `requestId` to its cancellation handle.
//!
//! A single `watch` channel per in-flight request is the primitive: the sender
//! lives in the registry, the receiver lives in the [`CancelToken`] handed to
//! the send path. `watch` is used (rather than `Notify`) because it is
//! race-free — the current value is always readable, so a cancel that lands
//! before the send path starts waiting is still observed.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tokio::sync::watch;

/// In-flight requests, keyed by `requestId`. `Some` means the request is live.
static REGISTRY: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register an in-flight request and hand back its cancellation token. The token
/// unregisters itself when dropped. Registering the same id twice replaces the
/// previous entry (the frontend only keeps one in-flight request per id).
pub fn register(request_id: &str) -> CancelToken {
    let (tx, rx) = watch::channel(false);
    registry()
        .lock()
        .unwrap()
        .insert(request_id.to_string(), tx);
    CancelToken {
        id: request_id.to_string(),
        rx,
    }
}

/// Trip the token for `request_id`; returns whether a live request was found.
pub fn cancel(request_id: &str) -> bool {
    let guard = registry().lock().unwrap();
    match guard.get(request_id) {
        Some(tx) => tx.send(true).is_ok(),
        None => false,
    }
}

/// A handle to one in-flight request's cancellation state.
pub struct CancelToken {
    id: String,
    rx: watch::Receiver<bool>,
}

impl CancelToken {
    /// Whether cancellation has already been requested.
    pub fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    /// Resolve once cancellation is requested. Safe to use inside `select!`.
    pub async fn cancelled(&self) {
        let mut rx = self.rx.clone();
        // Re-check the value before waiting: `changed()` only resolves for
        // changes after it is awaited, so a cancel that already happened must be
        // caught by the borrow check above.
        while !*rx.borrow() {
            if rx.changed().await.is_err() {
                // The sender was dropped; fall through rather than hang.
                break;
            }
        }
    }
}

impl Drop for CancelToken {
    fn drop(&mut self) {
        if let Ok(mut guard) = registry().lock() {
            guard.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_only_hits_live_requests() {
        let token = register("req-1");
        assert!(!token.is_cancelled());
        assert!(cancel("req-1"));
        assert!(token.is_cancelled());
        assert!(!cancel("missing"));
        drop(token);
        // Dropping the token unregisters it.
        assert!(!cancel("req-1"));
    }
}
