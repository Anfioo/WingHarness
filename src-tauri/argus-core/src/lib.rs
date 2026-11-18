// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! Process, system and hardware sampling plus process control for the task
//! manager page.
//!
//! The crate is deliberately UI-agnostic: everything here can later move behind
//! the privileged service's IPC without changing the data model.

#![cfg(windows)]

pub mod actions;
pub mod collector;
pub mod details;
pub mod error;
pub mod hardware;
pub mod models;
pub mod paths;
pub mod privilege;
pub mod process;
pub mod store;
pub mod system;

pub use actions::{ActionError, Priority, TreeKillReport};
pub use collector::{Collector, Snapshot};
pub use details::ProcessDetails;
pub use error::{ArgusError, ArgusErrorCode};
pub use models::ArgusSettings;
pub use process::ProcessRow;
pub use system::SystemStats;
