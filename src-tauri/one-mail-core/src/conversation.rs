// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Conversation aggregation: the person-centric list, the thread view and the
//! message lookup used by body loading.
//!
//! A0 placeholder: B3 implements this file.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{OneMailError, OneMailResult};
use crate::models::{
    ConversationMessagesQuery, ConversationPage, ConversationQuery, ConversationThread,
};

/// Where a message lives on the server, enough to FETCH it by UID.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageLocation {
    pub message_id: i64,
    pub account_id: i64,
    pub folder_id: i64,
    pub folder_path: String,
    pub uid: u32,
}

pub async fn list(
    _pool: &SqlitePool,
    _query: ConversationQuery,
) -> OneMailResult<ConversationPage> {
    Err(OneMailError::not_implemented())
}

pub async fn messages(
    _pool: &SqlitePool,
    _query: ConversationMessagesQuery,
) -> OneMailResult<ConversationThread> {
    Err(OneMailError::not_implemented())
}

pub async fn find_message(
    _pool: &SqlitePool,
    _message_id: i64,
) -> OneMailResult<Option<MessageLocation>> {
    Err(OneMailError::not_implemented())
}
