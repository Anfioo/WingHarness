// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! DDL and `PRAGMA user_version` migrations.
//!
//! A0 placeholder: B1 replaces this file with the real table set (accounts,
//! folders, messages, FTS5, outbox). For now it only leaves the pool usable.

use sqlx::SqlitePool;

use crate::error::{OneMailError, OneMailResult};

/// Apply every forward migration this build knows about. Idempotent.
pub async fn migrate(pool: &SqlitePool) -> OneMailResult<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS one_mail_smoke (id INTEGER PRIMARY KEY)")
        .execute(pool)
        .await
        .map_err(|error| OneMailError::database(format!("Could not initialise the mail schema: {error}")))?;
    Ok(())
}
