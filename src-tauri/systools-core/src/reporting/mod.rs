use serde::{Deserialize, Serialize};

pub(crate) mod analysis;
pub use analysis::AnalysisReport;

/// Output format for an analysis export.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AnalysisExportFormat {
    #[default]
    Json,
    Markdown,
}

impl AnalysisExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Markdown => "md",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Markdown => "markdown",
        }
    }
}

/// Zero means all available detail within max_depth, never a filesystem refresh.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnalysisExportRequest {
    pub scan_id: u64,
    pub max_depth: u8,
    pub max_entries: usize,
    pub include_full_paths: bool,
    #[serde(default)]
    pub format: AnalysisExportFormat,
    /// Optional destination chosen by the user; absent means the UI must prompt.
    #[serde(default)]
    pub path: Option<String>,
}

/// Result of writing one export document to disk.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisExportReceipt {
    pub schema_version: u8,
    pub path: String,
    pub entry_count: usize,
    pub file_bytes: u64,
}
