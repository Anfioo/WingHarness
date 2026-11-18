// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Sync orchestration: acquire the one lock, walk the enabled accounts, emit
//! `one-mail:sync-progress` and let the caller cancel between batches.
//!
//! A0 placeholder: B2 implements this file.

use crate::error::{OneMailError, OneMailResult};
use crate::models::{SyncInput, SyncReport, SyncStatus};
use crate::state::OneMailState;

pub async fn start(_state: &OneMailState, _input: SyncInput) -> OneMailResult<SyncReport> {
    Err(OneMailError::not_implemented())
}

pub fn cancel(_state: &OneMailState) -> bool {
    false
}

pub async fn status(_state: &OneMailState) -> SyncStatus {
    SyncStatus {
        running: false,
        account_id: None,
        started_at: None,
        last_finished_at: None,
        last_error: None,
    }
}
