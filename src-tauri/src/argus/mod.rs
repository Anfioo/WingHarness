//! Host-side state and plumbing for the task manager page.
//!
//! The command surface lives in `commands/argus.rs`; this module owns the state
//! the commands share plus the sampler thread, the service bridge and the
//! settings file.

pub mod sampler;
pub mod service;
pub mod store;

use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use argus_core::meta::MetaStore;
use argus_core::services::ServiceCatalog;
use argus_core::{ArgusError, ArgusSettings};
use tauri::Manager;

pub struct ArgusState {
    /// The sampler thread, present only while the page is mounted.
    pub sampler: Mutex<Option<sampler::Sampler>>,
    /// The icon cache shared with the sampler, kept for the page's lifetime so
    /// icon ids stay valid across a sampler restart.
    pub meta: Arc<MetaStore>,
    /// The service catalogue and its 60-second configuration cache.
    pub services: ServiceCatalog,
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
            services: ServiceCatalog::default(),
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

    /// Starts the sampler thread if it is not running.
    pub fn ensure_sampler(&self) {
        let mut sampler = self.sampler();
        if sampler.is_none() {
            *sampler = Some(sampler::Sampler::spawn(self.meta.clone()));
        }
    }

    /// Applies the foreground and background settings to the sampler. The
    /// caller starts the thread first when background monitoring is on.
    pub fn apply_settings(&self, settings: &ArgusSettings) {
        *self.settings() = settings.clone();
        // Enabling background monitoring has to start a thread when the page
        // is closed; the controls below then reach the new thread.
        if settings.background_monitoring {
            self.ensure_sampler();
        }
        self.send(sampler::Control::SetInterval(settings.interval_ms));
        self.send(sampler::Control::SetBackground(
            settings.background_monitoring,
        ));
        self.send(sampler::Control::SetBackgroundInterval(
            settings.background_interval_ms,
        ));
        if settings.background_monitoring {
            match argus_core::history::dir() {
                Ok(dir) => self.send(sampler::Control::SetHistoryDir(Some(dir))),
                Err(error) => {
                    eprintln!("[argus] history directory unavailable: {error:?}");
                    self.send(sampler::Control::SetHistoryDir(None));
                }
            }
        } else {
            self.send(sampler::Control::SetHistoryDir(None));
        }
    }

    /// Drops the page's subscription. The thread keeps running when background
    /// monitoring is on.
    pub fn unsubscribe_sampler(&self) {
        self.send(sampler::Control::Unsubscribe);
    }

    /// Removes the recorded history. A running sampler closes its open day file
    /// before the files are deleted.
    pub fn clear_history(&self) -> Result<(), ArgusError> {
        let dir = argus_core::history::dir()?;
        let (tx, rx) = mpsc::channel();
        let delivered = {
            let sampler = self.sampler();
            sampler.as_ref().is_some_and(|running| {
                running.send(sampler::Control::ClearHistory(dir.clone(), tx))
            })
        };
        if delivered {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(error)) => {
                    return Err(ArgusError::internal(format!(
                        "The history files could not be removed: {error}"
                    )))
                }
                Err(_) => {
                    return Err(ArgusError::internal(
                        "The task manager did not answer the history clear request.",
                    ))
                }
            }
        }
        argus_core::history::clear(&dir).map_err(|error| {
            ArgusError::internal(format!("The history files could not be removed: {error}"))
        })
    }
}

/// Starts background sampling at application launch when the persisted
/// settings ask for it, and prunes expired history either way.
pub fn start_background(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ArgusState>() else {
        return;
    };
    let settings = match store::get() {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("[argus] settings could not be read at startup: {error:?}");
            ArgusSettings::default()
        }
    };
    if let Ok(dir) = argus_core::history::dir() {
        argus_core::history::prune_expired(&dir);
    }
    if !settings.background_monitoring {
        return;
    }
    state.ensure_sampler();
    state.apply_settings(&settings);
}

/// Stops the sampling thread when the application exits; leaving it running
/// would keep sampling after the page is gone.
pub fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ArgusState>() {
        state.stop_sampler();
    }
}
