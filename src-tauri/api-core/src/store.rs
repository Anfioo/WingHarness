use std::path::PathBuf;
use std::sync::OnceLock;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{AppError, AppResult};

/// The API client's own data directory (`<data dir>/.api-client`), resolved once
/// at startup by the root crate. Everything the feature persists lives here, so
/// the whole directory can be moved to another machine in one step alongside
/// `ccs/` and `.git-repo/`.
pub static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the data directory, creating it on first use.
pub fn dir() -> AppResult<PathBuf> {
    let dir = CONFIG_DIR
        .get()
        .ok_or_else(|| AppError::other("the api client data directory has not been initialized"))?;
    std::fs::create_dir_all(dir)?;
    Ok(dir.clone())
}

/// Resolve a flat file name inside the data directory. Names are hard-coded in
/// our own source (or produced by [`crate::paths::workspace_file`]), but the
/// command boundary is a system boundary, so reject anything that could point
/// outside the directory.
fn path(name: &str) -> AppResult<PathBuf> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.len() > 128
    {
        return Err(AppError::other(format!("invalid store name: {name:?}")));
    }
    Ok(dir()?.join(name))
}

/// Read and parse a JSON document, or `None` when the file does not exist yet.
pub fn read_json<T: DeserializeOwned>(name: &str) -> AppResult<Option<T>> {
    let path = path(name)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)?;
    Ok(Some(serde_json::from_str(&raw)?))
}

/// Serialize `value` and write it atomically: stage to a timestamped `.tmp`
/// sibling, then `rename` over the destination (which replaces it on Windows).
/// On any failure the staging file is removed, so no leftovers remain.
pub fn write_json<T: Serialize>(name: &str, value: &T) -> AppResult<()> {
    let path = path(name)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    // The temp name carries a timestamp so two writers staging the same file
    // cannot clobber each other's staging copy. The rename is what commits.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("{nanos}.json.tmp"));
    std::fs::write(&tmp, &bytes)?;
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.into());
    }
    Ok(())
}

/// Delete a file if it exists. Missing files are not an error.
pub fn remove_file(name: &str) -> AppResult<()> {
    let path = path(name)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Sample {
        a: u32,
    }

    #[test]
    fn values_round_trip_and_leave_no_temp_files() {
        let dir = std::env::temp_dir().join(format!("api-core-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        CONFIG_DIR
            .set(dir.clone())
            .expect("no other test claims CONFIG_DIR");

        assert_eq!(read_json::<Sample>("sample.json").unwrap(), None);
        write_json("sample.json", &Sample { a: 1 }).unwrap();
        assert_eq!(read_json::<Sample>("sample.json").unwrap(), Some(Sample { a: 1 }));
        write_json("sample.json", &Sample { a: 2 }).unwrap();
        assert_eq!(read_json::<Sample>("sample.json").unwrap(), Some(Sample { a: 2 }));
        remove_file("sample.json").unwrap();
        assert_eq!(read_json::<Sample>("sample.json").unwrap(), None);

        assert!(path("../escape.json").is_err());
        assert!(path("a/b.json").is_err());

        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(leftovers.is_empty(), "leftover files: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}