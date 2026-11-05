use std::path::PathBuf;

use crate::error::{AppError, AppResult};

/// The git engine's own data directory (`<data dir>/.git-repo`), resolved once at
/// startup and shared with [`crate::accounts`]. Everything the git feature
/// persists goes here, so the whole directory can be moved to another machine in
/// one step alongside `ccs/` and `.mcphub/`.
fn dir() -> AppResult<PathBuf> {
    let dir = crate::accounts::CONFIG_DIR
        .get()
        .ok_or_else(|| AppError::other("the git data directory has not been initialized"))?;
    std::fs::create_dir_all(dir)?;
    Ok(dir.clone())
}

/// Keys are hard-coded in our own source, but the command boundary is a system
/// boundary — reject anything that could point outside the directory.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn path(key: &str) -> AppResult<PathBuf> {
    if !valid_key(key) {
        return Err(AppError::other(format!("invalid store key: {key:?}")));
    }
    Ok(dir()?.join(format!("{key}.json")))
}

pub fn read(key: &str) -> AppResult<Option<String>> {
    let path = path(key)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read_to_string(path)?))
}

pub fn write(key: &str, value: &str) -> AppResult<()> {
    let path = path(key)?;
    // The temp name carries a timestamp so two windows writing the same key
    // cannot clobber each other's staging file. The rename is what commits, and
    // it replaces the destination on Windows.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("{nanos}.json.tmp"));
    std::fs::write(&tmp, value)?;
    if let Err(error) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.into());
    }
    Ok(())
}

pub fn remove(key: &str) -> AppResult<()> {
    let path = path(key)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_keys_are_flat_slugs() {
        assert!(valid_key("git-settings"));
        assert!(valid_key("git-repo-shortcuts"));
        assert!(valid_key("a1"));
        assert!(!valid_key(""));
        assert!(!valid_key(".."));
        assert!(!valid_key("a/b"));
        assert!(!valid_key("a\\b"));
        assert!(!valid_key("Git-Settings"));
        assert!(!valid_key("git settings"));
        assert!(!valid_key(&"x".repeat(65)));
    }

    #[test]
    fn values_round_trip_and_leave_no_temp_files() {
        let dir = std::env::temp_dir().join(format!("git-core-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        crate::accounts::CONFIG_DIR
            .set(dir.clone())
            .expect("no other test claims CONFIG_DIR");

        assert_eq!(read("git-settings").unwrap(), None);
        write("git-settings", "{\"a\":1}").unwrap();
        assert_eq!(read("git-settings").unwrap().as_deref(), Some("{\"a\":1}"));
        // A second write replaces the first rather than leaving both behind.
        write("git-settings", "{\"a\":2}").unwrap();
        assert_eq!(read("git-settings").unwrap().as_deref(), Some("{\"a\":2}"));
        remove("git-settings").unwrap();
        assert_eq!(read("git-settings").unwrap(), None);

        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(leftovers.is_empty(), "leftover files: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
