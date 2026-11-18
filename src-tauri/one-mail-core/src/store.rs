// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! The SQLite pool behind `<data dir>/one-mail/onemail.db`.
//!
//! One file holds accounts, folders, messages, bodies, attachments, the FTS5
//! index and the outbox, so the whole mail database moves with the data
//! directory. It is opened in WAL mode with foreign keys on (the schema relies
//! on `ON DELETE CASCADE` for account deletion) and a five second busy timeout,
//! because the sync lane, the page and the command layer all reach it.
//!
//! The pool is cached by `state::OneMailState`; opening twice would put two
//! writers on the same file.

use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::error::{OneMailError, OneMailResult};
use crate::paths;

/// Open the mail database, running the schema migrations on first connect.
pub async fn connect() -> OneMailResult<SqlitePool> {
    paths::ensure_dir()?;
    let path = paths::db_path()?;
    open_at(&path).await
}

/// Open (or create) the database at an explicit path and migrate it.
///
/// `pub(crate)` and not public: the only production caller is [`connect`], and
/// the tests and the migration need a path they own. Nothing outside the crate
/// gets to point the engine at an arbitrary file.
pub(crate) async fn open_at(path: &Path) -> OneMailResult<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .map_err(|error| {
            log::warn!(
                "one_mail_db_open_failed path={} error={error}",
                path.display()
            );
            OneMailError::database("The mail database could not be opened.")
        })?;

    crate::schema::migrate(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::open_at;

    #[tokio::test]
    async fn opens_creates_and_migrates_a_database() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("onemail.db");
        assert!(!file.exists());

        let pool = open_at(&file).await.unwrap();

        assert!(file.exists());
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version, 1);
    }

    #[tokio::test]
    async fn reopens_an_existing_database_without_losing_rows() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("onemail.db");
        let pool = open_at(&file).await.unwrap();
        sqlx::query("INSERT INTO message_search (message_id, account_id, folder_id, subject) VALUES (1, 1, 1, 'kept')")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let reopened = open_at(&file).await.unwrap();
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM message_search")
            .fetch_one(&reopened)
            .await
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[tokio::test]
    async fn foreign_keys_are_on() {
        let directory = tempfile::tempdir().unwrap();
        let pool = open_at(&directory.path().join("onemail.db")).await.unwrap();

        // A folder whose account does not exist must be refused, which is only
        // true when `PRAGMA foreign_keys` is on for this connection.
        let result = sqlx::query(
            "INSERT INTO folders (account_id, path, name, created_at, updated_at)
             VALUES (99, 'INBOX', 'INBOX', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await;

        assert!(result.is_err());
    }
}
