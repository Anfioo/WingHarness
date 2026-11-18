// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Message detail, body loading, raw view and the local read/star flags.
//!
//! A0 placeholder: B3 implements this file.

use sqlx::SqlitePool;

use crate::error::{OneMailError, OneMailResult};
use crate::models::{
    MessageBodyLoad, MessageDetail, MessageSummary, RawMessage,
};
use crate::state::OneMailState;

pub async fn get(_pool: &SqlitePool, _message_id: i64) -> OneMailResult<MessageDetail> {
    Err(OneMailError::not_implemented())
}

pub async fn body_load(
    _state: &OneMailState,
    _message_id: i64,
) -> OneMailResult<MessageBodyLoad> {
    Err(OneMailError::not_implemented())
}

pub async fn set_read(
    _pool: &SqlitePool,
    _message_id: i64,
    _read: bool,
) -> OneMailResult<MessageSummary> {
    Err(OneMailError::not_implemented())
}

pub async fn set_starred(
    _pool: &SqlitePool,
    _message_id: i64,
    _starred: bool,
) -> OneMailResult<MessageSummary> {
    Err(OneMailError::not_implemented())
}

pub async fn raw(_pool: &SqlitePool, _message_id: i64) -> OneMailResult<RawMessage> {
    Err(OneMailError::not_implemented())
}
