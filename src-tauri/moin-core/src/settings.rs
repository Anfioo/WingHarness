// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! `settings.json` read/write. Corrupt input is backed up, not deleted, and the
//! caller falls back to the defaults so the page can still open.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::MoinResult;
use crate::models::Settings;
use crate::paths;

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

pub(crate) fn load(data_dir: &Path) -> Settings {
    let file = path(data_dir);
    let Ok(bytes) = fs::read(&file) else {
        return Settings::default();
    };
    match serde_json::from_slice::<Settings>(&bytes) {
        Ok(mut settings) => {
            let _ = settings.validate();
            settings
        }
        Err(error) => {
            paths::backup_corrupt(&file);
            log::warn!("Invalid moin settings were replaced with defaults: {error}");
            Settings::default()
        }
    }
}

pub(crate) fn save(data_dir: &Path, settings: &Settings) -> MoinResult<()> {
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| crate::MoinError::internal(error.to_string()))?;
    paths::write_atomic(&path(data_dir), &bytes)
}

#[cfg(test)]
mod tests {
    use super::{load, save};
    use crate::models::Settings;

    #[test]
    fn settings_round_trip_with_defaults_for_new_fields() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.max_concurrent = 7;
        save(dir.path(), &settings).unwrap();
        let loaded = load(dir.path());
        assert_eq!(loaded.max_concurrent, 7);
        assert_eq!(loaded.rpc_port, 47653);
        assert!(loaded.notify_on_complete);
    }

    #[test]
    fn invalid_settings_are_backed_up_and_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "{").unwrap();
        let loaded = load(dir.path());
        assert_eq!(loaded, Settings::default());
        assert!(std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with("settings.json.bak-")));
    }
}
