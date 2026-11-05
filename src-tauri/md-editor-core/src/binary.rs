//! One-shot binary artifacts: decoded base64 payloads written to a user-chosen
//! path, and local images inlined as data URLs for the preview and exports.

use std::fs;
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use crate::error::{MdEditorError, MdEditorErrorCode, MdEditorResult};
use crate::models::MdAssetResult;

/// Upper bound for a base64 payload the caller hands us (HTML export, PNG).
pub const MAX_BINARY_BYTES: usize = 64 * 1024 * 1024;

/// Upper bound for a local image inlined into the preview.
pub const MAX_ASSET_BYTES: u64 = 8 * 1024 * 1024;

/// Decode base64 bytes and write them to `path`.
///
/// The parent directory must already exist: the target is a path the user
/// picked in the save dialog, so creating directories behind their back would
/// only hide a mistake.
pub fn save_binary(path: &str, base64: &str) -> MdEditorResult<()> {
    let bytes = STANDARD.decode(base64).map_err(|_| {
        MdEditorError::invalid_input("base64", "The payload is not valid base64.")
    })?;

    if bytes.len() > MAX_BINARY_BYTES {
        return Err(MdEditorError::new(
            MdEditorErrorCode::TooLarge,
            format!("The payload is larger than {MAX_BINARY_BYTES} bytes."),
        ));
    }

    let path = Path::new(path);
    if let Some(directory) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        if !directory.is_dir() {
            return Err(MdEditorError::not_found(format!(
                "The target directory does not exist: {}",
                directory.display()
            )));
        }
    }

    fs::write(path, &bytes).map_err(|error| {
        MdEditorError::io(format!("Failed to write {}: {error}", path.display()))
    })
}

/// Inline a local image as a `data:` URL.
pub fn read_asset(path: &str) -> MdEditorResult<MdAssetResult> {
    let path = Path::new(path);
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(MdEditorError::not_found(format!(
                "The asset does not exist: {}",
                path.display()
            )))
        }
        Err(error) => {
            return Err(MdEditorError::io(format!(
                "Failed to inspect {}: {error}",
                path.display()
            )))
        }
    };

    let size_bytes = metadata.len();
    if size_bytes > MAX_ASSET_BYTES {
        return Err(MdEditorError::new(
            MdEditorErrorCode::TooLarge,
            format!("The asset is larger than {MAX_ASSET_BYTES} bytes."),
        ));
    }

    let bytes = fs::read(path).map_err(|error| {
        MdEditorError::io(format!("Failed to read {}: {error}", path.display()))
    })?;
    let mime = mime_for(path);

    Ok(MdAssetResult {
        data_url: format!("data:{mime};base64,{}", STANDARD.encode(&bytes)),
        mime: mime.to_owned(),
        size_bytes,
    })
}

fn mime_for(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}
