// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! The SQLite pool and the `settings.json` document.
//!
//! A0 placeholder: while the pool is an in-memory database, every command that
//! reaches a domain stub still fails with `not-implemented`, but the IPC surface
//! itself can be smoke-tested. B1 replaces this file with the real
//! `<data dir>/one-mail/onemail.db` pool (WAL, foreign keys, max 4 connections)
//! and the JSON store next to it.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::error::{OneMailError, OneMailResult};

/// Open the mail database, running the schema migrations on first connect.
pub async fn connect() -> OneMailResult<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .in_memory(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| OneMailError::database(format!("Could not open the mail database: {error}")))?;
    crate::schema::migrate(&pool).await?;
    Ok(pool)
}
