// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! The global `settings.json` document under `<data dir>/one-mail`.
//!
//! The database does not hold these values: they are small, they are read on the
//! first paint of the settings window, and the page needs them before a synced
//! mailbox exists. The file is written through `paths::write_atomic`, and a file
//! that cannot be parsed — or that holds values this build refuses to save — is
//! moved aside as `settings.json.bak-<unix seconds>` and replaced by the
//! defaults, so hand-editing cannot wedge the page on a parse error.

use std::fs;
use std::path::Path;

use crate::error::{OneMailError, OneMailResult};
use crate::models::OneMailSettings;
use crate::paths;

/// The only settings version this build writes and accepts.
const SETTINGS_VERSION: u32 = 1;
const MIN_REFRESH_MINUTES: u32 = 1;
const MAX_REFRESH_MINUTES: u32 = 1440;
const MIN_SYNC_WINDOW_DAYS: u32 = 1;
const MAX_SYNC_WINDOW_DAYS: u32 = 3650;

const FILE_NAME: &str = "settings.json";

/// Read the settings, creating the document on first use and recovering from a
/// damaged one.
pub fn read() -> OneMailResult<OneMailSettings> {
    let directory = paths::ensure_dir()?;
    read_at(&directory.join(FILE_NAME))
}

/// Validate and persist the document, returning the copy that was written.
pub fn write(settings: &OneMailSettings) -> OneMailResult<OneMailSettings> {
    validate(settings)?;
    let directory = paths::ensure_dir()?;
    write_at(&directory.join(FILE_NAME), settings)?;
    Ok(settings.clone())
}

/// Reject values the app cannot honour. The two enums (`bodyDisplayMode`,
/// `remoteImagesPolicy`) only ever hold a known variant, so the ranges and the
/// document version are all that is left to check.
pub fn validate(settings: &OneMailSettings) -> OneMailResult<()> {
    if settings.version != SETTINGS_VERSION {
        return Err(OneMailError::invalid_input(
            "version",
            format!("Only settings version {SETTINGS_VERSION} is supported."),
        ));
    }
    if !(MIN_REFRESH_MINUTES..=MAX_REFRESH_MINUTES).contains(&settings.refresh_interval_minutes) {
        return Err(OneMailError::invalid_input(
            "refreshIntervalMinutes",
            format!(
                "The refresh interval must be between {MIN_REFRESH_MINUTES} and \
                 {MAX_REFRESH_MINUTES} minutes."
            ),
        ));
    }
    if !(MIN_SYNC_WINDOW_DAYS..=MAX_SYNC_WINDOW_DAYS).contains(&settings.sync_window_days) {
        return Err(OneMailError::invalid_input(
            "syncWindowDays",
            format!(
                "The sync window must be between {MIN_SYNC_WINDOW_DAYS} and \
                 {MAX_SYNC_WINDOW_DAYS} days."
            ),
        ));
    }
    Ok(())
}

fn read_at(path: &Path) -> OneMailResult<OneMailSettings> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A fresh install starts with defaults, and the file exists from the
            // first read so the settings window has something to show.
            return reset_to_defaults(path);
        }
        Err(error) => {
            log::warn!(
                "one_mail_settings_read_failed path={} error={error}",
                path.display()
            );
            paths::backup_corrupt(path);
            return reset_to_defaults(path);
        }
    };

    let settings = match serde_json::from_slice::<OneMailSettings>(&bytes) {
        Ok(settings) => settings,
        Err(error) => {
            log::warn!(
                "one_mail_settings_parse_failed path={} error={error}",
                path.display()
            );
            paths::backup_corrupt(path);
            return reset_to_defaults(path);
        }
    };

    // A file from a newer build, or one edited by hand into a range this build
    // refuses: keep the bytes for support and fall back to the defaults.
    if let Err(error) = validate(&settings) {
        log::warn!(
            "one_mail_settings_invalid path={} code={:?} message={}",
            path.display(),
            error.code,
            error.message
        );
        paths::backup_corrupt(path);
        return reset_to_defaults(path);
    }

    Ok(settings)
}

fn write_at(path: &Path, settings: &OneMailSettings) -> OneMailResult<()> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(|error| {
        log::warn!("one_mail_settings_encode_failed error={error}");
        OneMailError::internal("The mail settings could not be written.")
    })?;
    paths::write_atomic(path, &bytes)
}

/// Write the defaults over whatever is (or is not) at `path`.
fn reset_to_defaults(path: &Path) -> OneMailResult<OneMailSettings> {
    let defaults = OneMailSettings::default();
    write_at(path, &defaults)?;
    Ok(defaults)
}

