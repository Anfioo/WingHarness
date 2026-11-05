//! AI config sync — a Tauri port of the `shaic` TUI.
//!
//! The upstream `shaic` project ships a ratatui TUI over a `shaic-core` crate
//! that holds all of the real logic (store, adapters, materialize). This module
//! keeps `shaic-core` verbatim (vendored under `vendor/shaic-core`) and replaces
//! the TUI with Tauri commands the React UI calls — one command per TUI action.

pub mod commands;
