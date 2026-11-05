//! Large-file discovery domain.
//!
//! The service reuses the shared storage traversal kernel, keeps scan results in
//! a bounded in-process session so threshold changes never touch the disk again,
//! and authorizes every permanent delete against that authoritative snapshot.

pub mod commands;
pub(crate) mod index_projection;
pub mod models;
mod service;
mod session;

#[cfg(test)]
#[path = "service_tests.rs"]
mod service_tests;

pub use service::LargeFileService;
