//! Markdown editor engine.
//!
//! Ported from TizuMark (GPL-3.0-only),
//! https://github.com/tizuio/TizuMark-Markdown-Editor. See `UPSTREAM.md` for
//! the porting record.
//!
//! The root crate hands in the data directory (`paths::CONFIG_DIR`); every
//! persisted file resolves from there. No business logic lives in this file.

pub mod binary;
pub mod commands;
pub mod error;
pub mod models;
pub mod paths;
pub mod recent;
pub mod session;
pub mod settings;
pub mod store;
pub mod text;

pub use error::{MdEditorError, MdEditorErrorCode, MdEditorResult};
pub use models::*;
