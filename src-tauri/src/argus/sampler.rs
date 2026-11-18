//! The snapshot sampling thread and its `Channel<Snapshot>` subscriptions.
//!
//! A0 freezes the entry points only: `start` accepts the channel and interval
//! and returns immediately, `stop` is a no-op, and the exit hook already calls
//! it. B3 replaces the bodies with the ported thread and frame pump.

use argus_core::{ArgusError, Snapshot};
use tauri::ipc::Channel;

#[derive(Default)]
pub struct Sampler;

impl Sampler {
    /// Start delivering snapshots on `channel`. A0 records nothing and sends no
    /// frames, so the page renders its empty state.
    pub fn start(&self, _channel: Channel<Snapshot>, _interval_ms: u64) -> Result<(), ArgusError> {
        Ok(())
    }

    /// Stop the sampling thread. No-op until B3 ports the thread.
    pub fn stop(&self) {}
}
