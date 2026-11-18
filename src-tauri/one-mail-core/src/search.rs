// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! FTS5 search with the short-query LIKE fallback and the local filters.
//!
//! A0 placeholder: B3 implements this file.

use sqlx::SqlitePool;

use crate::error::{OneMailError, OneMailResult};
use crate::models::{MessageSearchPage, SearchQuery};

pub async fn search(
    _pool: &SqlitePool,
    _query: SearchQuery,
) -> OneMailResult<MessageSearchPage> {
    Err(OneMailError::not_implemented())
}
