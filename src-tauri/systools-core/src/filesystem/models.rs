use crate::platform::contracts::VolumeInfo as NativeVolumeInfo;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub name: String,
    pub mount_point: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
}

impl From<NativeVolumeInfo> for VolumeInfo {
    fn from(value: NativeVolumeInfo) -> Self {
        Self {
            name: value.name,
            mount_point: value.mount_point,
            total_bytes: value.total_bytes,
            available_bytes: value.available_bytes,
            used_bytes: value.used_bytes,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentDeleteCandidate {
    pub path: String,
    /// Logical content length used only to reject stale file selections.
    pub expected_bytes: u64,
    pub expected_modified_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentDeleteFailure {
    pub path: String,
    #[serde(flatten)]
    pub details: PermanentDeleteFailureDetails,
}

/// Stable presentation metadata. Diagnostics never determine UI behavior.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentDeleteFailureDetails {
    pub message: String,
    #[serde(default)]
    pub reason: PermanentDeleteFailureReason,
    #[serde(default)]
    pub stage: PermanentDeleteFailureStage,
    #[serde(default)]
    pub native_code: Option<i32>,
    #[serde(default)]
    pub partial: bool,
    #[serde(default)]
    pub remaining_restored: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermanentDeleteFailureReason {
    AccessDenied,
    ResourceBusy,
    ItemChanged,
    Protected,
    NotFound,
    #[default]
    Other,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermanentDeleteFailureStage {
    #[default]
    Validate,
    PrepareTarget,
    CreateStaging,
    MoveToStaging,
    Remove,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermanentDeleteBatchResult {
    pub removed_paths: Vec<String>,
    /// Entries already absent are reconciled without counting reclaimed storage.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub already_absent_paths: Vec<String>,
    pub failed: Vec<PermanentDeleteFailure>,
    /// True when any completed directory used scan-time storage accounting.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub released_bytes_is_estimate: bool,
    /// Physical storage released by successful selections, or its marked estimate.
    pub released_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDirectory {
    pub requested_path: String,
    pub path: String,
}

/// Versioned result preserves alias-to-target mappings for Known Folder labels
/// and saved selections.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySelectionOutcome {
    pub schema_version: u32,
    pub directories: Vec<ResolvedDirectory>,
    pub rejected_count: u64,
    pub redirected_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileIconItemKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileIconMode {
    Automatic,
    Generic,
    Path,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIconRequest {
    pub path: String,
    pub kind: FileIconItemKind,
    pub mode: FileIconMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIconAssignment {
    pub path: String,
    pub kind: FileIconItemKind,
    pub mode: FileIconMode,
    pub icon_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIconAsset {
    pub icon_key: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIconBatch {
    pub assignments: Vec<FileIconAssignment>,
    pub assets: Vec<FileIconAsset>,
}
