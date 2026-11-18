// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Local-first mail engine: accounts, IMAP/SMTP transport, MIME parsing,
//! conversation aggregation and compose.
//!
//! The crate owns every mail protocol detail. The Tauri commands in
//! `commands.rs` are thin forwards, so the root crate never links a mail
//! dependency. All persisted state lives under `paths::CONFIG_DIR`
//! (`<data dir>/one-mail`).

pub mod account;
pub mod commands;
pub mod compose;
pub mod conversation;
pub mod error;
pub mod imap;
pub mod message;
pub mod mime;
pub mod models;
pub mod paths;
pub mod provider;
pub mod schema;
pub mod search;
pub mod settings;
pub mod smtp;
pub mod state;
pub mod store;
pub mod sync;
pub mod transport;

pub use error::{OneMailError, OneMailErrorCode, OneMailResult};
pub use models::*;
pub use state::OneMailState;
