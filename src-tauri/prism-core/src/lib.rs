//! Clash support: Prism rule compilation plus a minimal mihomo core manager.
//!
//! Prism is a config *compiler*, not a proxy core. It reads a source profile,
//! applies the `.prism.yaml` patches kept in `clash/prism/`, and writes the
//! compiled result to `clash/run/config.yaml`. This crate supplies the
//! `PrismHost` that makes both ends ordinary files, plus the handful of
//! commands the page calls.
//!
//! Everything the feature persists lives in one directory, `clash/` under the
//! app's data directory — the same folder the user drops `mihomo.exe` into.

pub mod api;
pub mod commands;
pub mod connections;
pub mod core;
mod host;
pub mod ipinfo;
pub mod logs;
pub mod metrics;
pub mod profiles;
pub mod proxies;
pub mod routing;
pub mod rules;
pub mod runtime;
pub mod settings;
mod state;
pub mod sitecheck;
pub mod store;
pub mod subscriptions;
pub mod sysproxy;

pub use state::ClashState;
