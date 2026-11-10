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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "space-preview-state-{label}-{}-{stamp}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_read_before_the_inspect_is_refused() {
        let directory = temp_dir("unadmitted");
        let file = directory.join("note.txt");
        fs::write(&file, b"hello").unwrap();
        let state = PreviewState::default();

        let error = state.check(&file).unwrap_err();

        assert_eq!(error.code, "not-authorized");
    }

    #[test]
    fn an_inspected_path_is_accepted_and_returned_canonical() {
        let directory = temp_dir("admitted");
        let file = directory.join("note.txt");
        fs::write(&file, b"hello").unwrap();
        let state = PreviewState::default();

        let admitted = state.allow(&directory.join(".").join("note.txt")).unwrap();
        let checked = state.check(&admitted).unwrap();

        assert_eq!(checked, fs::canonicalize(&file).unwrap());
        assert_eq!(admitted, checked);
    }

    #[test]
    fn a_missing_path_is_not_found_rather_than_unauthorized() {
        let directory = temp_dir("missing");
        let state = PreviewState::default();

        let error = state.allow(&directory.join("absent.txt")).unwrap_err();

        assert_eq!(error.code, "not-found");
    }

    #[test]
    fn clearing_drops_every_admission() {
        let directory = temp_dir("cleared");
        let file = directory.join("note.txt");
        fs::write(&file, b"hello").unwrap();
        let state = PreviewState::default();
        let admitted = state.allow(&file).unwrap();

        state.clear();

        assert_eq!(state.check(&admitted).unwrap_err().code, "not-authorized");
    }

    #[test]
    fn a_fresh_state_admits_nothing() {
        let directory = temp_dir("fresh");
        let file = directory.join("note.txt");
        fs::write(&file, b"hello").unwrap();
        let state = PreviewState::default();

        assert_eq!(state.check(&file).unwrap_err().code, "not-authorized");
    }

    #[test]
    fn the_cached_preferences_start_at_the_defaults() {
        let state = PreviewState::default();

        assert_eq!(*state.prefs.lock().unwrap(), PreviewPreferences::default());
    }
}
