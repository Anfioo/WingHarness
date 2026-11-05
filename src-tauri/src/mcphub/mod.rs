//! MCP Hub — aggregates local stdio / remote MCP servers behind one SSE endpoint.
//!
//! Adapted from Soflution1/McpHub (MIT). The original standalone binary is
//! embedded here as a Tauri-managed module: configuration and runtime state live
//! under the app's own config directory, and the UI talks to it through Tauri
//! commands rather than the original embedded HTTP dashboard.

pub mod auth;
pub mod cache;
pub mod child;
pub mod commands;
pub mod config;
pub mod health;
pub mod log_store;
pub mod paths;
pub mod protocol;
pub mod proxy;
pub mod search;
pub mod server;
pub mod sse;
pub mod state;

pub use state::McpHubState;
