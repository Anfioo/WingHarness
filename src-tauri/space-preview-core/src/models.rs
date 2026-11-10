//! DTOs shared by the engine, the commands and the frontend.
//!
//! Everything serializes as camelCase JSON. `modified` is Unix milliseconds,
//! matching the rest of this app's file metadata.
//!
//! These shapes are frozen for the later lanes: the frontend wrappers in
//! `src/commands/services/space-preview/types.ts` mirror them field for field.

use serde::{Deserialize, Serialize};

/// What the frontend learns about a file before reading it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFileInfo {
    /// Stable identity for the current run: the canonical path's digest.
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u64,
    pub mime: String,
    pub directory: bool,
    /// Content fingerprint; a text write is refused when it no longer matches.
    pub etag: String,
}

/// The result of writing a text file back.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub size: u64,
    pub modified: u64,
    pub etag: String,
}

/// Whether the Windows space agent is allowed to run, and whether it actually is.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub enabled: bool,
    pub running: bool,
    pub com_ready: bool,
}

/// The selection the space agent handed to the preview window.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct InitialPaths {
    pub paths: Vec<String>,
    /// The selection should open in the text editor.
    pub text: bool,
    /// The selection came from a file-manager window rather than Everything.
    pub file_manager: bool,
}

/// The persisted preferences. They live in `preview.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPreferences {
    pub version: u32,
    pub space_enabled: bool,
    pub reading_width: u32,
    pub font_size: u32,
    pub default_encoding: String,
    /// Files larger than this many kilobytes skip the line view.
    #[serde(default = "default_text_preview_threshold_kb")]
    pub text_preview_threshold_kb: u32,
    /// Reading font for the preview: `auto`, `sans`, `serif` or `mono`.
    #[serde(default = "default_font")]
    pub font: String,
    /// Whether text files wrap long lines.
    #[serde(default = "default_wrap")]
    pub wrap: bool,
    /// How an HTML file opens: `source` or `web`.
    #[serde(default = "default_html")]
    pub html: String,
    /// The largest file a whole-file preview reads, in mebibytes.
    #[serde(default = "default_max_preview_mib")]
    pub max_preview_mib: u32,
    /// The largest file an archive viewer extracts from an archive, in mebibytes.
    #[serde(default = "default_max_archive_entry_mib")]
    pub max_archive_entry_mib: u32,
    /// Whether the standalone window keeps several files in tabs.
    #[serde(default = "default_tabs")]
    pub tabs: bool,
    /// The trigger for the space agent: `space`, `altSpace` or `winSpace`.
    #[serde(default = "default_preview_key")]
    pub preview_key: String,
}

fn default_text_preview_threshold_kb() -> u32 {
    500
}

fn default_font() -> String {
    "auto".to_owned()
}

fn default_wrap() -> bool {
    true
}

fn default_html() -> String {
    "source".to_owned()
}

fn default_max_preview_mib() -> u32 {
    512
}

fn default_max_archive_entry_mib() -> u32 {
    256
}

fn default_tabs() -> bool {
    false
}

fn default_preview_key() -> String {
    "space".to_owned()
}

impl Default for PreviewPreferences {
    fn default() -> Self {
        Self {
            version: 1,
            space_enabled: true,
            reading_width: 900,
            font_size: 15,
            default_encoding: "auto".to_owned(),
            text_preview_threshold_kb: default_text_preview_threshold_kb(),
            font: default_font(),
            wrap: default_wrap(),
            html: default_html(),
            max_preview_mib: default_max_preview_mib(),
            max_archive_entry_mib: default_max_archive_entry_mib(),
            tabs: default_tabs(),
            preview_key: default_preview_key(),
        }
    }
}
