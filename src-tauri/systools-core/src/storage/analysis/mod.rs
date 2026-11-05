mod allocation;
pub mod commands;
pub(crate) mod coverage;
mod deletion;
pub(in crate::storage) mod directory_loader;
mod export;
mod export_selection;
pub(in crate::storage) mod hierarchy;
pub(in crate::storage) mod index_projection;
pub mod models;
mod query;
mod remainder;
pub(crate) mod service;
mod session;

pub use coverage::{AnalysisCoverage, ANALYSIS_SCAN_POLICY_VERSION};
pub use models::{
    AnalysisDeleteBatchResult, AnalysisDeleteFailure, AnalysisDeleteResult, AnalysisDirectoryNode,
    AnalysisEntrySizeStatus, AnalysisRemainderPage, AnalysisRemainderRequest, AnalysisResult,
    AnalysisScanMode, DirectoryEntryInfo,
};
pub(crate) use models::{
    AnalysisEntryCandidate, AnalysisIndexSnapshot, AnalysisRemainderParent, SharedAllocation,
    ANALYSIS_VISIBLE_ENTRY_LIMIT,
};
pub use service::AnalysisService;
