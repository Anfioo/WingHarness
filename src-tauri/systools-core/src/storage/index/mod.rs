//! In-memory scan index shared by analysis, duplicate, and large-file scans.
//!
//! The index returned by these modules is process-local: entries live only in
//! the running process and are published through `cache` plus `navigation`
//! projections. No file is written to disk here.
//!
//! If this index is ever persisted, the cache root MUST come from
//! `crate::paths::dir()` (or `crate::paths::cache_dir()`). Never build an
//! `%APPDATA%` path by hand, so the data directory stays relocatable.

pub(crate) mod cache;
pub(crate) mod metrics;
pub(in crate::storage) mod navigation;
