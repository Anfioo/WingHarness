//! The 13 Tauri commands of the Markdown editor.
//!
//! Every function here is a thin forwarder: argument decoding, then straight to
//! its lane module. Until a lane lands, the body returns a "not implemented"
//! error; the command names and argument names below are frozen.

pub mod export;
pub mod files;
pub mod settings;
