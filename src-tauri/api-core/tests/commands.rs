//! Integration tests for the command surface — specifically the document-size
//! guard shared by the local and remote spec readers.

use std::fs;

use api_core::commands::api_read_text_file;
use api_core::AppError;

/// One byte past the 8 MiB cap.
const OVER_LIMIT: usize = 8 * 1024 * 1024 + 1;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn text_file_within_the_limit_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("spec.json");
    fs::write(&path, r#"{"openapi":"3.0.0"}"#).unwrap();

    let file = runtime()
        .block_on(api_read_text_file(path.to_string_lossy().into_owned()))
        .unwrap();
    assert_eq!(file.text, r#"{"openapi":"3.0.0"}"#);
    assert_eq!(file.bytes, 19);
}

#[test]
fn text_file_above_the_limit_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big.json");
    fs::write(&path, vec![b'a'; OVER_LIMIT]).unwrap();

    let error = runtime()
        .block_on(api_read_text_file(path.to_string_lossy().into_owned()))
        .unwrap_err();
    assert!(matches!(error, AppError::Other(_)));
    assert!(error.to_string().contains("limit"));
}
