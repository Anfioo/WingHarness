use crate::error::{SystoolsError, SystoolsResult};
use crate::models::SystoolsPrefs;
use crate::paths;

/// Load the persisted preferences.
///
/// A missing file is not an error: it means the user has not customized
/// anything yet, so the defaults apply.
pub fn get() -> SystoolsResult<SystoolsPrefs> {
    let path = paths::prefs_path()?;
    if !path.exists() {
        return Ok(SystoolsPrefs::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|error| {
        log::warn!(
            "systools_prefs_read_failed path={} error={error}",
            path.display()
        );
        SystoolsError::persistence("prefs")
    })?;
    let prefs = serde_json::from_str(&raw).map_err(|error| {
        log::warn!(
            "systools_prefs_parse_failed path={} error={error}",
            path.display()
        );
        SystoolsError::persistence("prefs")
    })?;
    log::info!("systools_prefs_loaded path={}", path.display());
    Ok(prefs)
}

/// Persist preferences atomically.
///
/// The document is staged to a sibling `.tmp` file and renamed over the
/// destination, so an interrupted write never leaves a partially written
/// preferences file behind.
pub fn set(prefs: SystoolsPrefs) -> SystoolsResult<()> {
    let path = paths::prefs_path()?;
    let directory = path
        .parent()
        .ok_or_else(|| SystoolsError::persistence("prefs"))?;
    std::fs::create_dir_all(directory).map_err(|error| {
        log::warn!(
            "systools_prefs_directory_create_failed path={} error={error}",
            directory.display()
        );
        SystoolsError::persistence("prefs")
    })?;

    let bytes = serde_json::to_vec_pretty(&prefs).map_err(|error| {
        log::warn!("systools_prefs_serialize_failed error={error}");
        SystoolsError::persistence("prefs")
    })?;
    let staging = path.with_extension("json.tmp");
    std::fs::write(&staging, &bytes).map_err(|error| {
        log::warn!(
            "systools_prefs_stage_failed path={} error={error}",
            staging.display()
        );
        SystoolsError::persistence("prefs")
    })?;
    if let Err(error) = std::fs::rename(&staging, &path) {
        let _ = std::fs::remove_file(&staging);
        log::warn!(
            "systools_prefs_commit_failed path={} error={error}",
            path.display()
        );
        return Err(SystoolsError::persistence("prefs"));
    }
    log::info!("systools_prefs_saved path={}", path.display());
    Ok(())
}
