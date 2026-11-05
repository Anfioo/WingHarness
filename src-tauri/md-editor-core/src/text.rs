//! Reading and writing Markdown documents.
//!
//! Files are decoded strictly as UTF-8 and fall back to GB18030 for legacy
//! Chinese documents. Line endings travel normalized to `\n`; the original EOL
//! is reported so a save can put it back.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use encoding_rs::{GB18030, UTF_8};

use crate::error::{MdEditorError, MdEditorErrorCode, MdEditorResult};
use crate::models::{Eol, MdEncoding, MdFileMeta, MdReadResult, MdSaveResult};

/// Documents above this size are refused; the preview renders the whole file.
pub const MAX_TEXT_BYTES: u64 = 64 * 1024 * 1024;

/// How much of the file is inspected for NUL bytes when telling binary from text.
const SNIFF_BYTES: usize = 8 * 1024;

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Read a document and report how it was stored.
pub fn read_text(path: &str) -> MdEditorResult<MdReadResult> {
    let path = Path::new(path);
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(MdEditorError::not_found(format!(
                "The document does not exist: {}",
                path.display()
            )))
        }
        Err(error) => return Err(io_error("inspect", path, error)),
    };

    if metadata.is_dir() {
        return Err(MdEditorError::invalid_input(
            "path",
            format!("The path is a directory: {}", path.display()),
        ));
    }

    let size_bytes = metadata.len();
    if size_bytes > MAX_TEXT_BYTES {
        return Err(MdEditorError::new(
            MdEditorErrorCode::TooLarge,
            format!(
                "The document is larger than {} bytes: {}",
                MAX_TEXT_BYTES,
                path.display()
            ),
        ));
    }

    let bytes = fs::read(path).map_err(|error| io_error("read", path, error))?;
    if looks_binary(&bytes) {
        return Err(MdEditorError::new(
            MdEditorErrorCode::BinaryFile,
            format!("The file is not text: {}", path.display()),
        ));
    }

    let (content, encoding) = decode(strip_bom(&bytes)).ok_or_else(|| {
        MdEditorError::new(
            MdEditorErrorCode::EncodingFailed,
            format!(
                "The file is neither valid UTF-8 nor GB18030: {}",
                path.display()
            ),
        )
    })?;
    let eol = detect_eol(&content);

    Ok(MdReadResult {
        content: normalize_eol(content),
        encoding,
        eol,
        mtime_ms: mtime_ms(&metadata),
        size_bytes,
    })
}

/// Write a document back in its original encoding and EOL.
///
/// When `expected_mtime_ms` is given and no longer matches the file on disk,
/// nothing is written and a `conflict-external-change` error is returned.
pub fn write_text(
    path: &str,
    content: &str,
    encoding: MdEncoding,
    eol: Eol,
    expected_mtime_ms: Option<u64>,
) -> MdEditorResult<MdSaveResult> {
    let path = Path::new(path);

    if let Some(expected) = expected_mtime_ms {
        let current = fs::metadata(path).ok().map(|meta| mtime_ms(&meta));
        if current != Some(expected) {
            return Err(MdEditorError::conflict(format!(
                "The document changed on disk after it was read: {}",
                path.display()
            ))
            .with_detail(serde_json::json!({ "currentMtimeMs": current })));
        }
    }

    let bytes = encode(&restore_eol(content, eol), encoding)?;
    write_atomic(path, &bytes)?;

    let metadata = fs::metadata(path).map_err(|error| io_error("inspect", path, error))?;
    Ok(MdSaveResult {
        mtime_ms: mtime_ms(&metadata),
        size_bytes: bytes.len() as u64,
    })
}

/// Existence, size and modification time, without reading the contents.
///
/// A missing path is a normal answer here, not an error.
pub fn file_meta(path: &str) -> MdEditorResult<MdFileMeta> {
    let path = Path::new(path);
    match fs::metadata(path) {
        Ok(metadata) => Ok(MdFileMeta {
            exists: true,
            mtime_ms: Some(mtime_ms(&metadata)),
            size_bytes: Some(metadata.len()),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(MdFileMeta {
            exists: false,
            mtime_ms: None,
            size_bytes: None,
        }),
        Err(error) => Err(io_error("inspect", path, error)),
    }
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(SNIFF_BYTES)].contains(&0)
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(UTF8_BOM.as_slice()).unwrap_or(bytes)
}

fn decode(bytes: &[u8]) -> Option<(String, MdEncoding)> {
    if let Some(text) = UTF_8.decode_without_bom_handling_and_without_replacement(bytes) {
        return Some((text.into_owned(), MdEncoding::Utf8));
    }
    GB18030
        .decode_without_bom_handling_and_without_replacement(bytes)
        .map(|text| (text.into_owned(), MdEncoding::Gb18030))
}

fn encode(text: &str, encoding: MdEncoding) -> MdEditorResult<Vec<u8>> {
    match encoding {
        MdEncoding::Utf8 => Ok(text.as_bytes().to_vec()),
        MdEncoding::Gb18030 => {
            let (bytes, _, unmappable) = GB18030.encode(text);
            if unmappable {
                return Err(MdEditorError::new(
                    MdEditorErrorCode::EncodingFailed,
                    "The document contains characters GB18030 cannot represent.",
                ));
            }
            Ok(bytes.into_owned())
        }
    }
}

fn detect_eol(content: &str) -> Eol {
    if content.contains("\r\n") || content.contains('\r') {
        Eol::CrLf
    } else {
        Eol::Lf
    }
}

fn normalize_eol(content: String) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn restore_eol(content: &str, eol: Eol) -> String {
    match eol {
        Eol::Lf => content.to_owned(),
        Eol::CrLf => content.replace('\n', "\r\n"),
    }
}

fn mtime_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> MdEditorResult<()> {
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let name = path.file_name().ok_or_else(|| {
        MdEditorError::invalid_input("path", "The path has no file name.")
    })?;
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = directory.join(format!(
        ".{}.{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id(),
        sequence
    ));

    let written = write_and_rename(&temp, path, bytes);
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(io_error("write", path, error));
    }
    Ok(())
}

fn write_and_rename(temp: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::File::create(temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temp, path)
}

fn io_error(operation: &str, path: &Path, error: std::io::Error) -> MdEditorError {
    MdEditorError::io(format!(
        "Failed to {operation} {}: {error}",
        path.display()
    ))
}