#[cfg(test)]
mod tests {
    use super::{read_at, validate, write_at};
    use crate::models::{BodyDisplayMode, OneMailSettings, RemoteImagesPolicy};

    fn settings_path(directory: &tempfile::TempDir) -> std::path::PathBuf {
        directory.path().join("settings.json")
    }

    /// `OneMailSettings` carries no `PartialEq` (the DTO is frozen), so the
    /// comparisons below go field by field.
    fn same(left: &OneMailSettings, right: &OneMailSettings) -> bool {
        left.version == right.version
            && left.refresh_interval_minutes == right.refresh_interval_minutes
            && left.body_display_mode == right.body_display_mode
            && left.remote_images_policy == right.remote_images_policy
            && left.sync_window_days == right.sync_window_days
            && left.notify_on_new_mail == right.notify_on_new_mail
    }

    #[test]
    fn a_missing_document_falls_back_to_the_defaults_and_is_written() {
        let directory = tempfile::tempdir().unwrap();
        let path = settings_path(&directory);

        let settings = read_at(&path).unwrap();

        assert_eq!(settings.version, 1);
        assert_eq!(settings.refresh_interval_minutes, 5);
        assert_eq!(settings.body_display_mode, BodyDisplayMode::Html);
        assert_eq!(settings.remote_images_policy, RemoteImagesPolicy::Block);
        assert_eq!(settings.sync_window_days, 90);
        assert!(settings.notify_on_new_mail);
        assert!(path.exists());
    }

    #[test]
    fn a_written_document_reads_back_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let path = settings_path(&directory);
        let settings = OneMailSettings {
            version: 1,
            refresh_interval_minutes: 15,
            body_display_mode: BodyDisplayMode::Text,
            remote_images_policy: RemoteImagesPolicy::Load,
            sync_window_days: 30,
            notify_on_new_mail: false,
        };

        write_at(&path, &settings).unwrap();

        assert!(same(&read_at(&path).unwrap(), &settings));
        // The atomic write stages through `settings.json.tmp`; nothing may be
        // left behind next to the document.
        assert!(!path.with_file_name("settings.json.tmp").exists());
    }

    #[test]
    fn rejects_out_of_range_values_and_an_unknown_version() {
        let mut settings = OneMailSettings::default();

        settings.refresh_interval_minutes = 0;
        assert!(validate(&settings).is_err());

        settings.refresh_interval_minutes = 1441;
        assert!(validate(&settings).is_err());

        settings.refresh_interval_minutes = 1440;
        settings.sync_window_days = 0;
        assert!(validate(&settings).is_err());

        settings.sync_window_days = 3651;
        assert!(validate(&settings).is_err());

        settings.sync_window_days = 3650;
        settings.version = 2;
        assert!(validate(&settings).is_err());

        settings.version = 1;
        assert!(validate(&settings).is_ok());
    }

    #[test]
    fn write_refuses_an_invalid_document() {
        let settings = OneMailSettings {
            refresh_interval_minutes: 0,
            ..OneMailSettings::default()
        };

        // `write` validates before it resolves the data directory, so an invalid
        // document is refused without the file being touched.
        assert_eq!(
            super::write(&settings).unwrap_err().code,
            crate::error::OneMailErrorCode::InvalidInput
        );
    }

    #[test]
    fn a_corrupt_document_is_backed_up_and_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let path = settings_path(&directory);
        std::fs::write(&path, b"{ this is not json").unwrap();

        let settings = read_at(&path).unwrap();

        assert!(same(&settings, &OneMailSettings::default()));
        // The damaged bytes were kept, under a timestamped name.
        let backups: Vec<_> = std::fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("settings.json.bak-"))
            .collect();
        assert_eq!(
            backups.len(),
            1,
            "expected exactly one backup, got {backups:?}"
        );
        assert!(path.exists(), "the defaults must be written back");
    }

    #[test]
    fn a_document_with_an_impossible_value_is_replaced_by_the_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = settings_path(&directory);
        std::fs::write(
            &path,
            br#"{"version":1,"refreshIntervalMinutes":0,"bodyDisplayMode":"html",
                 "remoteImagesPolicy":"block","syncWindowDays":90,"notifyOnNewMail":true}"#,
        )
        .unwrap();

        let settings = read_at(&path).unwrap();

        assert_eq!(settings.refresh_interval_minutes, 5);
    }
}
