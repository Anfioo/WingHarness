//! The `PrismHost` implementation — the whole seam between Prism and this app.
//!
//! Prism only asks four things of its host: where to read the source config,
//! where to write the compiled one, which directory holds the patches, and how
//! to tell the UI something happened. Both config ends are ordinary files here,
//! so the compiler works with no core running at all.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use clash_prism_extension::{ApplyStatus, PrismEvent, PrismHost};
use tauri::Emitter;

use crate::core::{self, CoreSlot};
use crate::profiles;
use crate::store;

pub const EVENT_NAME: &str = "clash:prism";

pub type CaptureSlot = Arc<Mutex<Option<String>>>;
pub type StatusSlot = Arc<Mutex<Option<ApplyStatus>>>;
/// Why the last `mihomo -t` run rejected the output, if it did.
pub type ValidationSlot = Arc<Mutex<Option<String>>>;

pub struct ClashHost {
    app: tauri::AppHandle,
    /// Set only for the throwaway host a preview compile uses: the compiled
    /// YAML lands here instead of on disk, and nothing is reloaded.
    capture: Option<CaptureSlot>,
    last_status: StatusSlot,
    /// The core's child process, when this host owns one. A preview host has
    /// none, and applying without one only writes the file.
    core: Option<CoreSlot>,
    validation: ValidationSlot,
}

impl ClashHost {
    pub fn new(
        app: tauri::AppHandle,
        last_status: StatusSlot,
        core: CoreSlot,
        validation: ValidationSlot,
    ) -> Self {
        Self {
            app,
            capture: None,
            last_status,
            core: Some(core),
            validation,
        }
    }

    pub fn preview(app: tauri::AppHandle, capture: CaptureSlot) -> Self {
        Self {
            app,
            capture: Some(capture),
            last_status: Arc::new(Mutex::new(None)),
            core: None,
            validation: Arc::new(Mutex::new(None)),
        }
    }
}

impl PrismHost for ClashHost {
    fn read_running_config(&self) -> Result<String, String> {
        Ok(profiles::active_content()?.unwrap_or_else(|| profiles::DEFAULT_PROFILE.to_string()))
    }

    fn apply_config(&self, config: &str) -> Result<ApplyStatus, String> {
        if let Some(capture) = &self.capture {
            if let Ok(mut slot) = capture.lock() {
                *slot = Some(config.to_string());
            }
            return Ok(ApplyStatus {
                files_saved: false,
                hot_reload_success: false,
                message: "Preview: nothing written to disk".to_string(),
                restarted: false,
            });
        }

        let path = store::run_config_path()?;
        let config = core::own_controller(config)?;
        store::atomic_write(&path, &config)?;

        let running = self.core.as_ref().is_some_and(|slot| core::running(slot));
        let (mut hot_reload_success, mut message) = match core::reload(&path) {
            Ok(message) => (true, message),
            Err(error) => (false, error),
        };

        // mihomo reads `external-controller` once, at startup: a core that
        // accepted the file still answers on the address it was started with.
        // Ask the address this output names whether it is really there.
        if hot_reload_success && running && !core::controller_answers(&config) {
            hot_reload_success = false;
        }

        // A core that cannot be reached or that still holds the previous
        // controller address cannot be moved by a hot reload — restart it. With
        // no core running, writing the file is the whole apply.
        let mut restarted = false;
        if !hot_reload_success {
            if !running {
                message = "Core not running; config written".to_string();
            } else if let Some(slot) = self.core.as_ref() {
                match core::stop(slot).and_then(|()| core::start(slot)) {
                    Ok(pid) => {
                        restarted = true;
                        hot_reload_success = true;
                        message = format!(
                            "Applied; core restarted on the new controller port (pid {pid})"
                        );
                    }
                    Err(restart) => {
                        message = format!("{message}; restarting the core failed: {restart}");
                    }
                }
            }
        }

        let status = ApplyStatus {
            files_saved: true,
            hot_reload_success,
            message,
            restarted,
        };
        if let Ok(mut slot) = self.last_status.lock() {
            *slot = Some(status.clone());
        }
        Ok(status)
    }

    fn get_prism_workspace(&self) -> Result<PathBuf, String> {
        store::prism_dir()
    }

    fn notify(&self, event: PrismEvent) {
        let _ = self.app.emit(EVENT_NAME, event);
    }

    fn validate_config(&self, config: &str) -> Result<bool, String> {
        let (accepted, output) = core::validate(config)?;
        // A geo database the core could not download is not a reason to refuse
        // the output: the core itself starts fine without it. Everything else
        // the check complains about is.
        let accepted = accepted || !core::validation_blocks(&output);
        // The engine only says "validation failed"; the reason has to be kept
        // here so the command that reports the failure can pass it on.
        if let Ok(mut slot) = self.validation.lock() {
            *slot = (!accepted).then(|| core::validation_reason(&output));
        }
        Ok(accepted)
    }

    fn get_current_profile(&self) -> Option<String> {
        let id = profiles::active_id().ok().flatten()?;
        Some(
            id.trim_end_matches(".yaml")
                .trim_end_matches(".yml")
                .to_string(),
        )
    }

    /// `{{proxy}}` resolves to the first proxy group of the active profile, so
    /// imported rules land in whatever group the user actually routes through.
    fn get_variables(&self) -> HashMap<String, String> {
        let mut vars = HashMap::new();
        let content = profiles::active_content().ok().flatten();
        let group = content.as_deref().and_then(first_group_name);
        vars.insert(
            "proxy".to_string(),
            group.unwrap_or_else(|| "PROXY".to_string()),
        );
        vars
    }
}

fn first_group_name(content: &str) -> Option<String> {
    let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(content).ok()?;
    let groups = value
        .as_mapping()?
        .get(serde_yaml_ng::Value::String("proxy-groups".into()))?
        .as_sequence()?;
    groups
        .first()?
        .as_mapping()?
        .get(serde_yaml_ng::Value::String("name".into()))?
        .as_str()
        .map(|s| s.to_string())
}
