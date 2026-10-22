//! What the preview page knows about a file before it reads a byte of it.

use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::confine;
use crate::mime::{extension, guess_mime, is_previewable};
use crate::PREVIEW_MAX_BYTES;

/// A file's identity and how the preview should treat it.
///
/// `path` is the `/`-rooted form the tree already speaks, so the page can hand
/// it straight back to `preview_bytes`. `modified` is unix seconds, the unit
/// the shared `formatTime` helper multiplies by 1000.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewMeta {
    pub path: String,
    pub name: String,
    pub extension: Option<String>,
    pub mime: String,
    pub size: u64,
    pub modified: Option<u64>,
    /// Whether the frontend registry has a viewer for this extension.
    pub previewable: bool,
    /// Past the read cap: the page says so instead of invoking the read.
    pub over_cap: bool,
}

/// Reads a file's metadata, refusing anything outside the working copy.
pub fn metadata_at(root: &Path, relative: &str) -> Result<PreviewMeta, String> {
    let target = confine::resolve(root, relative)?;
    let metadata =
        std::fs::metadata(&target).map_err(|error| format!("读取 {relative} 失败：{error}"))?;
    if metadata.is_dir() {
        return Err(format!("{relative} 是目录。"));
    }
    let size = metadata.len();
    Ok(PreviewMeta {
        path: rooted(relative),
        name: target
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        extension: extension(&target),
        mime: guess_mime(&target),
        size,
        modified: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs()),
        previewable: is_previewable(&target),
        over_cap: size > PREVIEW_MAX_BYTES,
    })
}

/// The `/`-rooted spelling of a caller-supplied relative path.
fn rooted(relative: &str) -> String {
    format!("/{}", relative.trim_start_matches('/'))
}