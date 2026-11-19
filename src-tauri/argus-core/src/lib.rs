// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! Process, system and hardware sampling plus process control for the task
//! manager page.
//!
//! The crate is deliberately UI-agnostic: everything here can later move behind
//! the privileged service's IPC without changing the data model.

#![cfg(windows)]

pub mod actions;
pub mod app_windows;
pub mod collector;
mod cpu;
pub mod details;
pub mod diagnostics;
pub mod disk_process;
pub mod error;
pub mod gpu_process;
pub mod hardware;
pub mod meta;
pub mod models;
pub mod net_process;
mod nt;
pub mod paths;
mod pdh;
pub mod privilege;
pub mod process;
pub mod services;
pub mod store;
pub mod system;
mod util;
mod webview;

mod image_paths;

pub use actions::{ActionError, Priority, TreeKillReport};
pub use collector::{Collector, Snapshot};
pub use details::ProcessDetails;
pub use error::{ArgusError, ArgusErrorCode};
pub use models::ArgusSettings;
pub use process::ProcessRow;
pub use services::{ServiceAction, ServiceCatalog, ServiceInfo, StartType};
pub use system::SystemStats;
