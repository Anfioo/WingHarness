//! The per-run path allowlist and the cached preferences.
//!
//! `sp_inspect_file` is the only command that will admit a path; every read and
//! write checks the canonical path against this set first. It lives for one
//! process lifetime on purpose: a new run starts with nothing allowed.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::models::PreviewPreferences;

/// Managed by the root crate through `app.manage`.
#[derive(Default)]
pub struct PreviewState {
    pub allowed: Mutex<HashSet<PathBuf>>,
    pub prefs: Mutex<PreviewPreferences>,
}

impl PreviewState {
    /// Canonicalize `path` and admit it for later reads and writes.
    pub fn allow(&self, path: &Path) -> SpacePreviewResult<PathBuf> {
        let canonical = canonicalize(path)?;
        let mut allowed = self
            .allowed
            .lock()
            .map_err(|_| SpacePreviewError::internal("The preview path state is poisoned."))?;
        allowed.insert(canonical.clone());
        Ok(canonical)
    }

    /// Canonicalize `path` and verify it was admitted by `allow`.
    pub fn check(&self, path: &Path) -> SpacePreviewResult<PathBuf> {
        let canonical = canonicalize(path)?;
        let allowed = self
            .allowed
            .lock()
            .map_err(|_| SpacePreviewError::internal("The preview path state is poisoned."))?;
        if allowed.contains(&canonical) {
            Ok(canonical)
        } else {
            Err(SpacePreviewError::not_authorized(
                "The path was not inspected before it was read.",
            ))
        }
    }

    /// Drop every admitted path, e.g. when the preview window closes.
    pub fn clear(&self) {
        if let Ok(mut allowed) = self.allowed.lock() {
            allowed.clear();
        }
    }
}

fn canonicalize(path: &Path) -> SpacePreviewResult<PathBuf> {
    fs::canonicalize(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => SpacePreviewError::not_found(format!(
            "The path does not exist: {}",
            path.display()
        )),
        _ => SpacePreviewError::internal(format!(
            "The path could not be resolved: {} ({error})",
            path.display()
        )),
    })
}
