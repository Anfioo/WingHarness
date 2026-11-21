// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

//! Environment manager engine.
//!
//! The root crate publishes the data directories ([`paths::CONFIG_DIR`] and
//! [`paths::HOST_DATA_DIR`]) and manages one [`MiseState`] in `.setup()`;
//! everything else resolves from there. Every persisted file stays under
//! `<data dir>/mise`, and every mise invocation goes through the local CLI.

pub mod actions;
pub mod commands;
pub mod config;
pub mod dashboard;
pub mod error;
pub mod history;
pub mod models;
pub mod paths;
pub mod process;
pub mod projects;
pub mod runtime;
pub mod tools;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

pub use error::{MiseError, MiseErrorCode, MiseResult};

/// App-wide state the commands share: the one-at-a-time action gate and the
/// per-tool cancellation tokens behind the detail view.
#[derive(Default)]
pub struct MiseState {
    action_gate: AtomicBool,
    detail_cancels: Mutex<HashMap<String, CancellationToken>>,
}

impl MiseState {
    /// Claim the action gate. False means another action is already running.
    pub fn try_begin_action(&self) -> bool {
        self.action_gate
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// Release the action gate.
    pub fn end_action(&self) {
        self.action_gate.store(false, Ordering::Release);
    }

    /// Register the cancellation token for a tool's detail request. Registering
    /// the same tool again cancels the previous request.
    pub fn register_detail_cancel(&self, tool: &str) -> CancellationToken {
        let token = CancellationToken::new();
        let previous = self
            .detail_cancels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(tool.to_string(), token.clone());
        if let Some(previous) = previous {
            previous.cancel();
        }
        token
    }

    /// Drop a tool's token once its request has finished.
    pub fn finish_detail_cancel(&self, tool: &str) {
        let _ = self
            .detail_cancels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(tool);
    }

    /// Cancel a tool's detail request; true when one was registered.
    pub fn cancel_detail(&self, tool: &str) -> bool {
        let token = self
            .detail_cancels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(tool);
        match token {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }
}
