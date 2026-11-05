//! Document reading, encoding fallback, EOL handling and safe writes.

use std::fs;
use std::path::{Path, PathBuf};

use md_editor_core::error::MdEditorErrorCode;
use md_editor_core::models::{Eol, MdEncoding};
use md_editor_core::text::{file_meta, read_text, write_text};

fn scratch_dir(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "md-editor-core-text-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn as_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn entry_names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn reads_utf8_and_reports_the_stored_shape() {
    let directory = scratch_dir("utf8");
    let path = directory.join("doc.md");
    fs::write(&path, "hello\nworld\n").unwrap();

    let result = read_text(&as_string(&path)).unwrap();

    assert_eq!(result.content, "hello\nworld\n");
    assert_eq!(result.encoding, MdEncoding::Utf8);
    assert_eq!(result.eol, Eol::Lf);
    assert_eq!(result.size_bytes, 12);
    assert!(result.mtime_ms > 0);
}

#[test]
fn strips_a_utf8_bom_before_decoding() {
    let directory = scratch_dir("bom");
    let path = directory.join("doc.md");
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("hello".as_bytes());
    fs::write(&path, bytes).unwrap();

    let result = read_text(&as_string(&path)).unwrap();

    assert_eq!(result.content, "hello");
    assert_eq!(result.encoding, MdEncoding::Utf8);
}

#[test]
fn falls_back_to_gb18030_when_utf8_fails() {
    let directory = scratch_dir("gb18030");
    let path = directory.join("legacy.md");
    // "中文" in GB18030.
    fs::write(&path, [0xD6, 0xD0, 0xCE, 0xC4]).unwrap();

    let result = read_text(&as_string(&path)).unwrap();

    assert_eq!(result.content, "中文");
    assert_eq!(result.encoding, MdEncoding::Gb18030);
}

#[test]
fn normalizes_crlf_and_restores_it_on_save() {
    let directory = scratch_dir("crlf");
    let path = directory.join("doc.md");
    fs::write(&path, "a\r\nb\r\n").unwrap();

    let result = read_text(&as_string(&path)).unwrap();
    assert_eq!(result.content, "a\nb\n");
    assert_eq!(result.eol, Eol::CrLf);

    write_text(
        &as_string(&path),
        &result.content,
        MdEncoding::Utf8,
        result.eol,
        None,
    )
    .unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\r\n");
}

#[test]
fn treats_a_lone_carriage_return_as_crlf() {
    let directory = scratch_dir("lone-cr");
    let path = directory.join("doc.md");
    fs::write(&path, "a\rb").unwrap();

    let result = read_text(&as_string(&path)).unwrap();

    assert_eq!(result.content, "a\nb");
    assert_eq!(result.eol, Eol::CrLf);
}

#[test]
fn rejects_files_with_null_bytes() {
    let directory = scratch_dir("binary");
    let path = directory.join("doc.md");
    fs::write(&path, b"abc\0def").unwrap();

    let error = read_text(&as_string(&path)).unwrap_err();

    assert_eq!(error.code, MdEditorErrorCode::BinaryFile);
}

#[test]
fn reports_a_missing_document_as_not_found() {
    let directory = scratch_dir("missing");
    let path = directory.join("absent.md");

    let error = read_text(&as_string(&path)).unwrap_err();

    assert_eq!(error.code, MdEditorErrorCode::NotFound);
}

#[test]
fn refuses_to_read_a_directory() {
    let directory = scratch_dir("directory");

    let error = read_text(&as_string(&directory)).unwrap_err();

    assert_eq!(error.code, MdEditorErrorCode::InvalidInput);
}

#[test]
fn refuses_to_overwrite_a_file_changed_on_disk() {
    let directory = scratch_dir("conflict");
    let path = directory.join("doc.md");
    fs::write(&path, "hello").unwrap();
    let original = read_text(&as_string(&path)).unwrap();

    let error = write_text(
        &as_string(&path),
        "changed",
        MdEncoding::Utf8,
        Eol::Lf,
        Some(original.mtime_ms + 5_000),
    )
    .unwrap_err();

    assert_eq!(error.code, MdEditorErrorCode::ConflictExternalChange);
    let detail = error.detail.unwrap();
    assert_eq!(detail["currentMtimeMs"], original.mtime_ms);
    assert_eq!(fs::read_to_string(&path).unwrap(), "hello");
}

#[test]
fn saves_when_the_expected_mtime_matches() {
    let directory = scratch_dir("save-match");
    let path = directory.join("doc.md");
    fs::write(&path, "hello").unwrap();
    let original = read_text(&as_string(&path)).unwrap();

    let saved = write_text(
        &as_string(&path),
        "hello\nworld",
        MdEncoding::Utf8,
        Eol::Lf,
        Some(original.mtime_ms),
    )
    .unwrap();

    assert_eq!(saved.size_bytes, 11);
    assert_eq!(fs::read_to_string(&path).unwrap(), "hello\nworld");
}

#[test]
fn writes_in_gb18030_when_the_document_was_decoded_that_way() {
    let directory = scratch_dir("gb18030-write");
    let path = directory.join("legacy.md");
    fs::write(&path, [0xD6, 0xD0, 0xCE, 0xC4]).unwrap();
    let original = read_text(&as_string(&path)).unwrap();

    write_text(
        &as_string(&path),
        &original.content,
        original.encoding,
        original.eol,
        None,
    )
    .unwrap();

    assert_eq!(fs::read(&path).unwrap(), [0xD6, 0xD0, 0xCE, 0xC4]);
}

#[test]
fn leaves_no_temporary_files_behind() {
    let directory = scratch_dir("atomic");
    let path = directory.join("doc.md");
    fs::write(&path, "hello").unwrap();

    write_text(
        &as_string(&path),
        "updated",
        MdEncoding::Utf8,
        Eol::Lf,
        None,
    )
    .unwrap();

    assert_eq!(entry_names(&directory), vec!["doc.md".to_owned()]);
    assert_eq!(fs::read_to_string(&path).unwrap(), "updated");
}

#[test]
fn file_meta_reports_a_missing_path_without_erroring() {
    let directory = scratch_dir("meta");
    let path = directory.join("absent.md");

    let meta = file_meta(&as_string(&path)).unwrap();

    assert!(!meta.exists);
    assert_eq!(meta.mtime_ms, None);
    assert_eq!(meta.size_bytes, None);
}

#[test]
fn file_meta_reports_size_and_mtime_for_existing_files() {
    let directory = scratch_dir("meta-exists");
    let path = directory.join("doc.md");
    fs::write(&path, "hello").unwrap();

    let meta = file_meta(&as_string(&path)).unwrap();

    assert!(meta.exists);
    assert_eq!(meta.size_bytes, Some(5));
    assert!(meta.mtime_ms.unwrap() > 0);
}
