// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! The Tauri-managed state: the lazily opened SQLite pool, the one sync lock and
//! the IPC event names.

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter as TauriEmitter, Manager};
use tokio::sync::{Mutex, OnceCell};
use tokio_util::sync::CancellationToken;

use crate::error::OneMailResult;
use crate::paths;

pub const EVENT_SYNC_PROGRESS: &str = "one-mail:sync-progress";
pub const EVENT_NEW_MAIL: &str = "one-mail:new-mail";
pub const EVENT_MAILBOX_CHANGED: &str = "one-mail:mailbox-changed";
pub const EVENT_ACCOUNTS_CHANGED: &str = "one-mail:accounts-changed";
pub const EVENT_OUTBOX_CHANGED: &str = "one-mail:outbox-changed";
pub const EVENT_SETTINGS_CHANGED: &str = "one-mail:settings-changed";

/// What the sync lock guards: the running flag, the account being synced and
/// the token that lets `one_mail_sync_cancel` stop the work between batches.
///
/// The lock is never held across a network request.
pub struct SyncRuntime {
    pub running: bool,
    pub account_id: Option<i64>,
    pub started_at: Option<String>,
    pub cancel: CancellationToken,
}

impl Default for SyncRuntime {
    fn default() -> Self {
        Self {
            running: false,
            account_id: None,
            started_at: None,
            cancel: CancellationToken::new(),
        }
    }
}

/// The state managed by the root crate at startup.
pub struct OneMailState {
    app: AppHandle,
    pool: OnceCell<SqlitePool>,
    sync: Mutex<SyncRuntime>,
}

impl OneMailState {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pool: OnceCell::new(),
            sync: Mutex::new(SyncRuntime::default()),
        }
    }

    /// Open the database on first use and cache the pool. A `OnceCell` (not a
    /// plain flag) is what stops two concurrent first calls from opening two
    /// pools on the same file.
    pub async fn pool(&self) -> OneMailResult<SqlitePool> {
        paths::ensure_dir()?;
        let pool = self
            .pool
            .get_or_try_init(|| async { crate::store::connect().await })
            .await?;
        Ok(pool.clone())
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    pub fn emit<T: Serialize + Clone>(&self, event: &str, payload: T) {
        if let Err(error) = self.app.emit(event, payload) {
            log::warn!("Could not emit {event}: {error}");
        }
    }

    pub fn sync(&self) -> &Mutex<SyncRuntime> {
        &self.sync
    }
}

/// Called from `RunEvent::Exit`: stop a running sync and close the pool so the
/// SQLite file is left consistent.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<OneMailState>() else {
        return;
    };
    if let Ok(runtime) = state.sync.try_lock() {
        runtime.cancel.cancel();
    }
    if let Some(pool) = state.pool.get() {
        tauri::async_runtime::block_on(pool.clone().close());
    }
}
