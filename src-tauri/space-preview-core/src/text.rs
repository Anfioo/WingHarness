//! Text write-back.
//!
//! The browser's `TextEncoder` only produces UTF-8, so the chosen encoding is
//! applied here. Text crosses the boundary as LF and the file's own line
//! endings are restored on the way out. A write carries the etag it read; a
//! mismatch means the file changed underneath and the write is refused rather
//! than clobbering it.

use std::borrow::Cow;
use std::fs;
use std::io::Write;
use std::path::Path;

use encoding_rs::Encoding;

use crate::error::{SpacePreviewError, SpacePreviewResult};
use crate::io::{etag_of, file_error};
use crate::models::WriteResult;
use crate::state::PreviewState;

const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// The encodings a text edit may be saved back in.
enum TextEncoding {
    Utf8,
    /// `encoding_rs` has no UTF-16 encoder, so these two are written here.
    Utf16Le,
    Utf16Be,
    Legacy(&'static Encoding),
}

/// Write `text` back to `path`, preserving its BOM and line endings.
pub fn write_text(
    path: &Path,
    text: &str,
    encoding: &str,
    etag: Option<&str>,
    state: &PreviewState,
) -> SpacePreviewResult<WriteResult> {
    // The allowlist decides before the file is opened.
    let canonical = state.check(path)?;
    let target = parse_encoding(encoding)?;

    let metadata = fs::metadata(&canonical).map_err(|error| file_error(&canonical, error))?;
    if metadata.is_dir() {
        return Err(SpacePreviewError::invalid_input(
            "Directories cannot be written as text.",
        ));
    }

    if let Some(expected) = etag {
        let current = etag_of(metadata.len(), modified_millis(&metadata));
        if current != expected {
            return Err(SpacePreviewError::invalid_input(
                "The file changed on disk since it was read.",
            ));
        }
    }

    // The existing bytes decide the line endings and the BOM a save restores.
    let existing = fs::read(&canonical).map_err(|error| file_error(&canonical, error))?;
    let uses_crlf = existing.windows(2).any(|pair| pair == b"\r\n");
    let had_utf8_bom = existing.starts_with(&UTF8_BOM);

    let body = to_lf(text);
    let body: Cow<'_, str> = if uses_crlf {
        Cow::Owned(body.replace('\n', "\r\n"))
    } else {
        body
    };
    let bytes = encode(&body, encoding, target, had_utf8_bom)?;

    write_atomic(&canonical, &bytes)?;

    let metadata = fs::metadata(&canonical).map_err(|error| file_error(&canonical, error))?;
    let modified = modified_millis(&metadata);
    Ok(WriteResult {
        size: metadata.len(),
        modified,
        etag: etag_of(metadata.len(), modified),
    })
}

fn parse_encoding(label: &str) -> SpacePreviewResult<TextEncoding> {
    match label.to_ascii_lowercase().as_str() {
        "utf-8" => Ok(TextEncoding::Utf8),
        "utf-16le" => Ok(TextEncoding::Utf16Le),
        "utf-16be" => Ok(TextEncoding::Utf16Be),
        "gb18030" => Ok(TextEncoding::Legacy(encoding_rs::GB18030)),
        "big5" => Ok(TextEncoding::Legacy(encoding_rs::BIG5)),
        "shift_jis" => Ok(TextEncoding::Legacy(encoding_rs::SHIFT_JIS)),
        "windows-1252" => Ok(TextEncoding::Legacy(encoding_rs::WINDOWS_1252)),
        _ => Err(SpacePreviewError::invalid_input(format!(
            "The text encoding is not supported: {label}"
        ))),
    }
}

fn encode(
    body: &str,
    label: &str,
    encoding: TextEncoding,
    had_utf8_bom: bool,
) -> SpacePreviewResult<Vec<u8>> {
    match encoding {
        TextEncoding::Utf8 => {
            let mut bytes = Vec::with_capacity(body.len() + UTF8_BOM.len());
            if had_utf8_bom {
                bytes.extend_from_slice(&UTF8_BOM);
            }
            bytes.extend_from_slice(body.as_bytes());
            Ok(bytes)
        }
        TextEncoding::Utf16Le => Ok(encode_utf16(body, false)),
        TextEncoding::Utf16Be => Ok(encode_utf16(body, true)),
        TextEncoding::Legacy(encoding) => {
            // `encoding_rs` substitutes numeric character references for
            // unmappable characters. That would silently rewrite the text, so
            // the save is refused instead.
            let (bytes, _, had_errors) = encoding.encode(body);
            if had_errors {
                return Err(SpacePreviewError::invalid_input(format!(
                    "The text contains characters that {label} cannot represent."
                )));
            }
            Ok(bytes.into_owned())
        }
    }
}

