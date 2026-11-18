// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! UID selection, batched FETCH and incremental sync for one account.
//!
//! A0 placeholder: B2 implements this file. The entry point is frozen because
//! `sync.rs` calls it.

use crate::error::{OneMailError, OneMailResult};
use crate::models::{SyncMode, SyncReport};
use crate::state::OneMailState;

pub async fn sync_account(
    _state: &OneMailState,
    _account_id: i64,
    _mode: SyncMode,
) -> OneMailResult<SyncReport> {
    Err(OneMailError::not_implemented())
}
