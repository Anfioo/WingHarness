//! The baseline smoke test: the crate builds, and the wire shapes the
//! frontend depends on serialize exactly as documented.

use md_editor_core::error::{MdEditorError, MdEditorErrorCode};
use md_editor_core::models::{Eol, MdEditorSettings, MdEncoding, ViewMode};

#[test]
fn error_codes_serialize_as_kebab_case() {
    let cases = [
        (MdEditorErrorCode::NotFound, "not-found"),
        (MdEditorErrorCode::InvalidInput, "invalid-input"),
        (
            MdEditorErrorCode::ConflictExternalChange,
            "conflict-external-change",
        ),
        (MdEditorErrorCode::BinaryFile, "binary-file"),
        (MdEditorErrorCode::EncodingFailed, "encoding-failed"),
        (MdEditorErrorCode::TooLarge, "too-large"),
        (MdEditorErrorCode::Unsupported, "unsupported"),
        (MdEditorErrorCode::Io, "io"),
        (MdEditorErrorCode::Internal, "internal"),
    ];

    for (code, expected) in cases {
        assert_eq!(
            serde_json::to_value(code).unwrap(),
            serde_json::Value::String(expected.to_owned())
        );
    }
}

#[test]
fn an_error_payload_keeps_its_code_and_detail() {
    let error = MdEditorError::invalid_input("path", "The path is empty.");
    let json = serde_json::to_value(&error).unwrap();

    assert_eq!(json["code"], "invalid-input");
    assert_eq!(json["detail"]["field"], "path");
    assert_eq!(json["message"], "The path is empty.");
}

#[test]
fn the_documented_primitives_serialize_as_the_frontend_expects() {
    assert_eq!(serde_json::to_value(MdEncoding::Utf8).unwrap(), "utf-8");
    assert_eq!(
        serde_json::to_value(MdEncoding::Gb18030).unwrap(),
        "gb18030"
    );
    assert_eq!(serde_json::to_value(Eol::Lf).unwrap(), "\n");
    assert_eq!(serde_json::to_value(Eol::CrLf).unwrap(), "\r\n");
    assert_eq!(serde_json::to_value(ViewMode::Read).unwrap(), "read");
    assert_eq!(serde_json::to_value(ViewMode::Source).unwrap(), "source");
    assert_eq!(serde_json::to_value(ViewMode::Split).unwrap(), "split");
}

#[test]
fn the_default_settings_match_the_documented_shape() {
    let json = serde_json::to_value(MdEditorSettings::default()).unwrap();

    assert_eq!(json["version"], 1);
    assert_eq!(json["appearance"]["fontSize"], 14.0);
    assert_eq!(json["appearance"]["lineHeight"], 1.7);
    assert_eq!(json["appearance"]["contentWidth"], 860);
    assert_eq!(json["behavior"]["lineWrap"], true);
    assert_eq!(json["behavior"]["lineNumbers"], true);
    assert_eq!(json["behavior"]["tabSize"], 2);
    assert_eq!(json["behavior"]["autoSave"], false);
    assert_eq!(json["behavior"]["autoSaveIntervalSec"], 30);
    assert_eq!(json["view"]["defaultMode"], "split");
    assert_eq!(json["view"]["splitRatio"], 0.5);
    assert_eq!(json["view"]["outlineVisible"], true);
    assert_eq!(json["view"]["outlineWidth"], 240);
    assert_eq!(json["export"]["htmlInlineStyles"], true);
    assert_eq!(json["export"]["htmlIncludeTitle"], true);
    assert_eq!(json["export"]["imageScale"], 2.0);
    assert_eq!(json["export"]["imageIncludeOutline"], false);
    assert_eq!(json["export"]["pdfPage"], "a4");
    assert_eq!(json["export"]["pdfMarginMm"], 15.0);
}

#[test]
fn a_partial_settings_object_picks_up_the_defaults() {
    let settings: MdEditorSettings = serde_json::from_str(r#"{ "appearance": {} }"#).unwrap();

    assert_eq!(settings.version, 1);
    assert_eq!(settings.appearance.font_size, 14.0);
    assert_eq!(settings.behavior.auto_save_interval_sec, 30);
    assert_eq!(settings.view.default_mode, ViewMode::Split);
    assert_eq!(settings.export.pdf_page, "a4");
}
