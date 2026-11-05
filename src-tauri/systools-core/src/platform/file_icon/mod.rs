//! Native file and application icon resolution with a PNG disk cache.
//!
//! Scans never carry image data. The UI asks for icons for the rows it is about
//! to render, and this module groups those requests by icon identity so a batch
//! resolves each distinct icon once.

mod cache;
mod windows;

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use crate::applications::models::ApplicationIcon;
use crate::filesystem::models::{
    FileIconAsset, FileIconAssignment, FileIconBatch, FileIconItemKind, FileIconMode,
    FileIconRequest,
};
use crate::platform::contracts::PlatformResult;

/// Bounds one IPC batch; the UI renders far fewer rows per viewport.
const MAX_REQUESTS: usize = 200;
const CACHE_SCHEMA: &[u8] = b"systools-file-icon-v1";

struct PreparedRequest {
    path: String,
    kind: FileIconItemKind,
    mode: FileIconMode,
    /// Stable grouping identity shared by requests that should use one asset.
    identity: String,
    /// Identity used when no icon can be resolved.
    generic_key: String,
    /// Representative path handed to the native extractor on a cache miss.
    sample: PathBuf,
    mode_code: &'static str,
}

struct IconSource {
    identity: String,
    path: PathBuf,
    mode: &'static str,
}

/// Loads icons for a batch of file and directory requests.
///
/// Every accepted request receives an assignment with a stable `icon_key`.
/// Unresolvable requests keep their generic key and simply have no asset.
pub(crate) fn load_file_icons(
    requests: &[FileIconRequest],
    cache_root: &Path,
) -> PlatformResult<FileIconBatch> {
    let mut slots = Vec::with_capacity(requests.len().min(MAX_REQUESTS));
    for request in requests.iter().take(MAX_REQUESTS) {
        let path = PathBuf::from(&request.path);
        if !path.is_absolute() {
            slots.push(None);
            continue;
        }
        slots.push(Some(prepare_request(request, &path)));
    }

    let prepared = slots.iter().flatten().collect::<Vec<_>>();
    let sources = sources_for(&prepared);
    let resolved = resolve(&sources, cache_root);

    let mut assignments = Vec::with_capacity(slots.len());
    let mut assets = Vec::new();
    let mut emitted = HashSet::new();
    for (request, slot) in requests.iter().take(MAX_REQUESTS).zip(slots) {
        match slot {
            Some(prepared) => {
                let asset = resolved.get(&prepared.identity);
                let icon_key = if asset.is_some() {
                    prepared.identity.clone()
                } else {
                    prepared.generic_key.clone()
                };
                if let Some(png) = asset {
                    if emitted.insert(prepared.identity.clone()) {
                        assets.push(FileIconAsset {
                            icon_key: prepared.identity.clone(),
                            data_url: data_url(png),
                        });
                    }
                }
                assignments.push(FileIconAssignment {
                    path: prepared.path,
                    kind: prepared.kind,
                    mode: prepared.mode,
                    icon_key,
                });
            }
            None => assignments.push(FileIconAssignment {
                path: request.path.clone(),
                kind: request.kind,
                mode: request.mode,
                icon_key: generic_key(request.kind),
            }),
        }
    }

    Ok(FileIconBatch {
        assignments,
        assets,
    })
}

/// Loads icons for application executable paths.
///
/// Only paths that resolve to an icon are returned; callers fall back to an
/// initial block for everything else.
pub(crate) fn load_application_icons(paths: &[String], cache_root: &Path) -> Vec<ApplicationIcon> {
    let cache = cache::IconCache::new(cache_root);
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for path in paths.iter().take(MAX_REQUESTS) {
        let path_buf = PathBuf::from(path);
        if !path_buf.is_absolute() || !seen.insert(path.clone()) {
            continue;
        }
        unique.push((path.clone(), path_buf));
    }

    let mut resolved = HashMap::new();
    let mut misses = Vec::new();
    for (index, (_, path)) in unique.iter().enumerate() {
        let key = cache_key(path, "application");
        match cache.lookup(&key) {
            Some(png) => {
                resolved.insert(index, png);
            }
            None => misses.push((index, path.clone(), key)),
        }
    }

    if !misses.is_empty() {
        let paths = misses
            .iter()
            .map(|(_, path, _)| path.clone())
            .collect::<Vec<_>>();
        let pngs = windows::extract_icons_png(&paths);
        for ((index, _, key), png) in misses.into_iter().zip(pngs) {
            if let Some(png) = png {
                cache.store(&key, &png);
                resolved.insert(index, png);
            }
        }
    }

    unique
        .into_iter()
        .enumerate()
        .filter_map(|(index, (path, _))| {
            resolved.get(&index).map(|png| ApplicationIcon {
                path,
                data_url: data_url(png),
            })
        })
        .collect()
}

