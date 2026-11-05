use serde::{Deserialize, Serialize};

pub type OperationId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExcludedNameKind {
    File,
    Folder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanNameExclusion {
    pub name: String,
    pub kind: ExcludedNameKind,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanExclusions {
    pub paths: Vec<String>,
    pub names: Vec<ScanNameExclusion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub stage: ScanStage,
    pub processed: u64,
    pub total: Option<u64>,
    pub current_path: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanStage {
    Enumerating,
    Indexing,
    Hashing,
    Grouping,
    Finalizing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanScope {
    pub roots: Vec<String>,
    pub exclusions: ScanExclusions,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub offset: u64,
    pub limit: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageResult<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub offset: u64,
}

/// Persisted user preferences for the systools feature.
///
/// Exclusions are applied to every scan that accepts them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystoolsPrefs {
    pub excluded_paths: Vec<String>,
    pub excluded_names: Vec<ScanNameExclusion>,
}
