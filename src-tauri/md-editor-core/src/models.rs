//! DTOs shared by the engine, the commands and the frontend.
//!
//! Everything serializes as camelCase JSON. Timestamps are Unix milliseconds.

use serde::{Deserialize, Serialize};

/// The text encoding a document is read and written with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum MdEncoding {
    #[default]
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "gb18030")]
    Gb18030,
}

/// The line ending a document is written with.
///
/// The content itself always travels normalized to `\n`; this records what the
/// file used so a save can put it back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Eol {
    #[default]
    #[serde(rename = "\n")]
    Lf,
    #[serde(rename = "\r\n")]
    CrLf,
}

/// Which panes the editor shows for the active tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    Read,
    Source,
    #[default]
    Split,
}

/// Editor typography and page geometry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    /// Empty means "use the application's own editor font".
    #[serde(default)]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default = "default_line_height")]
    pub line_height: f64,
    #[serde(default = "default_content_width")]
    pub content_width: u32,
    /// Empty means "use the application's own code font".
    #[serde(default)]
    pub code_font_family: String,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            font_family: String::new(),
            font_size: default_font_size(),
            line_height: default_line_height(),
            content_width: default_content_width(),
            code_font_family: String::new(),
        }
    }
}

/// How the source editor behaves while typing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorSettings {
    #[serde(default = "default_true")]
    pub line_wrap: bool,
    #[serde(default = "default_true")]
    pub line_numbers: bool,
    #[serde(default = "default_tab_size")]
    pub tab_size: u32,
    #[serde(default)]
    pub auto_save: bool,
    #[serde(default = "default_auto_save_interval")]
    pub auto_save_interval_sec: u32,
}

impl Default for BehaviorSettings {
    fn default() -> Self {
        Self {
            line_wrap: true,
            line_numbers: true,
            tab_size: default_tab_size(),
            auto_save: false,
            auto_save_interval_sec: default_auto_save_interval(),
        }
    }
}

/// Which panes are open by default, and how much room each gets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSettings {
    #[serde(default)]
    pub default_mode: ViewMode,
    #[serde(default = "default_split_ratio")]
    pub split_ratio: f64,
    #[serde(default = "default_true")]
    pub outline_visible: bool,
    #[serde(default = "default_outline_width")]
    pub outline_width: u32,
}

impl Default for ViewSettings {
    fn default() -> Self {
        Self {
            default_mode: ViewMode::Split,
            split_ratio: default_split_ratio(),
            outline_visible: true,
            outline_width: default_outline_width(),
        }
    }
}

/// Defaults applied by the export actions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    #[serde(default = "default_true")]
    pub html_inline_styles: bool,
    #[serde(default = "default_true")]
    pub html_include_title: bool,
    #[serde(default = "default_image_scale")]
    pub image_scale: f64,
    #[serde(default)]
    pub image_include_outline: bool,
    #[serde(default = "default_pdf_page")]
    pub pdf_page: String,
    #[serde(default = "default_pdf_margin_mm")]
    pub pdf_margin_mm: f64,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            html_inline_styles: true,
            html_include_title: true,
            image_scale: default_image_scale(),
            image_include_outline: false,
            pdf_page: default_pdf_page(),
            pdf_margin_mm: default_pdf_margin_mm(),
        }
    }
}

/// The contents of `settings.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdEditorSettings {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub behavior: BehaviorSettings,
    #[serde(default)]
    pub view: ViewSettings,
    #[serde(default)]
    pub export: ExportSettings,
}

impl Default for MdEditorSettings {
    fn default() -> Self {
        Self {
            version: default_version(),
            appearance: AppearanceSettings::default(),
            behavior: BehaviorSettings::default(),
            view: ViewSettings::default(),
            export: ExportSettings::default(),
        }
    }
}

/// A document as read from disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdReadResult {
    /// Normalized to `\n`.
    pub content: String,
    pub encoding: MdEncoding,
    pub eol: Eol,
    pub mtime_ms: u64,
    pub size_bytes: u64,
}

/// What a save produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdSaveResult {
    pub mtime_ms: u64,
    pub size_bytes: u64,
}

/// Existence and timestamps of one path, without reading its contents.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdFileMeta {
    pub exists: bool,
    pub mtime_ms: Option<u64>,
    pub size_bytes: Option<u64>,
}

/// An image referenced by a document, inlined for the preview and exports.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdAssetResult {
    /// `data:<mime>;base64,...`
    pub data_url: String,
    pub mime: String,
    pub size_bytes: u64,
}

/// One entry of `recent.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdRecentEntry {
    pub path: String,
    pub name: String,
    /// Unix seconds.
    pub opened_at: i64,
    /// Set by the list command when the file no longer exists.
    #[serde(default)]
    pub missing: bool,
}

/// The recently opened documents, newest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MdRecentList {
    #[serde(default)]
    pub entries: Vec<MdRecentEntry>,
}

/// A caret position, 1-based, matching what the status bar shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdCursor {
    pub line: u32,
    pub column: u32,
}

impl Default for MdCursor {
    fn default() -> Self {
        Self { line: 1, column: 1 }
    }
}

/// One tab restored from `session.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdSessionTab {
    pub path: String,
    #[serde(default)]
    pub cursor: MdCursor,
    #[serde(default)]
    pub scroll_top: f64,
    #[serde(default)]
    pub view_mode: ViewMode,
}

/// The contents of `session.json`. Untitled documents are never stored here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MdSession {
    #[serde(default)]
    pub tabs: Vec<MdSessionTab>,
    #[serde(default)]
    pub active_path: Option<String>,
}

/// Page margins in millimetres.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MdPdfMargins {
    #[serde(default)]
    pub top: f64,
    #[serde(default)]
    pub right: f64,
    #[serde(default)]
    pub bottom: f64,
    #[serde(default)]
    pub left: f64,
}

/// Arguments of `md_editor_export_pdf`. Sizes are in millimetres.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdPdfOptions {
    pub path: String,
    pub page_width: f64,
    pub page_height: f64,
    #[serde(default)]
    pub margins: MdPdfMargins,
}

fn default_true() -> bool {
    true
}

fn default_version() -> u32 {
    1
}

fn default_font_size() -> f64 {
    14.0
}

fn default_line_height() -> f64 {
    1.7
}

fn default_content_width() -> u32 {
    860
}

fn default_tab_size() -> u32 {
    2
}

fn default_auto_save_interval() -> u32 {
    30
}

fn default_split_ratio() -> f64 {
    0.5
}

fn default_outline_width() -> u32 {
    240
}

fn default_image_scale() -> f64 {
    2.0
}

fn default_pdf_page() -> String {
    "a4".to_owned()
}

fn default_pdf_margin_mm() -> f64 {
    15.0
}
