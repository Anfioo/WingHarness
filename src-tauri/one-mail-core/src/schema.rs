// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! DDL and `PRAGMA user_version` migrations.
//!
//! The table set is rewritten for sqlx: no OAuth tokens, no sync runs and no
//! remote operation queue (this release only reads the server). Two rules hold
//! everywhere below:
//!
//! * every child row cascades from its account, so deleting an account is one
//!   `DELETE` and the rest follows;
//! * the FTS5 table carries no foreign key — SQLite does not support them on a
//!   virtual table — so `account::remove` deletes its rows explicitly.
//!
//! Migration is forward only. `user_version` records what this build wrote; a
//! database from a newer build is left untouched instead of being downgraded.

use sqlx::SqlitePool;

use crate::error::{OneMailError, OneMailResult};

/// The schema version this build writes.
const SCHEMA_VERSION: i64 = 1;

/// Everything version 1 creates, in dependency order.
const STATEMENTS: &[&str] = &[
    // The A0 placeholder table. Dropping it keeps a database opened by the
    // baseline build clean instead of leaving a stray table behind.
    "DROP TABLE IF EXISTS one_mail_smoke",
    "CREATE TABLE IF NOT EXISTS accounts (
        account_id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_key TEXT NOT NULL,
        email TEXT NOT NULL,
        normalized_email TEXT NOT NULL,
        display_name TEXT,
        account_label TEXT NOT NULL,
        avatar_text TEXT NOT NULL,
        color_key TEXT NOT NULL,
        auth_type TEXT NOT NULL
            CHECK (auth_type IN ('oauth2', 'app_password', 'password', 'bridge', 'manual')),
        imap_host TEXT NOT NULL,
        imap_port INTEGER NOT NULL CHECK (imap_port BETWEEN 1 AND 65535),
        imap_security TEXT NOT NULL CHECK (imap_security IN ('ssl_tls', 'starttls', 'none')),
        smtp_host TEXT,
        smtp_port INTEGER CHECK (smtp_port IS NULL OR smtp_port BETWEEN 1 AND 65535),
        smtp_security TEXT
            CHECK (smtp_security IS NULL OR smtp_security IN ('ssl_tls', 'starttls', 'none')),
        smtp_auth_type TEXT
            CHECK (smtp_auth_type IS NULL
                OR smtp_auth_type IN ('oauth2', 'app_password', 'password', 'bridge', 'manual')),
        smtp_enabled INTEGER NOT NULL DEFAULT 1 CHECK (smtp_enabled IN (0, 1)),
        sync_enabled INTEGER NOT NULL DEFAULT 1 CHECK (sync_enabled IN (0, 1)),
        password TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'disabled', 'syncing', 'auth_error', 'sync_error',
                              'network_error')),
        last_sync_at TEXT,
        last_error TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (normalized_email)
    )",
    "CREATE TABLE IF NOT EXISTS folders (
        folder_id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        delimiter TEXT,
        role TEXT NOT NULL DEFAULT 'custom'
            CHECK (role IN ('inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'all_mail',
                            'important', 'starred', 'custom')),
        is_selectable INTEGER NOT NULL DEFAULT 1 CHECK (is_selectable IN (0, 1)),
        is_subscribed INTEGER NOT NULL DEFAULT 1 CHECK (is_subscribed IN (0, 1)),
        sync_enabled INTEGER NOT NULL DEFAULT 0 CHECK (sync_enabled IN (0, 1)),
        total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
        unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
        last_sync_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts (account_id) ON DELETE CASCADE,
        UNIQUE (account_id, path)
    )",
    "CREATE INDEX IF NOT EXISTS idx_folders_account ON folders (account_id)",
    "CREATE TABLE IF NOT EXISTS folder_sync_states (
        folder_id INTEGER PRIMARY KEY,
        last_uid INTEGER NOT NULL DEFAULT 0 CHECK (last_uid >= 0),
        uid_validity TEXT,
        last_full_scan_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'syncing', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (folder_id) REFERENCES folders (folder_id) ON DELETE CASCADE
    )",
    "CREATE TABLE IF NOT EXISTS messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        folder_id INTEGER NOT NULL,
        uid INTEGER NOT NULL CHECK (uid > 0),
        rfc822_message_id TEXT,
        thread_key TEXT,
        in_reply_to TEXT,
        references_header TEXT,
        subject TEXT,
        from_name TEXT,
        from_email TEXT,
        sent_at TEXT,
        received_at TEXT,
        snippet TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
        is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
        is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
        is_answered INTEGER NOT NULL DEFAULT 0 CHECK (is_answered IN (0, 1)),
        is_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0, 1)),
        has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
        body_status TEXT NOT NULL DEFAULT 'none'
            CHECK (body_status IN ('none', 'loading', 'ready', 'error')),
        body_error TEXT,
        raw_headers TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts (account_id) ON DELETE CASCADE,
        FOREIGN KEY (folder_id) REFERENCES folders (folder_id) ON DELETE CASCADE,
        UNIQUE (account_id, folder_id, uid)
    )",
    "CREATE INDEX IF NOT EXISTS idx_messages_account_received
        ON messages (account_id, received_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_messages_rfc822
        ON messages (rfc822_message_id)",
    "CREATE TABLE IF NOT EXISTS message_addresses (
        address_id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        kind TEXT NOT NULL
            CHECK (kind IN ('from', 'sender', 'to', 'cc', 'bcc', 'reply_to')),
        name TEXT,
        email TEXT NOT NULL,
        normalized_email TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages (message_id) ON DELETE CASCADE
    )",
    "CREATE INDEX IF NOT EXISTS idx_message_addresses_email
        ON message_addresses (normalized_email)",
    "CREATE TABLE IF NOT EXISTS message_bodies (
        message_id INTEGER PRIMARY KEY,
        body_text TEXT,
        body_html TEXT,
        loaded_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages (message_id) ON DELETE CASCADE
    )",
    "CREATE TABLE IF NOT EXISTS message_attachments (
        attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        part_id TEXT,
        content_id TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT,
        content_disposition TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
        created_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages (message_id) ON DELETE CASCADE
    )",
    // `trigram` is what makes a substring search work for Chinese, where
    // `unicode61` would index a whole sentence as one token. It needs SQLite
    // 3.34+; the bundled build has it, and a build that lacks it must fail the
    // migration loudly rather than fall back to a tokenizer that cannot match.
    "CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
        message_id UNINDEXED,
        account_id UNINDEXED,
        folder_id UNINDEXED,
        subject,
        from_name,
        from_email,
        snippet,
        body_text,
        tokenize = 'trigram'
    )",
    "CREATE TABLE IF NOT EXISTS outbox_messages (
        outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        related_message_id INTEGER,
        compose_kind TEXT NOT NULL CHECK (compose_kind IN ('new', 'reply', 'reply_all', 'forward')),
        status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft', 'queued', 'sending', 'sent', 'failed', 'cancelled')),
        rfc822_message_id TEXT,
        in_reply_to TEXT,
        references_header TEXT,
        from_email TEXT NOT NULL,
        to_json TEXT NOT NULL DEFAULT '[]',
        cc_json TEXT NOT NULL DEFAULT '[]',
        bcc_json TEXT NOT NULL DEFAULT '[]',
        subject TEXT,
        body_text TEXT,
        body_html TEXT,
        sent_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts (account_id) ON DELETE CASCADE,
        FOREIGN KEY (related_message_id) REFERENCES messages (message_id) ON DELETE SET NULL
    )",
    "CREATE INDEX IF NOT EXISTS idx_outbox_messages_account_status
        ON outbox_messages (account_id, status)",
    "CREATE TABLE IF NOT EXISTS outbox_attachments (
        attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        outbox_id INTEGER NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'local_file'
            CHECK (source_kind IN ('local_file', 'forwarded_attachment')),
        file_path TEXT,
        filename TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
        content_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (outbox_id) REFERENCES outbox_messages (outbox_id) ON DELETE CASCADE
    )",
];