fn prepare_request(request: &FileIconRequest, path: &Path) -> PreparedRequest {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    let path_specific = match request.mode {
        FileIconMode::Automatic => path_specific(path, request.kind, extension.as_deref()),
        FileIconMode::Generic => false,
        FileIconMode::Path => true,
    };
    let identity = if path_specific {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"systools-icon-identity-v1");
        hasher.update(normalize_source_path(path).as_bytes());
        format!("path:{}", &hasher.finalize().to_hex()[..24])
    } else if matches!(request.mode, FileIconMode::Automatic)
        && matches!(request.kind, FileIconItemKind::File)
        && extension.as_deref().is_some_and(|value| !value.is_empty())
    {
        // Ordinary documents share the icon of their extension, so a folder of
        // PDFs resolves one icon instead of one icon per file.
        format!("ext:{}", extension.unwrap_or_default())
    } else {
        generic_key(request.kind)
    };
    PreparedRequest {
        path: request.path.clone(),
        kind: request.kind,
        mode: request.mode,
        identity,
        generic_key: generic_key(request.kind),
        sample: path.to_path_buf(),
        mode_code: mode_code(request.mode),
    }
}

fn sources_for(prepared: &[&PreparedRequest]) -> Vec<IconSource> {
    let mut order = Vec::new();
    let mut chosen: HashMap<String, (PathBuf, &'static str, bool)> = HashMap::new();
    for request in prepared {
        match chosen.entry(request.identity.clone()) {
            Entry::Vacant(entry) => {
                order.push(request.identity.clone());
                entry.insert((
                    request.sample.clone(),
                    request.mode_code,
                    request.sample.exists(),
                ));
            }
            Entry::Occupied(mut entry) => {
                if !entry.get().2 && request.sample.exists() {
                    let mode = entry.get().1;
                    entry.insert((request.sample.clone(), mode, true));
                }
            }
        }
    }
    order
        .into_iter()
        .filter_map(|identity| {
            chosen
                .remove(&identity)
                .map(|(path, mode, _)| IconSource {
                    identity,
                    path,
                    mode,
                })
        })
        .collect()
}

fn resolve(sources: &[IconSource], cache_root: &Path) -> HashMap<String, Vec<u8>> {
    let cache = cache::IconCache::new(cache_root);
    let mut resolved = HashMap::new();
    let mut misses = Vec::new();
    for source in sources {
        let key = cache_key(&source.path, source.mode);
        match cache.lookup(&key) {
            Some(png) => {
                resolved.insert(source.identity.clone(), png);
            }
            None => misses.push((
                source.identity.clone(),
                source.path.clone(),
                key,
            )),
        }
    }
    if misses.is_empty() {
        return resolved;
    }

    let paths = misses
        .iter()
        .map(|(_, path, _)| path.clone())
        .collect::<Vec<_>>();
    let pngs = windows::extract_icons_png(&paths);
    for ((identity, _, key), png) in misses.into_iter().zip(pngs) {
        if let Some(png) = png {
            cache.store(&key, &png);
            resolved.insert(identity, png);
        }
    }
    resolved
}

fn generic_key(kind: FileIconItemKind) -> String {
    match kind {
        FileIconItemKind::Directory => "kind:folder".to_string(),
        FileIconItemKind::File => "kind:file".to_string(),
    }
}

fn mode_code(mode: FileIconMode) -> &'static str {
    match mode {
        FileIconMode::Automatic => "automatic",
        FileIconMode::Generic => "generic",
        FileIconMode::Path => "path",
    }
}

fn path_specific(path: &Path, kind: FileIconItemKind, extension: Option<&str>) -> bool {
    if path.parent().is_none() {
        return true;
    }
    if matches!(
        extension,
        Some(
            "exe"
                | "ico"
                | "lnk"
                | "msi"
                | "msix"
                | "msixbundle"
                | "appx"
                | "appxbundle"
                | "url"
                | "bat"
                | "cmd"
                | "ps1"
                | "scr"
                | "cpl"
        )
    ) {
        return true;
    }
    kind == FileIconItemKind::Directory && path.join("desktop.ini").is_file()
}

/// Cache identity of one source path.
///
/// Order is fixed: normalized source path, modification time, size, then mode.
fn cache_key(path: &Path, mode: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(CACHE_SCHEMA);
    hasher.update(normalize_source_path(path).as_bytes());
    if let Ok(metadata) = fs::metadata(path) {
        if let Ok(modified) = metadata.modified() {
            if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
                hasher.update(&duration.as_secs().to_le_bytes());
                hasher.update(&duration.subsec_nanos().to_le_bytes());
            }
        }
        hasher.update(&metadata.len().to_le_bytes());
    }
    hasher.update(mode.as_bytes());
    hasher.finalize().to_hex().to_string()
}

