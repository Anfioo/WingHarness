mod cache_validation;
mod candidates;
mod directory_aggregation;
mod hash_cache;
mod session;
mod stream;

pub mod commands;
pub mod models;
mod service;

pub use models::{
    DuplicateEntryDeletePolicy, DuplicateFileEntry, DuplicateFilesResult, DuplicateGroup,
    DuplicateGroupBatch, DuplicateGroupKind, DuplicateGroupPage, DuplicateScanLocation,
    DuplicateScanLocationMode,
};
pub use service::DuplicateFileService;
