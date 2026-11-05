//! Payloads shared with the frontend.
//!
//! These mirror `src/lib/svn-core/types.ts` field for field. Every field is
//! camelCase on the wire (`rename_all`), matching `api-core`'s convention, even
//! though the reference implementation this crate was ported from used
//! snake_case: the frontend is rebuilt either way, and one convention across the
//! app beats fidelity to the source.

use serde::{Deserialize, Serialize};

/// What a write-style command (commit/update/add/...) reports back. The success
/// flag is always `true` when the command resolves at all — a failure is an
/// `Err` — but the shape is kept so the UI can render one component for both.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub success: bool,
    pub output: String,
    pub error: Option<String>,
}

impl CommandResult {
    /// A successful run carrying `output` (usually the CLI's stdout).
    pub fn ok(output: String) -> Self {
        CommandResult {
            success: true,
            output,
            error: None,
        }
    }
}

/// Where `open_workspace_target` should send a working copy.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenTarget {
    Explorer,
    Vscode,
    Terminal,
}

/// One entry of `svn status`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnStatus {
    /// Path relative to the working copy root, always `/`-separated.
    pub path: String,
    /// The single-letter status the UI filters on ("modified", "unversioned", …).
    pub status: String,
    /// The same as [`Self::status`] before localisation; what the parser sets.
    pub status_code: String,
    pub prop_status: String,
    pub locked: bool,
    pub history: bool,
    pub switched: bool,
}

/// One changed path inside a log entry, or the whole entry's path list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnLogPath {
    pub path: String,
    /// `A` / `D` / `M` / `R`, or empty when the action is unknown.
    pub action: String,
}

/// One `svn log` revision.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnLogEntry {
    pub revision: u64,
    pub author: String,
    pub date: String,
    pub message: String,
    pub changed_paths: Vec<SvnLogPath>,
}

/// The subset of `svn info` the UI shows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnInfo {
    pub path: String,
    pub url: String,
    pub repository_root: String,
    pub revision: u64,
    pub node_kind: String,
    pub schedule: String,
}

/// The credential `svn` would use for this working copy, when it knows one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvnAuthUser {
    pub username: String,
    pub realm: String,
}

/// A unified diff plus the revisions it spans.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub path: String,
    pub diff: String,
    pub old_revision: u64,
    pub new_revision: u64,
}

/// One line of `svn blame` output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlameLine {
    pub revision: u64,
    pub author: String,
    pub line: String,
}

/// A file or directory captured for the local stash, base64-encoded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashUnversionedEntry {
    /// Path relative to the working copy root, `/`-separated.
    pub path: String,
    /// `"file"` or `"directory"`.
    pub kind: String,
    pub content_base64: Option<String>,
}

/// `.gitignore` contents plus the mtime the frontend caches against.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreData {
    pub content: String,
    /// Milliseconds since the Unix epoch.
    pub mtime: u64,
}
