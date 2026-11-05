//! PNG disk cache for resolved file and application icons.
//!
//! The layout and maintenance policy are ported from the reference
//! implementation: a flat directory of `<key>.png` files, atomic writes, a
//! bounded file count, and a throttled prune pass so an icon batch does not
//! walk the whole cache every time.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
// Maintenance is throttled, so this target can be exceeded by icons written
// between maintenance passes and is restored on the next pass.
const MAX_CACHE_FILES: usize = 512;
const MAX_PNG_BYTES: u64 = 1024 * 1024;
const CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAINTENANCE_MARKER_FILE_NAME: &str = ".maintenance-v1";
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(60);

pub(super) struct IconCache {
    root: Option<PathBuf>,
}

impl IconCache {
    pub(super) fn new(root: &Path) -> Self {
        let root = match fs::create_dir_all(root) {
            Ok(()) => Some(root.to_path_buf()),
            Err(error) => {
                log::warn!(
                    "systools_icon_cache_unavailable path={} error={error}",
                    root.display()
                );
                None
            }
        };
        let cache = Self { root };
        cache.prune_if_due();
        cache
    }

    pub(super) fn lookup(&self, key: &str) -> Option<Vec<u8>> {
        let root = self.root.as_ref()?;
        let path = root.join(format!("{key}.png"));
        let metadata = fs::metadata(&path).ok()?;
        let modified = metadata.modified().ok()?;
        let fresh = SystemTime::now()
            .duration_since(modified)
            .map(|age| age <= CACHE_MAX_AGE)
            .unwrap_or(false);
        if !metadata.is_file() || metadata.len() > MAX_PNG_BYTES || !fresh {
            let _ = fs::remove_file(&path);
            return None;
        }
        let bytes = fs::read(&path).ok()?;
        if !valid_png(&bytes) {
            let _ = fs::remove_file(path);
            return None;
        }
        Some(bytes)
    }

    pub(super) fn store(&self, key: &str, png: &[u8]) {
        let Some(root) = &self.root else {
            return;
        };
        if !valid_png(png) {
            return;
        }
        let destination = root.join(format!("{key}.png"));
        if destination.is_file() {
            return;
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let temporary = root.join(format!(".{key}-{}-{nonce}.tmp", std::process::id()));
        if let Err(error) =
            fs::write(&temporary, png).and_then(|_| fs::rename(&temporary, destination))
        {
            let _ = fs::remove_file(temporary);
            log::debug!("systools_icon_cache_write_failed error={error}");
        }
    }

    fn prune_if_due(&self) {
        let Some(root) = &self.root else {
            return;
        };
        let marker = root.join(MAINTENANCE_MARKER_FILE_NAME);
        let maintenance_is_fresh = fs::metadata(&marker)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age < MAINTENANCE_INTERVAL);
        if maintenance_is_fresh {
            return;
        }

        self.prune();
        // The marker avoids a full directory walk for every icon IPC batch.
        // If writing it fails, later requests safely prune more often instead
        // of stopping maintenance indefinitely.
        if let Err(error) = fs::write(marker, []) {
            log::debug!("systools_icon_cache_maintenance_marker_failed error={error}");
        }
    }

    fn prune(&self) {
        let Some(root) = &self.root else {
            return;
        };
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        let now = SystemTime::now();
        let mut cached_files = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                if path.extension().is_none_or(|extension| extension != "png") {
                    return None;
                }
                let metadata = entry.metadata().ok()?;
                let modified = metadata.modified().ok()?;
                let expired = now
                    .duration_since(modified)
                    .map(|age| age > CACHE_MAX_AGE)
                    .unwrap_or(true);
                if expired || metadata.len() > MAX_PNG_BYTES {
                    let _ = fs::remove_file(path);
                    return None;
                }
                Some((modified, path))
            })
            .collect::<Vec<_>>();
        if cached_files.len() <= MAX_CACHE_FILES {
            return;
        }
        cached_files.sort_by_key(|(modified, _)| *modified);
        let remove_count = cached_files.len() - MAX_CACHE_FILES;
        for (_, path) in cached_files.into_iter().take(remove_count) {
            if let Err(error) = fs::remove_file(path) {
                log::debug!("systools_icon_cache_prune_failed error={error}");
            }
        }
    }
}

/// Validates the PNG chunk structure rather than trusting the file extension.
pub(super) fn valid_png(bytes: &[u8]) -> bool {
    if !bytes.starts_with(PNG_SIGNATURE) || bytes.len() as u64 > MAX_PNG_BYTES {
        return false;
    }

    let mut offset = PNG_SIGNATURE.len();
    let mut first_chunk = true;
    while offset.checked_add(12).is_some_and(|end| end <= bytes.len()) {
        let length = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as usize;
        let chunk_end = match offset
            .checked_add(12)
            .and_then(|base| base.checked_add(length))
        {
            Some(end) if end <= bytes.len() => end,
            _ => return false,
        };
        let kind = &bytes[offset + 4..offset + 8];
        if first_chunk && (kind != b"IHDR" || length != 13) {
            return false;
        }
        if kind == b"IEND" {
            return length == 0 && chunk_end == bytes.len();
        }
        first_chunk = false;
        offset = chunk_end;
    }
    false
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn fixture_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        std::env::temp_dir().join(format!(
            "systools-icon-cache-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn minimal_png() -> &'static [u8] {
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\
          \x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\
          \x1f\x15\xc4\x89\x00\x00\x00\x00IEND\xaeB`\x82"
    }

    #[test]
    fn truncated_png_is_not_a_cache_hit() {
        let mut truncated = PNG_SIGNATURE.to_vec();
        truncated.extend_from_slice(b"not-a-complete-png");
        assert!(!valid_png(&truncated));
        assert!(valid_png(minimal_png()));
    }

    #[test]
    fn invalid_cache_entry_is_removed_before_refresh() {
        let root = fixture_root("invalid");
        let cache = IconCache::new(&root);
        let path = root.join("fixture.png");
        fs::write(&path, PNG_SIGNATURE).expect("invalid fixture must be writable");

        assert!(cache.lookup("fixture").is_none());
        assert!(!path.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stored_png_is_returned_by_the_next_lookup() {
        let root = fixture_root("hit");
        let cache = IconCache::new(&root);
        cache.store("fixture", minimal_png());

        assert_eq!(cache.lookup("fixture").as_deref(), Some(minimal_png()));
        let _ = fs::remove_dir_all(root);
    }
}
