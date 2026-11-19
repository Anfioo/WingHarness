//! Host-side state and plumbing for the task manager page.
//!
//! The command surface lives in `commands/argus.rs`; this module owns the state
//! the commands share plus the sampler thread, the service bridge and the
//! settings file.

pub mod sampler;
pub mod service;
pub mod store;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use argus_core::ArgusSettings;
use argus_core::meta::MetaStore;
use tauri::Manager;

pub struct ArgusState {
    /// The sampler thread, present only while the page is mounted.
    pub sampler: Mutex<Option<sampler::Sampler>>,
    /// The icon cache shared with the sampler, kept for the page's lifetime so
    /// icon ids stay valid across a sampler restart.
    pub meta: Arc<MetaStore>,
    /// Last settings read or written, so a command does not touch the disk
    /// just to echo the current value back.
    pub settings: Mutex<ArgusSettings>,
    /// Whether the host itself runs elevated; cached because the answer cannot
    /// change for a process.
    pub elevated: bool,
}

impl Default for ArgusState {
    fn default() -> Self {
        let elevated = argus_core::privilege::is_elevated();
        if elevated {
            // With an elevated token this lets the host open nearly every
            // process, which is what makes local-first actions useful.
            let _ = argus_core::privilege::enable_debug_privilege();
        }
        Self {
            sampler: Mutex::new(None),
            meta: MetaStore::new(),
            settings: Mutex::new(store::get().unwrap_or_default()),
            elevated,
        }
    }
}

impl ArgusState {
    /// Locks the sampler slot, recovering from a panicked holder: the slot
    /// only ever holds an `Option`, so a poisoned lock still has a valid value.
    pub fn sampler(&self) -> MutexGuard<'_, Option<sampler::Sampler>> {
        self.sampler.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn settings(&self) -> MutexGuard<'_, ArgusSettings> {
        self.settings.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Sends a control message to the running sampler, if any.
    pub fn send(&self, control: sampler::Control) {
        if let Some(sampler) = self.sampler().as_ref() {
            let _ = sampler.send(control);
        }
    }

    /// Asks the sampler to take a frame now, so an action's result shows up
    /// without waiting for the next tick.
    pub fn refresh(&self) {
        self.send(sampler::Control::Refresh);
    }

    /// Stops and forgets the sampler thread.
    pub fn stop_sampler(&self) {
        if let Some(sampler) = self.sampler().take() {
            let _ = sampler.send(sampler::Control::Stop);
        }
    }
}

/// Stops the sampling thread when the application exits; leaving it running
/// would keep sampling after the page is gone.
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ArgusState>() {
        state.stop_sampler();
    }
}
