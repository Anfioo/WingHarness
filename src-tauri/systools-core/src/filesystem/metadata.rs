use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::platform::contracts::{current_platform, diagnostics, Platform};

pub(crate) struct MetadataFingerprintEntry {
    sort_key: Vec<u8>,
    digest: [u8; 32],
}

/// Reads no-follow metadata for initial discovery, never for destructive preflight.
/// Windows directory records already contain file facts. Directories retain a live query before
/// descent so a directory replaced by a junction after enumeration is still rejected.
pub(crate) fn scan_entry_metadata(
    entry: &fs::DirEntry,
    path: &Path,
) -> std::io::Result<fs::Metadata> {
    let metadata = entry.metadata()?;
    if metadata.is_dir() {
        fs::symlink_metadata(path)
    } else {
        Ok(metadata)
    }
}

pub(crate) fn metadata_fingerprint_entry(
    path: &Path,
    metadata: &fs::Metadata,
    child_fingerprint: Option<[u8; 32]>,
) -> Option<MetadataFingerprintEntry> {
    // A path and size alone cannot detect an equal-sized replacement when the
    // modification time is unavailable. Mark the snapshot incomplete instead
    // of publishing a weak fingerprint.
    let modified_at_nanos = metadata.modified().ok().and_then(system_time_nanos)?;
    let sort_key = path
        .file_name()
        .map(path_component_bytes)
        .unwrap_or_default();
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"mangodisk-metadata-entry-v1");
    hasher.update(&(sort_key.len() as u64).to_le_bytes());
    hasher.update(&sort_key);
    hasher.update(&[if metadata.is_dir() { 2 } else { 1 }]);
    hasher.update(&metadata.len().to_le_bytes());
    hasher.update(&modified_at_nanos.to_le_bytes());
    match child_fingerprint {
        Some(value) => {
            hasher.update(&[1]);
            hasher.update(&value);
        }
        None => {
            hasher.update(&[0]);
        }
    }
    Some(MetadataFingerprintEntry {
        sort_key,
        digest: *hasher.finalize().as_bytes(),
    })
}

pub(crate) fn finalize_metadata_fingerprint(
    mut entries: Vec<MetadataFingerprintEntry>,
) -> [u8; 32] {
    // read_dir does not guarantee ordering. Sort by the original file-name
    // bytes so filesystem-specific traversal order cannot produce a false
    // content-change result.
    entries.sort_unstable_by(|left, right| {
        left.sort_key
            .cmp(&right.sort_key)
            .then_with(|| left.digest.cmp(&right.digest))
    });
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"mangodisk-metadata-directory-v1");
    hasher.update(&(entries.len() as u64).to_le_bytes());
    for entry in entries {
        hasher.update(&entry.digest);
    }
    *hasher.finalize().as_bytes()
}

pub(crate) fn display_fingerprint(fingerprint: [u8; 32]) -> String {
    blake3::Hash::from_bytes(fingerprint).to_hex().to_string()
}

fn system_time_nanos(time: SystemTime) -> Option<u128> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_nanos())
}

fn path_component_bytes(value: &std::ffi::OsStr) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    value
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>()
}

/// Scans and cleanup reject link-like entries and nonresident cloud placeholders.
///
/// Links can escape into user data or another volume. Cloud placeholders can fetch remote content
/// when opened, so the same platform safety boundary prevents background scans from materializing
/// files that the user intentionally kept online-only.
pub(crate) fn is_link_like(metadata: &fs::Metadata) -> bool {
    current_platform().is_link_like(metadata)
}

pub(crate) fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

pub(crate) fn latest_timestamp(current: Option<u64>, candidate: Option<u64>) -> Option<u64> {
    match (current, candidate) {
        (Some(current), Some(candidate)) => Some(current.max(candidate)),
        (current, candidate) => current.or(candidate),
    }
}

/// Preserves the operating system path representation for internal identity comparisons.
/// Windows canonical paths may retain their verbatim prefix here; public results must use
/// `display_path` so adapters never receive mixed representations for the same scan.
pub(crate) fn native_path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub(crate) fn display_path(path: &Path) -> String {
    current_platform().display_path(path)
}

/// Keep the full target path: identical filenames in different directories are
/// common, and a hash cannot tell support which target failed. Never use this
/// diagnostic representation for filesystem access or identity comparisons.
pub fn diagnostic_path(path: &Path) -> String {
    diagnostics::text(&display_path(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_entry_metadata_does_not_follow_directory_links() {
        let root = tempfile::tempdir().expect("create metadata fixture");
        let target = root.path().join("target");
        let link = root.path().join("linked");
        fs::create_dir(&target).expect("create physical target");
        {
            let output = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&link)
                .arg(&target)
                .output()
                .expect("create directory junction");
            assert!(
                output.status.success(),
                "fixture junction creation must succeed"
            );
        }
        let entry = fs::read_dir(root.path())
            .expect("enumerate metadata fixture")
            .map(Result::unwrap)
            .find(|entry| entry.path() == link)
            .expect("directory link must be enumerated");
        let metadata = scan_entry_metadata(&entry, &link).expect("inspect directory entry");
        assert!(
            is_link_like(&metadata),
            "discovery must retain the no-follow boundary"
        );
        fs::remove_dir(&link).expect("remove fixture junction without following its target");
    }

    #[test]
    fn scan_revalidates_a_directory_replaced_by_a_junction_after_enumeration() {
        let root = tempfile::tempdir().expect("create directory replacement fixture");
        let directory = root.path().join("directory");
        let target = root.path().join("target");
        fs::create_dir(&directory).expect("create enumerated directory");
        fs::create_dir(&target).expect("create junction target");
        let entry = fs::read_dir(root.path())
            .expect("enumerate fixture")
            .map(Result::unwrap)
            .find(|entry| entry.path() == directory)
            .expect("physical directory must be enumerated");
        fs::remove_dir(&directory).expect("remove physical directory");
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&directory)
            .arg(&target)
            .output()
            .expect("replace directory with a junction");
        assert!(
            output.status.success(),
            "fixture junction creation must succeed"
        );
        let metadata =
            scan_entry_metadata(&entry, &directory).expect("revalidate enumerated directory");
        assert!(
            is_link_like(&metadata),
            "cached directory attributes must not authorize descent"
        );
        fs::remove_dir(&directory).expect("remove replacement junction");
    }

    #[test]
    fn display_paths_remove_windows_verbatim_prefixes() {
        assert_eq!(
            native_path_string(Path::new(r"\\?\C:\fixture\sample.bin")),
            r"\\?\C:\fixture\sample.bin"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\C:\fixture\sample.bin")),
            r"C:\fixture\sample.bin"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\unc\server\share\sample.bin")),
            r"\\server\share\sample.bin"
        );
    }

    #[test]
    fn diagnostic_paths_identify_the_target_and_escape_record_boundaries() {
        let first = diagnostic_path(Path::new("/fixture/first/Cache"));
        let second = diagnostic_path(Path::new("/fixture/second/Cache"));
        assert!(first.contains("/fixture/first/Cache"));
        assert!(second.contains("/fixture/second/Cache"));
        assert_ne!(first, second);
        assert!(!diagnostic_path(Path::new("/fixture/line\nbreak")).contains('\n'));
    }
}