fn normalize_source_path(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = text.trim_end_matches('\\');
    let text = text.strip_prefix(r"\\?\").unwrap_or(text);
    if text.is_empty() {
        "\\".to_string()
    } else {
        text.to_ascii_lowercase()
    }
}

fn data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", BASE64.encode(png))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str, kind: FileIconItemKind, mode: FileIconMode) -> FileIconRequest {
        FileIconRequest {
            path: path.to_string(),
            kind,
            mode,
        }
    }

    #[test]
    fn ordinary_documents_share_a_type_identity() {
        let first = prepare_request(
            &request(
                r"C:\first\report.PDF",
                FileIconItemKind::File,
                FileIconMode::Automatic,
            ),
            Path::new(r"C:\first\report.PDF"),
        );
        let second = prepare_request(
            &request(
                r"C:\second\report.pdf",
                FileIconItemKind::File,
                FileIconMode::Automatic,
            ),
            Path::new(r"C:\second\report.pdf"),
        );

        assert_eq!(first.identity, "ext:pdf");
        assert_eq!(first.identity, second.identity);
    }

    #[test]
    fn executables_and_shortcuts_remain_path_specific() {
        for extension in ["exe", "lnk", "msi", "ico"] {
            let path = format!(r"C:\first\example.{extension}");
            let identity = prepare_request(
                &request(&path, FileIconItemKind::File, FileIconMode::Automatic),
                Path::new(&path),
            )
            .identity;
            assert!(
                identity.starts_with("path:"),
                "extension {extension} should stay path specific"
            );
        }
    }

    #[test]
    fn directories_share_the_folder_identity_unless_requested_otherwise() {
        let automatic = prepare_request(
            &request(
                r"C:\first\folder",
                FileIconItemKind::Directory,
                FileIconMode::Automatic,
            ),
            Path::new(r"C:\first\folder"),
        );
        let forced = prepare_request(
            &request(
                r"C:\first\folder",
                FileIconItemKind::Directory,
                FileIconMode::Path,
            ),
            Path::new(r"C:\first\folder"),
        );

        assert_eq!(automatic.identity, "kind:folder");
        assert!(forced.identity.starts_with("path:"));
    }

    #[test]
    fn source_paths_are_normalized_case_and_separator_insensitively() {
        assert_eq!(
            normalize_source_path(Path::new(r"C:\Program Files\App.EXE")),
            normalize_source_path(Path::new("c:/program files/app.exe"))
        );
        assert_eq!(
            normalize_source_path(Path::new(r"\\?\C:\Folder")),
            r"c:\folder"
        );
    }

    #[test]
    fn cache_keys_change_with_content_and_mode() {
        let root = std::env::temp_dir().join(format!(
            "systools-icon-key-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&root).expect("fixture root must be created");
        let file = root.join("fixture.bin");
        fs::write(&file, b"first").expect("fixture must be written");

        let first = cache_key(&file, "automatic");
        assert_eq!(first, cache_key(&file, "automatic"));
        assert_ne!(first, cache_key(&file, "path"));

        fs::write(&file, b"second-and-longer").expect("fixture must change");
        assert_ne!(first, cache_key(&file, "automatic"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_paths_still_receive_a_stable_generic_assignment() {
        let cache_root = std::env::temp_dir().join(format!(
            "systools-icon-batch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        let missing = std::env::temp_dir().join("systools-icon-missing-fixture.pdf");
        let requests = vec![
            request(
                &missing.to_string_lossy(),
                FileIconItemKind::File,
                FileIconMode::Automatic,
            ),
            request("relative.pdf", FileIconItemKind::File, FileIconMode::Generic),
        ];

        let batch = load_file_icons(&requests, &cache_root).expect("the batch must not fail");

        assert_eq!(batch.assignments.len(), 2);
        assert_eq!(batch.assignments[0].icon_key, "kind:file");
        assert_eq!(batch.assignments[1].icon_key, "kind:file");
        assert!(batch.assets.is_empty());
        let _ = fs::remove_dir_all(cache_root);
    }

    #[test]
    fn application_icons_ignore_relative_paths() {
        let cache_root = std::env::temp_dir().join(format!(
            "systools-app-icon-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        let icons = load_application_icons(&["relative.exe".to_string()], &cache_root);
        assert!(icons.is_empty());
        let _ = fs::remove_dir_all(cache_root);
    }
}
