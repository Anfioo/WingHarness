//! The AI config-sync engine.
//!
//! Derived from the `core/` crate of shaic (MIT),
//! https://github.com/dariocurr/shaic. Copyright (c) 2026 dariocurr.
//! See `UPSTREAM.md` for the porting record.

pub mod adapters;
pub mod config;
pub mod discovery;
pub mod editor;
pub mod error;
pub mod materialize;
pub mod mcp;
pub mod model;
pub mod operations;
pub mod platform;
pub mod security;
pub mod store;

pub use error::{Error, Result};