/// Apply every forward migration this build knows about. Idempotent: a
/// database already at [SCHEMA_VERSION] is left alone, and a newer one is not
/// touched at all.
pub async fn migrate(pool: &SqlitePool) -> OneMailResult<()> {
    let current = read_version(pool).await?;
    if current >= SCHEMA_VERSION {
        if current > SCHEMA_VERSION {
            log::warn!(
                "one_mail_schema_newer database={current} build={SCHEMA_VERSION} action=skip"
            );
        }
        return Ok(());
    }

    // One transaction for the whole step: a half-created schema would be worse
    // than no schema at all, and SQLite rolls DDL back with the rest.
    let mut transaction = pool.begin().await.map_err(|error| {
        log::warn!("one_mail_schema_transaction_failed error={error}");
        OneMailError::database("The mail database could not start a migration.")
    })?;

    for &statement in STATEMENTS {
        sqlx::query(statement)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                log::warn!("one_mail_schema_statement_failed error={error}");
                OneMailError::database(format!("The mail schema could not be created: {error}"))
            })?;
    }

    // `PRAGMA user_version` takes a literal, never a bind parameter. The value
    // is this build's own constant, so wrapping it is the audited case
    // `AssertSqlSafe` exists for.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA user_version = {SCHEMA_VERSION}"
    )))
    .execute(&mut *transaction)
    .await
    .map_err(|error| {
        log::warn!("one_mail_schema_version_write_failed error={error}");
        OneMailError::database("The mail schema version could not be recorded.")
    })?;

    transaction.commit().await.map_err(|error| {
        log::warn!("one_mail_schema_commit_failed error={error}");
        OneMailError::database("The mail schema migration could not be committed.")
    })?;

    log::info!("one_mail_schema_migrated from={current} to={SCHEMA_VERSION}");
    Ok(())
}

