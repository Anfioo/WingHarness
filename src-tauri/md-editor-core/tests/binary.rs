//! Base64 payload writes and local image inlining.

use std::fs;
use std::path::{Path, PathBuf};

use md_editor_core::binary::{read_asset, save_binary, MAX_ASSET_BYTES};
use md_editor_core::error::MdEditorErrorCode;

fn scratch_dir(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "md-editor-core-binary-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn as_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[test]
fn saves_the_decoded_bytes() {
    let directory = scratch_dir("save");
    let path = directory.join("image.png");

    save_binary(&as_string(&path), "aGVsbG8=").unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"hello");
}

#[test]
fn rejects_payloads_that_are_not_base64() {
    let directory = scratch_dir("invalid");
    let path = directory.join("image.png");

    let error = save_binary(&as_string(&path), "not base64!").unwrap_err();

    assert_eq!(error.code, MdEditorErrorCode::InvalidInput);
    assert_eq!(error.detail.unwrap()["field"], "base64");
    assert!(!path.exists());
}

#[test]
fn refuses_to_write_into_a_missing_directory() {
    let directory = scratch_dir("missing-dir");
    let path = directory.join("nested").join("image.png");

    let error = save_binary(&as_string(&path), "aGVsbG8=").unwrap_err();

    assert_eq!(error.code, MdEditorErrorCode::NotFound);
    assert!(!directory.join("nested").exists());
}

#[test]
fn inlines_a_png_as_a_data_url() {
    let directory = scratch_dir("png");
    let path = directory.join("picture.png");
    fs::write(&path, b"hello").unwrap();

    let asset = read_asset(&as_string(&path)).unwrap();

    assert_eq!(asset.mime, "image/png");
    assert_eq!(asset.size_bytes, 5);
    assert_eq!(asset.data_url, "data:image/png;base64,aGVsbG8=");
}

#[test]
fn maps_the_known_image_extensions() {
    let directory = scratch_dir("mime");
    let cases = [
        ("a.png", "image/png"),
        ("a.jpg", "image/jpeg"),
        ("a.JPEG", "image/jpeg"),
        ("a.gif", "image/gif"),
        ("a.webp", "image/webp"),
        ("a.svg", "image/svg+xml"),
        ("a.bmp", "image/bmp"),
        ("a.ico", "image/x-icon"),
        ("a.txt", "application/octet-stream"),
        ("a", "application/octet-stream"),
    ];

    for (name, expected) in cases {
        let path = directory.join(name);
        fs::write(&path, b"x").unwrap();
        assert_eq!(read_asset(&as_string(&path)).unwrap().mime, expected);
    }
}

#[test]
fn reports_a_missing_asset() {
    let directory = scratch_dir("asset-missing");
    let path = directory.join("absent.png");

    let error = read_asset(&as_string(&path)).unwrap_err();

    assert_eq!(error.code, MdEditorErrorCode::NotFound);
}

#[test]
fn refuses_assets_above_the_size_limit() {
    let directory = scratch_dir("asset-large");
    let path = directory.join("huge.png");
    let file = fs::File::create(&path).unwrap();
    file.set_len(MAX_ASSET_BYTES + 1).unwrap();
    drop(file);

    let error = read_asset(&as_string(&path)).unwrap_err();

    assert_eq!(error.code, MdEditorErrorCode::TooLarge);
}
