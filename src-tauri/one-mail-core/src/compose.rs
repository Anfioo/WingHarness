// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Drafts, reply/forward prefill, sending and the outbox.
//!
//! A0 placeholder: B3 implements this file. `send` goes through
//! `smtp::send` (B2); the outbox tables come from B1.

use tauri::AppHandle;
use sqlx::SqlitePool;

use crate::error::{OneMailError, OneMailResult};
use crate::models::{Draft, DraftInput, OutboxItem, PickedAttachment, SendInput, SendResult};
use crate::state::OneMailState;

pub async fn save_draft(_pool: &SqlitePool, _input: DraftInput) -> OneMailResult<Draft> {
    Err(OneMailError::not_implemented())
}

pub async fn delete_draft(_pool: &SqlitePool, _outbox_id: i64) -> OneMailResult<bool> {
    Err(OneMailError::not_implemented())
}

pub async fn reply_draft(
    _pool: &SqlitePool,
    _message_id: i64,
    _reply_all: bool,
) -> OneMailResult<Draft> {
    Err(OneMailError::not_implemented())
}

pub async fn forward_draft(_pool: &SqlitePool, _message_id: i64) -> OneMailResult<Draft> {
    Err(OneMailError::not_implemented())
}

pub async fn send(_state: &OneMailState, _input: SendInput) -> OneMailResult<SendResult> {
    Err(OneMailError::not_implemented())
}

pub async fn retry(_state: &OneMailState, _outbox_id: i64) -> OneMailResult<SendResult> {
    Err(OneMailError::not_implemented())
}

pub async fn list_outbox(
    _pool: &SqlitePool,
    _account_id: Option<i64>,
) -> OneMailResult<Vec<OutboxItem>> {
    Err(OneMailError::not_implemented())
}

pub async fn get_outbox(_pool: &SqlitePool, _outbox_id: i64) -> OneMailResult<Draft> {
    Err(OneMailError::not_implemented())
}

pub async fn delete_outbox(_pool: &SqlitePool, _outbox_id: i64) -> OneMailResult<bool> {
    Err(OneMailError::not_implemented())
}

pub async fn pick_attachments(_app: &AppHandle) -> OneMailResult<Vec<PickedAttachment>> {
    Err(OneMailError::not_implemented())
}