fn encode_utf16(text: &str, big_endian: bool) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(2 + text.len() * 2);
    // A UTF-16 file without a BOM is ambiguous to other editors, so one is
    // always written, matching what the encoding actually is.
    bytes.extend_from_slice(if big_endian {
        &[0xFE, 0xFF]
    } else {
        &[0xFF, 0xFE]
    });
    for unit in text.encode_utf16() {
        let pair = if big_endian {
            unit.to_be_bytes()
        } else {
            unit.to_le_bytes()
        };
        bytes.extend_from_slice(&pair);
    }
    bytes
}

/// Normalize CRLF and lone CR to LF; a change set is split on `\r\n?|\n`.
fn to_lf(text: &str) -> Cow<'_, str> {
    if text.contains('\r') {
        Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> SpacePreviewResult<()> {
    let name = path
        .file_name()
        .ok_or_else(|| SpacePreviewError::invalid_input("The path has no file name."))?;
    let temp = path.with_file_name(format!(
        "{}.tmp-{}",
        name.to_string_lossy(),
        std::process::id()
    ));

    let written = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();

    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(SpacePreviewError::internal(format!(
            "The text file could not be written: {} ({error})",
            path.display()
        )));
    }
    Ok(())
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path as FsPath, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "space-preview-b1-text-{label}-{}-{stamp}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    /// A file already read by `inspect`, which is what a save expects.
    fn prepared(label: &str, bytes: &[u8]) -> (PathBuf, PreviewState) {
        let directory = temp_dir(label);
        let path = directory.join("note.txt");
        fs::write(&path, bytes).unwrap();
        let state = PreviewState::default();
        crate::io::inspect(&path, &state).unwrap();
        (path, state)
    }

    fn read(path: &FsPath) -> Vec<u8> {
        fs::read(path).unwrap()
    }

    fn decode_utf16(bytes: &[u8], big_endian: bool) -> String {
        let body = &bytes[2..];
        assert_eq!(body.len() % 2, 0);
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|pair| {
                if big_endian {
                    u16::from_be_bytes([pair[0], pair[1]])
                } else {
                    u16::from_le_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn utf8_round_trip() {
        let (path, state) = prepared("utf8", b"old");

        write_text(&path, "中文 😀", "utf-8", None, &state).unwrap();

        let bytes = read(&path);
        assert!(!bytes.starts_with(&UTF8_BOM));
        assert_eq!(String::from_utf8(bytes).unwrap(), "中文 😀");
    }

    #[test]
    fn utf8_keeps_the_bom() {
        let (path, state) = prepared("utf8-bom", b"\xEF\xBB\xBFold");

        write_text(&path, "new", "utf-8", None, &state).unwrap();

        let bytes = read(&path);
        assert!(bytes.starts_with(&UTF8_BOM));
        assert_eq!(&bytes[UTF8_BOM.len()..], b"new".as_slice());
    }

    #[test]
    fn utf16le_round_trip() {
        let (path, state) = prepared("utf16le", b"old");

        write_text(&path, "中文 😀", "utf-16le", None, &state).unwrap();

        let bytes = read(&path);
        assert!(bytes.starts_with(&[0xFF, 0xFE]));
        assert_eq!(decode_utf16(&bytes, false), "中文 😀");
    }

    #[test]
    fn utf16be_round_trip() {
        let (path, state) = prepared("utf16be", b"old");

        write_text(&path, "中文 😀", "utf-16be", None, &state).unwrap();

        let bytes = read(&path);
        assert!(bytes.starts_with(&[0xFE, 0xFF]));
        assert_eq!(decode_utf16(&bytes, true), "中文 😀");
    }

    fn legacy_round_trip(label: &str, encoding: &'static Encoding, text: &str) {
        let (path, state) = prepared(label, b"old");

        write_text(&path, text, label, None, &state).unwrap();

        let bytes = read(&path);
        let (decoded, _, had_errors) = encoding.decode(&bytes);
        assert!(!had_errors);
        assert_eq!(decoded, text);
    }

    #[test]
    fn gb18030_round_trip() {
        legacy_round_trip("gb18030", encoding_rs::GB18030, "中文 😀");
    }

    #[test]
    fn big5_round_trip() {
        legacy_round_trip("big5", encoding_rs::BIG5, "中文");
    }

    #[test]
    fn shift_jis_round_trip() {
        legacy_round_trip("shift_jis", encoding_rs::SHIFT_JIS, "日本語");
    }

    #[test]
    fn windows_1252_round_trip() {
        legacy_round_trip("windows-1252", encoding_rs::WINDOWS_1252, "café –");
    }

    #[test]
    fn crlf_is_preserved() {
        let (path, state) = prepared("crlf", b"a\r\nb");

        write_text(&path, "x\ny", "utf-8", None, &state).unwrap();

        assert_eq!(read(&path).as_slice(), b"x\r\ny".as_slice());
    }

    #[test]
    fn lf_stays_lf() {
        let (path, state) = prepared("lf", b"a\nb");

        write_text(&path, "x\r\ny", "utf-8", None, &state).unwrap();

        assert_eq!(read(&path).as_slice(), b"x\ny".as_slice());
    }

    #[test]
    fn etag_mismatch_is_refused() {
        let (path, state) = prepared("etag", b"first");
        let etag = crate::io::inspect(&path, &state).unwrap().etag;
        // Something else changed the file after the read.
        fs::write(&path, b"changed on disk, longer than before").unwrap();

        let error = write_text(&path, "new", "utf-8", Some(&etag), &state).unwrap_err();

        assert_eq!(error.code, "invalid-input");
        assert_eq!(
            read(&path).as_slice(),
            b"changed on disk, longer than before".as_slice()
        );
    }

    #[test]
    fn matching_etag_is_accepted() {
        let (path, state) = prepared("etag-match", b"first");
        let etag = crate::io::inspect(&path, &state).unwrap().etag;

        let result = write_text(&path, "second", "utf-8", Some(&etag), &state).unwrap();

        assert_eq!(result.size, 6);
        assert_eq!(result.etag, etag_of(6, result.modified));
        assert_eq!(read(&path).as_slice(), b"second".as_slice());
    }

    #[test]
    fn auto_and_unknown_encodings_are_refused() {
        let (path, state) = prepared("encoding", b"old");

        assert_eq!(
            write_text(&path, "x", "auto", None, &state)
                .unwrap_err()
                .code,
            "invalid-input"
        );
        assert_eq!(
            write_text(&path, "x", "koi8-r", None, &state)
                .unwrap_err()
                .code,
            "invalid-input"
        );
    }

    #[test]
    fn unmappable_text_is_refused() {
        let (path, state) = prepared("unmappable", b"old");

        let error = write_text(&path, "中文 😀", "big5", None, &state).unwrap_err();

        assert_eq!(error.code, "invalid-input");
        assert_eq!(read(&path).as_slice(), b"old".as_slice());
    }

    #[test]
    fn write_without_inspect_is_refused() {
        let directory = temp_dir("unauthorized");
        let path = directory.join("note.txt");
        fs::write(&path, b"old").unwrap();
        let state = PreviewState::default();

        let error = write_text(&path, "x", "utf-8", None, &state).unwrap_err();

        assert_eq!(error.code, "not-authorized");
        assert_eq!(read(&path).as_slice(), b"old".as_slice());
    }

    #[test]
    fn write_rejects_a_directory() {
        let directory = temp_dir("write-directory");
        let state = PreviewState::default();
        crate::io::inspect(&directory, &state).unwrap();

        let error = write_text(&directory, "x", "utf-8", None, &state).unwrap_err();

        assert_eq!(error.code, "invalid-input");
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let (path, state) = prepared("atomic", b"old");

        write_text(&path, "new", "utf-8", None, &state).unwrap();

        let directory = path.parent().unwrap();
        for entry in fs::read_dir(directory).unwrap() {
            let name = entry.unwrap().file_name();
            assert!(
                !name.to_string_lossy().contains(".tmp-"),
                "temporary file left behind: {}",
                name.to_string_lossy()
            );
        }
    }
}
