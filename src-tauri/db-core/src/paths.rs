//! Where the feature keeps its files.
//!
//! Everything lives under one `db` directory below the app's data directory, so
//! moving the data directory moves the data sources, their saved passwords and
//! the query history with it. The app resolves that directory through
//! `config::dir()` and hands `<data dir>/db` to [`crate::manager::DbManager`].

use std::path::{Path, PathBuf};

/// The data sources listed in every project.
pub fn global_sources(data_dir: &Path) -> PathBuf {
    data_dir.join("data-sources.toml")
}

/// The data sources that belong to the project at `root`.
///
/// The directory name is a readable slug plus a hash of the full path: the slug
/// keeps the folder identifiable, the hash keeps two projects whose paths slug
/// the same apart.
pub fn project_sources(data_dir: &Path, root: &str) -> PathBuf {
    data_dir.join("projects").join(project_folder(root)).join("data-sources.toml")
}

fn project_folder(root: &str) -> String {
    // One separator per run of non-alphanumeric characters: `C:\work\app` and
    // `C:/work/app` name the same folder.
    let mut slug = String::new();
    for c in root.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    format!("{slug}-{:08x}", hash(root))
}

/// Saved passwords, one file for every data source.
pub fn secrets(data_dir: &Path) -> PathBuf {
    data_dir.join("secrets.json")
}

/// Query history, one file for every data source.
pub fn history(data_dir: &Path) -> PathBuf {
    data_dir.join("history.json")
}

/// FNV-1a: stable across runs and platforms, which is all the folder name needs.
fn hash(value: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in value.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two projects whose paths slug the same must still get different folders.
    #[test]
    fn project_folders_differ_when_the_slug_collides() {
        let dir = Path::new("/data");
        assert_eq!(project_sources(dir, "C:\\work\\app"), project_sources(dir, "C:\\work\\app"));
        assert_ne!(project_sources(dir, "C:\\work\\app"), project_sources(dir, "D:\\work\\app"));
        // A run of separators becomes one dash, so the slug stays readable.
        assert!(project_folder("C:\\work\\app").starts_with("c-work-app-"));
    }
}
