// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! `settings.json`: defaults, atomic writes and the corrupt-file fallback.
//!
//! A hand-edited file must never keep the app from starting, so an unreadable
//! document is renamed to `settings.json.bak-<unix seconds>` and replaced by the
//! defaults instead of being deleted.

use std::path::{Path, PathBuf};

use crate::error::{MoinError, MoinResult};
use crate::models::Settings;
use crate::paths;

fn path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

/// What a fresh install starts with. `rpc_token` stays empty here: the engine
/// mints a UUIDv4 on first launch and writes it back.
pub fn defaults() -> Settings {
    Settings::default()
}

impl Settings {
    /// Read the document, falling back to the defaults. A missing file is the
    /// normal first run; a file that does not parse is backed up first.
    pub fn load(dir: &Path) -> Self {
        let file = path(dir);
        let bytes = match std::fs::read(&file) {
            Ok(bytes) => bytes,
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("Could not read moin settings at {}: {error}", file.display());
                }
                return defaults();
            }
        };
        match serde_json::from_slice::<Settings>(&bytes) {
            Ok(settings) => settings,
            Err(error) => {
                paths::backup_corrupt(&file);
                log::warn!(
                    "Replaced unreadable moin settings at {} with the defaults (line {}, column {}).",
                    file.display(),
                    error.line(),
                    error.column()
                );
                defaults()
            }
        }
    }

    /// Write through `paths::write_atomic`. Values are stored exactly as they
    /// are, so a hand-edited `progress_flush_ms` survives a save; only
    /// `progress_flush_interval` clamps it on read.
    pub fn save(&self, dir: &Path) -> MoinResult<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| {
            MoinError::internal(format!("Could not encode the moin settings: {error}"))
        })?;
        paths::write_atomic(&path(dir), &bytes)
    }
}

/// `engine.rs` reads and writes settings through these names; they are the same
/// two functions as the inherent methods above.
pub(crate) fn load(dir: &Path) -> Settings {
    Settings::load(dir)
}

pub(crate) fn save(dir: &Path, settings: &Settings) -> MoinResult<()> {
    settings.save(dir)
}

#[cfg(test)]
mod tests {
    use super::{defaults, load, Settings};
    use std::path::Path;

    fn backed_up(dir: &Path) -> bool {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with("settings.json.bak-"))
    }

    #[test]
    fn defaults_match_the_documented_first_run() {
        let settings = defaults();
        assert_eq!(settings.max_concurrent, 4);
        assert_eq!(settings.connections, 8);
        assert_eq!(settings.min_split_size, 1 << 20);
        assert!(!settings.hide_part_files);
        assert_eq!(settings.stall_timeout_secs, 60);
        assert_eq!(settings.connect_timeout_secs, 30);
        assert_eq!(settings.download_dir, None);
        assert_eq!(settings.aria2_path, None);
        assert!(settings.rpc_enabled);
        assert_eq!(settings.rpc_port, 47653);
        assert!(settings.rpc_token.is_empty());
        assert!(settings.notify_on_complete);
        assert!(!settings.add_paused);
        assert_eq!(settings.progress_flush_ms, 250);
    }

    #[test]
    fn saves_and_loads_every_field() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings {
            max_concurrent: 7,
            connections: 4,
            min_split_size: 4096,
            hide_part_files: true,
            stall_timeout_secs: 0,
            connect_timeout_secs: 5,
            download_dir: Some("D:/Downloads".to_string()),
            http_backend: "aria2".to_string(),
            aria2_path: Some("C:/tools/aria2c.exe".to_string()),
            rpc_enabled: false,
            rpc_port: 50000,
            rpc_token: "token".to_string(),
            notify_on_complete: false,
            add_paused: true,
            progress_flush_ms: 750,
        };
        settings.save(dir.path()).unwrap();
        assert_eq!(Settings::load(dir.path()), settings);
        assert_eq!(load(dir.path()), settings);
    }

    #[test]
    fn invalid_json_is_backed_up_and_replaced_by_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "{ \"max_concurrent\": ").unwrap();
        assert_eq!(load(dir.path()), defaults());
        assert!(backed_up(dir.path()));
        assert!(!dir.path().join("settings.json").exists());
    }

    #[test]
    fn missing_file_falls_back_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Settings::load(dir.path()), defaults());
        assert!(!dir.path().join("settings.json").exists());
        assert!(!backed_up(dir.path()));
    }

    #[test]
    fn progress_flush_interval_clamps_and_save_keeps_the_raw_value() {
        for (stored, expected) in [(99u64, 100u64), (5_001, 5_000), (0, 100), (250, 250)] {
            let settings = Settings {
                progress_flush_ms: stored,
                ..Default::default()
            };
            assert_eq!(
                settings.progress_flush_interval().as_millis() as u64,
                expected,
                "progress_flush_ms = {stored}"
            );
        }

        let dir = tempfile::tempdir().unwrap();
        let settings = Settings {
            progress_flush_ms: 99,
            ..Default::default()
        };
        settings.save(dir.path()).unwrap();
        let written = std::fs::read_to_string(dir.path().join("settings.json")).unwrap();
        assert!(written.contains("\"progress_flush_ms\": 99"));
        assert_eq!(Settings::load(dir.path()).progress_flush_ms, 99);
    }

    #[test]
    fn unknown_keys_are_ignored_and_missing_keys_take_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            "{ \"version\": 1, \"connections\": 3 }",
        )
        .unwrap();
        let settings = load(dir.path());
        assert_eq!(settings.connections, 3);
        assert_eq!(settings.max_concurrent, defaults().max_concurrent);
    }
}