async fn read_version(pool: &SqlitePool) -> OneMailResult<i64> {
    sqlx::query_scalar::<_, i64>("PRAGMA user_version")
        .fetch_one(pool)
        .await
        .map_err(|error| {
            log::warn!("one_mail_schema_version_read_failed error={error}");
            OneMailError::database("The mail database version could not be read.")
        })
}

#[cfg(test)]
mod tests {
    use super::{migrate, read_version, SCHEMA_VERSION};
    use crate::store;

    #[tokio::test]
    async fn creates_every_table_and_records_the_version() {
        let directory = tempfile::tempdir().unwrap();
        let pool = store::open_at(&directory.path().join("onemail.db"))
            .await
            .unwrap();

        assert_eq!(read_version(&pool).await.unwrap(), SCHEMA_VERSION);
        for table in [
            "accounts",
            "folders",
            "folder_sync_states",
            "messages",
            "message_addresses",
            "message_bodies",
            "message_attachments",
            "message_search",
            "outbox_messages",
            "outbox_attachments",
        ] {
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = ?1")
                    .bind(table)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 1, "missing table {table}");
        }
    }

    /// A database written by a newer build must not be downgraded: the build
    /// cannot know what that version wrote, so it leaves the file alone.
    #[tokio::test]
    async fn a_newer_schema_version_is_left_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let pool = store::open_at(&directory.path().join("onemail.db"))
            .await
            .unwrap();
        sqlx::query("PRAGMA user_version = 99")
            .execute(&pool)
            .await
            .unwrap();

        migrate(&pool).await.unwrap();

        assert_eq!(read_version(&pool).await.unwrap(), 99);
    }

    #[tokio::test]
    async fn migrating_twice_is_a_no_op() {
        let directory = tempfile::tempdir().unwrap();
        let pool = store::open_at(&directory.path().join("onemail.db"))
            .await
            .unwrap();

        migrate(&pool).await.unwrap();
        migrate(&pool).await.unwrap();

        assert_eq!(read_version(&pool).await.unwrap(), SCHEMA_VERSION);
    }

    /// The FTS5 table is the one piece of the schema a bundled SQLite could
    /// lack. If this fails the build has no `trigram` tokenizer and search would
    /// silently miss Chinese text.
    #[tokio::test]
    async fn message_search_accepts_a_trigram_match() {
        let directory = tempfile::tempdir().unwrap();
        let pool = store::open_at(&directory.path().join("onemail.db"))
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO message_search (message_id, account_id, folder_id, subject, body_text)
             VALUES (1, 1, 1, 'Quarterly report', 'Please review the numbers before Friday')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let hits: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM message_search WHERE message_search MATCH 'review the num'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(hits, 1);
    }

    #[tokio::test]
    async fn deleting_an_account_cascades_every_child_row() {
        let directory = tempfile::tempdir().unwrap();
        let pool = store::open_at(&directory.path().join("onemail.db"))
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO accounts (account_id, provider_key, email, normalized_email,
               account_label, avatar_text, color_key, auth_type, imap_host, imap_port,
               imap_security, password, created_at, updated_at)
             VALUES (1, '163', 'a@163.com', 'a@163.com', 'a', 'A', 'blue', 'app_password',
               'imap.163.com', 993, 'ssl_tls', 'secret', '2026-01-01T00:00:00+00:00',
               '2026-01-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO folders (folder_id, account_id, path, name, role, sync_enabled,
               created_at, updated_at)
             VALUES (1, 1, 'INBOX', 'INBOX', 'inbox', 1, '2026-01-01T00:00:00+00:00',
               '2026-01-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messages (message_id, account_id, folder_id, uid, created_at, updated_at)
             VALUES (1, 1, 1, 7, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO message_addresses (message_id, kind, email, normalized_email, created_at)
             VALUES (1, 'from', 'a@163.com', 'a@163.com', '2026-01-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO message_bodies (message_id, loaded_at)
             VALUES (1, '2026-01-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO message_attachments (message_id, filename, created_at)
             VALUES (1, 'report.pdf', '2026-01-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("DELETE FROM accounts WHERE account_id = 1")
            .execute(&pool)
            .await
            .unwrap();

        for table in [
            "accounts",
            "folders",
            "messages",
            "message_addresses",
            "message_bodies",
            "message_attachments",
        ] {
            let count: i64 =
                sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(count, 0, "{table} kept a row after the account was deleted");
        }
    }
}
