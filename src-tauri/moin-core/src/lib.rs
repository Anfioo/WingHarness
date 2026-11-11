// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! HTTP download engine for WingHarness.
//!
//! Layer order: `models`/`error`/`paths` are leaf modules, `store`/`settings`/
//! `category` persist them, `backend`/`segmented` move bytes, `engine` runs the
//! queue, `state` binds it to Tauri and `commands` exposes it over IPC.

mod backend;
mod category;
pub mod commands;
mod engine;
pub mod error;
pub mod events;
pub mod models;
pub mod paths;
mod segmented;
mod settings;
pub mod state;
mod store;

pub use backend::{Control, DownloadBackend, NetConfig, Outcome, Signal, TransferOpts};
pub use engine::{Emitter, Engine};
pub use error::{MoinError, MoinErrorCode, MoinResult};
pub use models::{
    AddMethodKind, BackendInfo, Category, RpcStatus, Settings, Task, TaskKind, TaskProgress,
    TaskStatus, ToolSource, ToolStatus, Trigger,
};
pub use state::{shutdown, MoinState, TauriEmitter};
