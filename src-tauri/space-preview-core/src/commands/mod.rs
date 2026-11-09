//! The 17 Tauri commands of the space preview engine.
//!
//! Every function here is a thin forwarder: argument decoding, then straight to
//! its lane module. A0 ships them as stubs that return a structured
//! "not implemented" error, so the command names and argument names below are
//! frozen and the frontend wrappers can be written against them.

pub mod agent;
pub mod html;
pub mod icons;
pub mod io;
pub mod prefs;
pub mod presentation;
pub mod text;
