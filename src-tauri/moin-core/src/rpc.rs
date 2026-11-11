// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! Browser-extension loopback RPC.
//!
//! **Status: stub.** The signatures below are frozen (B5 fills `serve` in) and
//! the plumbing is already wired: `lib.rs` calls [`spawn`] during setup and
//! [`stop`] on exit, and `moin_rpc_status` reads [`bound_address`].
//!
//! Contract, for the extension in `extension/`:
//!
//! - `GET /ping` → `200 { "app": "wingharness", "version": "<cargo version>" }`
//! - `POST /add` with `Authorization: Bearer <settings.rpc_token>` → `200 <Task>`
//! - anything else → non-2xx with `{ "error": "<english message>" }`
//! - bound to `127.0.0.1` only, never `0.0.0.0`.

use std::net::SocketAddr;
use std::sync::{OnceLock, RwLock};

use tokio::sync::watch;

use crate::state::MoinState;

static BOUND: OnceLock<RwLock<Option<SocketAddr>>> = OnceLock::new();
static SHUTDOWN: OnceLock<watch::Sender<bool>> = OnceLock::new();

fn bound_slot() -> &'static RwLock<Option<SocketAddr>> {
    BOUND.get_or_init(|| RwLock::new(None))
}

/// The address the listener is actually serving on, or `None` when it is off.
///
/// `moin_rpc_status` reports this instead of echoing the configured port, so the
/// settings page can tell "enabled but the port was taken" from "listening".
pub fn bound_address() -> Option<SocketAddr> {
    bound_slot().read().ok().and_then(|value| *value)
}

/// Publish (or clear) the bound address. [`serve`] calls this once it owns a
/// listener and again when it stops.
pub fn publish_bound(address: Option<SocketAddr>) {
    if let Ok(mut value) = bound_slot().write() {
        *value = address;
    }
}

/// Start the listener for the lifetime of the app. Called once from `setup`.
pub fn spawn(state: MoinState) {
    let (sender, receiver) = watch::channel(false);
    let _ = SHUTDOWN.set(sender);
    tauri::async_runtime::spawn(async move {
        serve(state, receiver).await;
    });
}

/// Ask the listener to stop accepting connections. Called on `RunEvent::Exit`.
pub fn stop() {
    if let Some(sender) = SHUTDOWN.get() {
        let _ = sender.send(true);
    }
}

/// Serve the extension endpoints until `shutdown` flips.
///
/// B5 replaces the body; the signature and the bound-address bookkeeping stay.
pub async fn serve(state: MoinState, mut shutdown: watch::Receiver<bool>) {
    let settings = match state.engine().await {
        Ok(engine) => engine.settings(),
        Err(error) => {
            log::warn!("The moin browser integration could not read its settings: {error}");
            return;
        }
    };
    if !settings.rpc_enabled {
        log::info!("The moin browser integration is disabled in settings.");
        return;
    }
    log::info!("The moin browser integration is not implemented in this build.");
    let _ = shutdown.changed().await;
    publish_bound(None);
}
