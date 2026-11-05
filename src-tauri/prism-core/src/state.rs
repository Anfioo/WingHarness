//! Tauri-managed state: one compiler instance and the core's child process.

use std::sync::{Arc, Mutex, MutexGuard};

use clash_prism_extension::PrismExtension;

use crate::core::{self, CoreSlot};
use crate::host::{ClashHost, StatusSlot, ValidationSlot};
use crate::sysproxy;

#[derive(Clone)]
pub struct ClashState {
    pub(crate) app: tauri::AppHandle,
    /// One compiler for the whole app. `apply` is serialized behind this lock,
    /// which is what we want: two concurrent compiles would race on the output
    /// file.
    pub(crate) ext: Arc<Mutex<PrismExtension<ClashHost>>>,
    /// What the last real apply reported about writing and hot reloading.
    pub(crate) last_status: StatusSlot,
    /// Why the last `mihomo -t` rejected the output: the engine discards it,
    /// and the command that fails needs it for the error it returns.
    pub(crate) validation: ValidationSlot,
    pub(crate) core: CoreSlot,
}

impl ClashState {
    pub fn new(app: tauri::AppHandle) -> Self {
        install_panic_log();
        let last_status: StatusSlot = Arc::new(Mutex::new(None));
        // Shared with the host: an apply has to be able to restart a core that
        // cannot hot reload onto a new controller address.
        let core: CoreSlot = Arc::new(Mutex::new(None));
        let validation: ValidationSlot = Arc::new(Mutex::new(None));
        // A crash leaves the system proxy pointing at a core that is not
        // running; the first thing this state does is put that right.
        sysproxy::clean_leftover();
        Self {
            ext: Arc::new(Mutex::new(PrismExtension::new(ClashHost::new(
                app.clone(),
                last_status.clone(),
                core.clone(),
                validation.clone(),
            )))),
            last_status,
            validation,
            core,
            app,
        }
    }

    /// The shared compiler, taken even when a panic poisoned the lock.
    ///
    /// A panic while the guard was held marks the mutex unusable, and every
    /// later `lock()` would fail until the app restarts. Nothing inside the
    /// engine is worth preserving — a compile starts from the files on disk —
    /// so the instance is replaced instead of reported as broken forever.
    pub(crate) fn compiler(&self) -> MutexGuard<'_, PrismExtension<ClashHost>> {
        match self.ext.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                *guard = PrismExtension::new(ClashHost::new(
                    self.app.clone(),
                    self.last_status.clone(),
                    self.core.clone(),
                    self.validation.clone(),
                ));
                self.ext.clear_poison();
                guard
            }
        }
    }

    /// Kill the core this app started. Called on exit so the process does not
    /// outlive the window and keep the proxy ports.
    pub fn shutdown(&self) {
        // The system proxy goes first: it may only ever name a port something
        // is listening on.
        let _ = sysproxy::disable();
        let _ = core::stop(&self.core);
    }
}

/// Keep the panic text in `panic.log`: a compile that panics only surfaces as a
/// failed command otherwise, with no trace of where it happened.
fn install_panic_log() {
    let path = crate::store::root().map(|root| root.join("panic.log")).ok();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(path) = &path {
            let location = info
                .location()
                .map(|site| format!("{}:{}", site.file(), site.line()))
                .unwrap_or_else(|| "unknown".to_string());
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .map(|text| (*text).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "non-string panic payload".to_string());
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis())
                .unwrap_or(0);
            let line = format!("{stamp} {location} {payload}\n");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                use std::io::Write;
                let _ = file.write_all(line.as_bytes());
            }
        }
        previous(info);
    }));
}

