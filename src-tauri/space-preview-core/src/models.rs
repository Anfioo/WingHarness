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
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPreferences {
    pub version: u32,
    pub space_enabled: bool,
    pub reading_width: u32,
    pub font_size: u32,
    pub default_encoding: String,
}

impl Default for PreviewPreferences {
    fn default() -> Self {
        Self {
            version: 1,
            space_enabled: true,
            reading_width: 900,
            font_size: 15,
            default_encoding: "auto".to_owned(),
        }
    }
}
