// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See UPSTREAM.md for the porting record.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::models::MoinSettings;

fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("settings.json")
}

pub(crate) fn load(data_dir: &Path) -> MoinSettings {
    let file = path(data_dir);
    let Ok(bytes) = fs::read(&file) else {
        return MoinSettings::default();
    };
    match serde_json::from_slice::<MoinSettings>(&bytes) {
        Ok(mut settings) => {
            let _ = settings.validate();
            settings
        }
        Err(error) => {
            let backup = file.with_file_name(format!(
                "settings.json.bak-{}",
                crate::models::now_ms().div_euclid(1000)
            ));
            if let Err(rename_error) = fs::rename(&file, &backup) {
                log::warn!("Could not back up invalid moin settings: {rename_error}");
            }
            log::warn!("Invalid moin settings were replaced with defaults: {error}");
            MoinSettings::default()
        }
    }
}

pub(crate) fn save(data_dir: &Path, settings: &MoinSettings) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| error.to_string())?;
    let target = path(data_dir);
    let temporary = data_dir.join("settings.json.tmp");
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    fs::rename(&temporary, &target).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{load, save};
    use crate::models::MoinSettings;

    #[test]
    fn settings_round_trip_with_defaults_for_new_fields() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = MoinSettings::default();
        settings.max_concurrent = 7;
        save(dir.path(), &settings).unwrap();
        let loaded = load(dir.path());
        assert_eq!(loaded.max_concurrent, 7);
        assert_eq!(loaded.http_backend, "embedded");
    }

    #[test]
    fn invalid_settings_are_backed_up_and_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "{").unwrap();
        let loaded = load(dir.path());
        assert_eq!(loaded, MoinSettings::default());
        assert!(std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with("settings.json.bak-")));
    }
}
