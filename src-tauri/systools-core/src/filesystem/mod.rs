pub mod commands;
pub(crate) mod atomic_replace;
pub(crate) mod exclusion_paths;
mod scan_exclusions;
pub use scan_exclusions::ScanExclusionOptions;
mod directory_selection;
pub(crate) mod metadata;
pub mod models;
pub(crate) mod permanent_delete;
#[cfg(windows)]
pub(crate) mod permanent_delete_diagnostics;

pub use directory_selection::DirectorySelectionService;
pub use models::{
    DirectorySelectionOutcome, PermanentDeleteBatchResult, PermanentDeleteCandidate,
    PermanentDeleteFailure, PermanentDeleteFailureDetails, PermanentDeleteFailureReason,
    PermanentDeleteFailureStage, ResolvedDirectory, VolumeInfo,
};
