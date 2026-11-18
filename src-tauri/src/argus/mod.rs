//! Host-side state and plumbing for the task manager page.
//!
//! The command surface lives in `commands/argus.rs`; this module owns the state
//! the commands share. A0 creates the sampler, service and store stubs; B3
//! replaces their bodies.

pub mod sampler;
pub mod service;
pub mod store;

use tauri::Manager;

#[derive(Default)]
pub struct ArgusState {
    pub sampler: sampler::Sampler,
}

/// Stops the sampling thread when the application exits. A0 has no thread yet,
/// but the hook is wired now so B3 only has to fill in `Sampler::stop`.
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ArgusState>() {
        state.sampler.stop();
    }
}
