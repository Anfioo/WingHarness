//! Space preview engine.
//!
//! Ported from SpacePreview (MIT), https://github.com/likehao19/SpacePreview.
//! See `UPSTREAM.md` for the porting record.
//!
//! The root crate hands in the data directory (`paths::CONFIG_DIR`) and manages
//! `state::PreviewState`; every persisted file resolves from there. The command
//! functions in `commands/` only adapt the wire arguments and forward.

pub mod agent;
pub mod commands;
pub mod directory;
pub mod error;
pub mod html;
pub mod icons;
pub mod io;
pub mod models;
pub mod paths;
pub mod prefs;
pub mod presentation;
pub mod state;
pub mod text;

pub use error::{SpacePreviewError, SpacePreviewResult};
pub use models::*;
