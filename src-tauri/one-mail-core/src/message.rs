// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Message detail, body loading, raw view and the local read/star flags.
//!
//! The body is fetched on demand with `transport::fetch_raw_message` and parsed
//! by `mime::parse`; one transaction then replaces the cached body, the
//! attachment metadata, the participant rows and the FTS row, and marks the
//! message read locally. Reading never writes `\Seen` back to the server in this
//! release.

use std::collections::HashMap;

use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use crate::error::{OneMailError, OneMailResult};
use crate::models::{
    AttachmentInfo, BodyStatus, FolderRole, MailAddress, MessageBody, MessageBodyLoad,
    MessageDetail, MessageSummary, RawMessage,
};
use crate::state::OneMailState;
use crate::{conversation, mime, transport};

pub async fn get(pool: &SqlitePool, message_id: i64) -> OneMailResult<MessageDetail> {
    let summary = summary_for(pool, message_id)
        .await?
        .ok_or_else(|| not_found(message_id))?;
    let body = load_body(pool, message_id).await?;
    let attachments = load_attachments(pool, message_id).await?;
    Ok(MessageDetail {
        summary,
        body,
        attachments,
    })
}

pub async fn body_load(state: &OneMailState, message_id: i64) -> OneMailResult<MessageBodyLoad> {
    let pool = state.pool().await?;
    let Some(location) = conversation::find_message(&pool, message_id).await? else {
        return Err(not_found(message_id));
    };

    let stored_status: Option<String> =
        sqlx::query_scalar("SELECT body_status FROM messages WHERE message_id = ?1")
            .bind(message_id)
            .fetch_optional(&pool)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not read the body status: {error}"))
            })?;
    let status = stored_status
        .as_deref()
        .and_then(BodyStatus::parse)
        .unwrap_or(BodyStatus::None);
    if status == BodyStatus::Ready {
        return Ok(MessageBodyLoad {
            body: load_body(&pool, message_id).await?,
            error: None,
        });
    }

    set_body_status(&pool, message_id, BodyStatus::Loading, None).await?;

    let fetched = async {
        let raw = transport::fetch_raw_message(
            state,
            location.account_id,
            &location.folder_path,
            location.uid,
        )
        .await?;
        mime::parse(&raw)
    }
    .await;

    let parsed = match fetched {
        Ok(parsed) => parsed,
        Err(error) => {
            // A failed fetch is reported in the payload, not as a command error:
            // the card needs to render its retry button with the reason.
            let message = truncate(&error.message, 300);
            let _ = set_body_status(&pool, message_id, BodyStatus::Error, Some(&message)).await;
            return Ok(MessageBodyLoad {
                body: None,
                error: Some(message),
            });
        }
    };

    let body = persist_body(&pool, &location, parsed).await?;
    Ok(MessageBodyLoad {
        body: Some(body),
        error: None,
    })
}

pub async fn set_read(
    pool: &SqlitePool,
    message_id: i64,
    read: bool,
) -> OneMailResult<MessageSummary> {
    update_flag(pool, message_id, "is_read", read).await
}

pub async fn set_starred(
    pool: &SqlitePool,
    message_id: i64,
    starred: bool,
) -> OneMailResult<MessageSummary> {
    update_flag(pool, message_id, "is_starred", starred).await
}

pub async fn raw(pool: &SqlitePool, message_id: i64) -> OneMailResult<RawMessage> {
    let row = sqlx::query(
        "SELECT m.raw_headers, m.size_bytes, b.body_text, b.body_html
         FROM messages m
         LEFT JOIN message_bodies b ON b.message_id = m.message_id
         WHERE m.message_id = ?1",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| OneMailError::database(format!("Could not read the raw message: {error}")))?;
    let Some(row) = row else {
        return Err(not_found(message_id));
    };
    Ok(RawMessage {
        headers: optional_string(&row, "raw_headers").unwrap_or_default(),
        body_text: optional_string(&row, "body_text"),
        body_html: optional_string(&row, "body_html"),
        size_bytes: sqlx::Row::try_get(&row, "size_bytes").unwrap_or(0),
    })
}

// ---------------------------------------------------------------------------
// Body persistence
// ---------------------------------------------------------------------------

/// Write one parsed message: body, attachment metadata, participants, the
/// header fields a body fetch can fill in, the FTS row and the local read flag.
async fn persist_body(
    pool: &SqlitePool,
    location: &conversation::MessageLocation,
    parsed: mime::ParsedMessage,
) -> OneMailResult<MessageBody> {
    let now = now_iso8601();
    let message_id = location.message_id;
    let has_attachments = if parsed.attachments.is_empty() {
        0_i64
    } else {
        1_i64
    };
    let search_text = parsed
        .body_text
        .as_deref()
        .map(str::to_string)
        .or_else(|| parsed.body_html.as_deref().map(mime::html_to_text))
        .unwrap_or_default();

    let mut transaction = pool.begin().await.map_err(|error| {
        OneMailError::database(format!("Could not start saving the message body: {error}"))
    })?;

    sqlx::query(
        "INSERT INTO message_bodies (message_id, body_text, body_html, loaded_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(message_id) DO UPDATE SET
             body_text = excluded.body_text,
             body_html = excluded.body_html,
             loaded_at = excluded.loaded_at",
    )
    .bind(message_id)
    .bind(parsed.body_text.clone())
    .bind(parsed.body_html.clone())
    .bind(&now)
    .execute(&mut *transaction)
    .await
    .map_err(|error| OneMailError::database(format!("Could not save the message body: {error}")))?;

    sqlx::query("DELETE FROM message_attachments WHERE message_id = ?1")
        .bind(message_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not refresh the attachments: {error}"))
        })?;
    for attachment in &parsed.attachments {
        sqlx::query(
            "INSERT INTO message_attachments
                 (message_id, part_id, content_id, filename, mime_type, content_disposition,
                  size_bytes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(message_id)
        .bind(attachment.part_id.clone())
        .bind(attachment.content_id.clone())
        .bind(&attachment.filename)
        .bind(attachment.mime_type.clone())
        .bind(attachment.disposition.clone())
        .bind(attachment.size_bytes)
        .bind(&now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not save an attachment: {error}"))
        })?;
    }

    sqlx::query("DELETE FROM message_addresses WHERE message_id = ?1")
        .bind(message_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not refresh the participants: {error}"))
        })?;
    for group in &parsed.addresses {
        for (order, (name, email)) in group.addresses.iter().enumerate() {
            let email = email.trim();
            let normalized = email.to_lowercase();
            if normalized.is_empty() {
                continue;
            }
            sqlx::query(
                "INSERT INTO message_addresses
                     (message_id, kind, name, email, normalized_email, sort_order, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .bind(message_id)
            .bind(&group.kind)
            .bind(name.clone())
            .bind(email)
            .bind(normalized)
            .bind(order as i64)
            .bind(&now)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not save a participant: {error}"))
            })?;
        }
    }

    sqlx::query(
        "UPDATE messages SET
             subject = COALESCE(NULLIF(TRIM(?2), ''), subject),
             from_name = COALESCE(NULLIF(TRIM(?3), ''), from_name),
             from_email = COALESCE(NULLIF(TRIM(?4), ''), from_email),
             snippet = COALESCE(NULLIF(TRIM(?5), ''), snippet),
             raw_headers = COALESCE(NULLIF(?6, ''), raw_headers),
             has_attachments = ?7,
             body_status = 'ready',
             body_error = NULL,
             is_read = 1,
             updated_at = ?8
         WHERE message_id = ?1",
    )
    .bind(message_id)
    .bind(parsed.subject.clone())
    .bind(parsed.from_name.clone())
    .bind(parsed.from_email.clone())
    .bind(parsed.snippet.clone())
    .bind(&parsed.raw_headers)
    .bind(has_attachments)
    .bind(&now)
    .execute(&mut *transaction)
    .await
    .map_err(|error| {
        OneMailError::database(format!("Could not update the message header: {error}"))
    })?;

    sqlx::query("DELETE FROM message_search WHERE message_id = ?1")
        .bind(message_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not clear the search row: {error}"))
        })?;
    sqlx::query(
        "INSERT INTO message_search
             (message_id, account_id, folder_id, subject, from_name, from_email, snippet, body_text)
         SELECT message_id, account_id, folder_id, subject, from_name, from_email, snippet, ?2
         FROM messages WHERE message_id = ?1",
    )
    .bind(message_id)
    .bind(&search_text)
    .execute(&mut *transaction)
    .await
    .map_err(|error| OneMailError::database(format!("Could not index the message: {error}")))?;

    transaction.commit().await.map_err(|error| {
        OneMailError::database(format!("Could not commit the message body: {error}"))
    })?;

    Ok(MessageBody {
        message_id,
        body_text: parsed.body_text,
        body_html: parsed.body_html,
    })
}

async fn set_body_status(
    pool: &SqlitePool,
    message_id: i64,
    status: BodyStatus,
    error: Option<&str>,
) -> OneMailResult<()> {
    sqlx::query(
        "UPDATE messages SET body_status = ?2, body_error = ?3, updated_at = ?4
         WHERE message_id = ?1",
    )
    .bind(message_id)
    .bind(status.as_str())
    .bind(error)
    .bind(now_iso8601())
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|error| OneMailError::database(format!("Could not set the body status: {error}")))
}

async fn load_body(pool: &SqlitePool, message_id: i64) -> OneMailResult<Option<MessageBody>> {
    let row = sqlx::query("SELECT body_text, body_html FROM message_bodies WHERE message_id = ?1")
        .bind(message_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| OneMailError::database(format!("Could not read the body: {error}")))?;
    Ok(row.map(|row| MessageBody {
        message_id,
        body_text: optional_string(&row, "body_text"),
        body_html: optional_string(&row, "body_html"),
    }))
}

async fn load_attachments(
    pool: &SqlitePool,
    message_id: i64,
) -> OneMailResult<Vec<AttachmentInfo>> {
    let rows = sqlx::query(
        "SELECT attachment_id, filename, mime_type, content_disposition, size_bytes
         FROM message_attachments WHERE message_id = ?1 ORDER BY attachment_id",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(|error| OneMailError::database(format!("Could not read the attachments: {error}")))?;
    Ok(rows
        .iter()
        .map(|row| AttachmentInfo {
            attachment_id: sqlx::Row::try_get(row, "attachment_id").unwrap_or_default(),
            filename: sqlx::Row::try_get(row, "filename").unwrap_or_default(),
            mime_type: optional_string(row, "mime_type"),
            content_disposition: optional_string(row, "content_disposition"),
            size_bytes: sqlx::Row::try_get(row, "size_bytes").unwrap_or_default(),
        })
        .collect())
}

async fn update_flag(
    pool: &SqlitePool,
    message_id: i64,
    column: &'static str,
    value: bool,
) -> OneMailResult<MessageSummary> {
    // `column` is one of two hard-coded names, never frontend input.
    let sql = format!("UPDATE messages SET {column} = ?2, updated_at = ?3 WHERE message_id = ?1");
    let updated = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(message_id)
        .bind(i64::from(value))
        .bind(now_iso8601())
        .execute(pool)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not update the message flag: {error}"))
        })?;
    if updated.rows_affected() == 0 {
        return Err(not_found(message_id));
    }
    summary_for(pool, message_id)
        .await?
        .ok_or_else(|| not_found(message_id))
}

// ---------------------------------------------------------------------------
// Summary loading shared with the conversation and search views
// ---------------------------------------------------------------------------

/// Load the list-row projections for a set of messages in one query per table.
pub(crate) async fn summaries(
    pool: &SqlitePool,
    message_ids: &[i64],
) -> OneMailResult<HashMap<i64, MessageSummary>> {
    let mut result = HashMap::new();
    if message_ids.is_empty() {
        return Ok(result);
    }

    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT m.message_id, m.account_id, m.folder_id, f.path AS folder_path,
                f.role AS folder_role, m.subject, m.from_name, m.from_email, m.received_at,
                m.snippet, m.is_read, m.is_starred, m.has_attachments, m.body_status,
                m.body_error
         FROM messages m
         JOIN folders f ON f.folder_id = m.folder_id
         WHERE m.message_id IN (",
    );
    let mut separated = builder.separated(", ");
    for message_id in message_ids {
        separated.push_bind(*message_id);
    }
    separated.push_unseparated(")");

    let rows = builder.build().fetch_all(pool).await.map_err(|error| {
        OneMailError::database(format!("Could not read the message summaries: {error}"))
    })?;

    let mut addresses: HashMap<i64, (Vec<MailAddress>, Vec<MailAddress>)> = HashMap::new();
    let mut address_builder = QueryBuilder::<Sqlite>::new(
        "SELECT message_id, kind, name, email FROM message_addresses
         WHERE kind IN ('to', 'cc') AND message_id IN (",
    );
    let mut address_separated = address_builder.separated(", ");
    for message_id in message_ids {
        address_separated.push_bind(*message_id);
    }
    address_separated.push_unseparated(") ORDER BY message_id, sort_order, address_id");
    let address_rows = address_builder
        .build()
        .fetch_all(pool)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not read the message participants: {error}"))
        })?;
    for row in &address_rows {
        let message_id: i64 = sqlx::Row::try_get(row, "message_id").map_err(row_error)?;
        let kind: String = sqlx::Row::try_get(row, "kind").map_err(row_error)?;
        let address = MailAddress {
            name: optional_string(row, "name"),
            email: sqlx::Row::try_get(row, "email").unwrap_or_default(),
        };
        let entry = addresses.entry(message_id).or_default();
        if kind == "to" {
            entry.0.push(address);
        } else {
            entry.1.push(address);
        }
    }

    for row in &rows {
        let message_id: i64 = sqlx::Row::try_get(row, "message_id").map_err(row_error)?;
        let (to, cc) = addresses.remove(&message_id).unwrap_or_default();
        result.insert(
            message_id,
            MessageSummary {
                message_id,
                account_id: sqlx::Row::try_get(row, "account_id").map_err(row_error)?,
                folder_id: sqlx::Row::try_get(row, "folder_id").map_err(row_error)?,
                folder_path: sqlx::Row::try_get(row, "folder_path").unwrap_or_default(),
                folder_role: sqlx::Row::try_get::<String, _>(row, "folder_role")
                    .ok()
                    .and_then(|value| FolderRole::parse(&value))
                    .unwrap_or(FolderRole::Custom),
                subject: optional_string(row, "subject"),
                from_name: optional_string(row, "from_name"),
                from_email: optional_string(row, "from_email"),
                to,
                cc,
                received_at: optional_string(row, "received_at"),
                snippet: optional_string(row, "snippet"),
                is_read: sqlx::Row::try_get::<i64, _>(row, "is_read").unwrap_or_default() != 0,
                is_starred: sqlx::Row::try_get::<i64, _>(row, "is_starred").unwrap_or_default()
                    != 0,
                has_attachments: sqlx::Row::try_get::<i64, _>(row, "has_attachments")
                    .unwrap_or_default()
                    != 0,
                body_status: sqlx::Row::try_get::<String, _>(row, "body_status")
                    .ok()
                    .and_then(|value| BodyStatus::parse(&value))
                    .unwrap_or(BodyStatus::None),
                body_error: optional_string(row, "body_error"),
            },
        );
    }
    Ok(result)
}

async fn summary_for(pool: &SqlitePool, message_id: i64) -> OneMailResult<Option<MessageSummary>> {
    Ok(summaries(pool, &[message_id]).await?.remove(&message_id))
}

fn not_found(message_id: i64) -> OneMailError {
    OneMailError::not_found(format!("Message {message_id} does not exist."))
}

/// Read a nullable text column. Decoding straight into `String` would turn SQL
/// `NULL` into an empty string (and `i64` into zero), which would make every
/// optional header look present.
pub(crate) fn optional_string(row: &sqlx::sqlite::SqliteRow, column: &str) -> Option<String> {
    sqlx::Row::try_get::<Option<String>, _>(row, column)
        .ok()
        .flatten()
}

pub(crate) fn optional_i64(row: &sqlx::sqlite::SqliteRow, column: &str) -> Option<i64> {
    sqlx::Row::try_get::<Option<i64>, _>(row, column)
        .ok()
        .flatten()
}

fn row_error(error: sqlx::Error) -> OneMailError {
    OneMailError::database(format!("Could not read a message row: {error}"))
}

fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_support {
    use sqlx::SqlitePool;

    #[derive(Debug, Clone)]
    pub(crate) struct MessageSeed {
        pub message_id: i64,
        pub account_id: i64,
        pub folder_id: i64,
        pub uid: i64,
        pub subject: Option<String>,
        pub from_name: Option<String>,
        pub from_email: Option<String>,
        pub received_at: Option<String>,
        pub rfc822_message_id: Option<String>,
        pub in_reply_to: Option<String>,
        pub references_header: Option<String>,
        pub snippet: Option<String>,
        pub is_read: bool,
        pub is_starred: bool,
        pub has_attachments: bool,
    }

    impl MessageSeed {
        pub(crate) fn new(message_id: i64, account_id: i64, folder_id: i64, uid: i64) -> Self {
            Self {
                message_id,
                account_id,
                folder_id,
                uid,
                subject: None,
                from_name: None,
                from_email: None,
                received_at: None,
                rfc822_message_id: None,
                in_reply_to: None,
                references_header: None,
                snippet: None,
                is_read: false,
                is_starred: false,
                has_attachments: false,
            }
        }

        pub(crate) fn from(mut self, name: Option<&str>, email: &str) -> Self {
            self.from_name = name.map(str::to_string);
            self.from_email = Some(email.to_string());
            self
        }

        pub(crate) fn subject(mut self, value: &str) -> Self {
            self.subject = Some(value.to_string());
            self
        }

        pub(crate) fn received_at(mut self, value: &str) -> Self {
            self.received_at = Some(value.to_string());
            self
        }

        pub(crate) fn rfc822(mut self, value: &str) -> Self {
            self.rfc822_message_id = Some(value.to_string());
            self
        }

        pub(crate) fn in_reply_to(mut self, value: &str) -> Self {
            self.in_reply_to = Some(value.to_string());
            self
        }

        pub(crate) fn references(mut self, value: &str) -> Self {
            self.references_header = Some(value.to_string());
            self
        }

        pub(crate) fn snippet(mut self, value: &str) -> Self {
            self.snippet = Some(value.to_string());
            self
        }

        pub(crate) fn read(mut self, value: bool) -> Self {
            self.is_read = value;
            self
        }

        pub(crate) fn unread(self) -> Self {
            self.read(false)
        }

        pub(crate) fn starred(mut self) -> Self {
            self.is_starred = true;
            self
        }
    }

    pub(crate) async fn open_pool() -> (tempfile::TempDir, SqlitePool) {
        let directory = tempfile::tempdir().unwrap();
        let pool = crate::store::open_at(&directory.path().join("onemail.db"))
            .await
            .unwrap();
        (directory, pool)
    }

    pub(crate) async fn insert_account(pool: &SqlitePool, account_id: i64, email: &str) {
        let now = "2026-01-01T00:00:00+00:00";
        sqlx::query(
            "INSERT INTO accounts
                 (account_id, provider_key, email, normalized_email, account_label, avatar_text,
                  color_key, auth_type, imap_host, imap_port, imap_security, smtp_host, smtp_port,
                  smtp_security, smtp_auth_type, smtp_enabled, sync_enabled, password, status,
                  created_at, updated_at)
             VALUES (?1, 'custom', ?2, ?3, 'Test', 'T', 'blue', 'password', 'imap.example.test',
                     993, 'ssl_tls', 'smtp.example.test', 587, 'starttls', 'password', 1, 1,
                     'secret', 'active', ?4, ?4)",
        )
        .bind(account_id)
        .bind(email)
        .bind(email.to_lowercase())
        .bind(now)
        .execute(pool)
        .await
        .unwrap();
    }

    pub(crate) async fn insert_folder(
        pool: &SqlitePool,
        folder_id: i64,
        account_id: i64,
        path: &str,
        role: &str,
    ) {
        let now = "2026-01-01T00:00:00+00:00";
        sqlx::query(
            "INSERT INTO folders
                 (folder_id, account_id, path, name, role, sync_enabled, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3, ?4, 1, ?5, ?5)",
        )
        .bind(folder_id)
        .bind(account_id)
        .bind(path)
        .bind(role)
        .bind(now)
        .execute(pool)
        .await
        .unwrap();
    }

    pub(crate) async fn insert_message(pool: &SqlitePool, seed: MessageSeed) {
        let now = "2026-01-01T00:00:00+00:00";
        sqlx::query(
            "INSERT INTO messages
                 (message_id, account_id, folder_id, uid, rfc822_message_id, in_reply_to,
                  references_header, subject, from_name, from_email, sent_at, received_at,
                  snippet, size_bytes, is_read, is_starred, is_answered, is_draft,
                  has_attachments, body_status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, 0, ?13, ?14, 0, 0,
                     ?15, 'none', ?16, ?16)",
        )
        .bind(seed.message_id)
        .bind(seed.account_id)
        .bind(seed.folder_id)
        .bind(seed.uid)
        .bind(seed.rfc822_message_id.as_deref())
        .bind(seed.in_reply_to.as_deref())
        .bind(seed.references_header.as_deref())
        .bind(seed.subject.as_deref())
        .bind(seed.from_name.as_deref())
        .bind(seed.from_email.as_deref())
        .bind(seed.received_at.as_deref())
        .bind(seed.snippet.as_deref())
        .bind(i64::from(seed.is_read))
        .bind(i64::from(seed.is_starred))
        .bind(i64::from(seed.has_attachments))
        .bind(now)
        .execute(pool)
        .await
        .unwrap();
        // The sync writes the From header as an address row too; conversation
        // grouping reads participants from that table, never from the summary
        // columns.
        if let Some(email) = seed.from_email.as_deref() {
            insert_address_at(
                pool,
                seed.message_id,
                "from",
                seed.from_name.as_deref(),
                email,
                0,
            )
            .await;
        }
    }

    pub(crate) async fn insert_address(
        pool: &SqlitePool,
        message_id: i64,
        kind: &str,
        name: Option<&str>,
        email: &str,
    ) {
        insert_address_at(pool, message_id, kind, name, email, 0).await;
    }

    pub(crate) async fn insert_address_at(
        pool: &SqlitePool,
        message_id: i64,
        kind: &str,
        name: Option<&str>,
        email: &str,
        order: i64,
    ) {
        sqlx::query(
            "INSERT INTO message_addresses
                 (message_id, kind, name, email, normalized_email, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '2026-01-01T00:00:00+00:00')",
        )
        .bind(message_id)
        .bind(kind)
        .bind(name)
        .bind(email)
        .bind(email.trim().to_lowercase())
        .bind(order)
        .execute(pool)
        .await
        .unwrap();
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn insert_search(
        pool: &SqlitePool,
        message_id: i64,
        account_id: i64,
        folder_id: i64,
        subject: Option<&str>,
        from_name: Option<&str>,
        from_email: Option<&str>,
        snippet: Option<&str>,
        body_text: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO message_search
                 (message_id, account_id, folder_id, subject, from_name, from_email, snippet,
                  body_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(message_id)
        .bind(account_id)
        .bind(folder_id)
        .bind(subject)
        .bind(from_name)
        .bind(from_email)
        .bind(snippet)
        .bind(body_text)
        .execute(pool)
        .await
        .unwrap();
    }

    pub(crate) async fn insert_body(
        pool: &SqlitePool,
        message_id: i64,
        body_text: Option<&str>,
        body_html: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO message_bodies (message_id, body_text, body_html, loaded_at)
             VALUES (?1, ?2, ?3, '2026-01-01T00:00:00+00:00')",
        )
        .bind(message_id)
        .bind(body_text)
        .bind(body_html)
        .execute(pool)
        .await
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{
        insert_account, insert_address, insert_body, insert_folder, insert_message, open_pool,
        MessageSeed,
    };
    use super::*;
    use crate::mime::{ParsedAddressGroup, ParsedAttachment, ParsedMessage};

    async fn seed() -> (tempfile::TempDir, SqlitePool) {
        let (directory, pool) = open_pool().await;
        insert_account(&pool, 1, "me@example.test").await;
        insert_folder(&pool, 1, 1, "INBOX", "inbox").await;
        insert_message(
            &pool,
            MessageSeed::new(1, 1, 1, 10)
                .from(Some("Alice"), "alice@example.test")
                .subject("Quarterly report"),
        )
        .await;
        (directory, pool)
    }

    fn parsed() -> ParsedMessage {
        ParsedMessage {
            raw_headers: "Subject: Quarterly report\r\nFrom: Alice <alice@example.test>\r\n".into(),
            subject: Some("Quarterly report".into()),
            message_id: Some("<one@example.test>".into()),
            in_reply_to: None,
            references_header: None,
            from_name: Some("Alice".into()),
            from_email: Some("alice@example.test".into()),
            sent_at: Some("2026-01-01T10:00:00Z".into()),
            body_text: Some("Please review the numbers before Friday.".into()),
            body_html: Some("<p>Please review the numbers.</p>".into()),
            attachments: vec![ParsedAttachment {
                part_id: Some("2".into()),
                content_id: None,
                filename: "report.pdf".into(),
                mime_type: Some("application/pdf".into()),
                disposition: Some("attachment".into()),
                size_bytes: 42,
            }],
            addresses: vec![
                ParsedAddressGroup {
                    kind: "from".into(),
                    addresses: vec![(Some("Alice".into()), "alice@example.test".into())],
                },
                ParsedAddressGroup {
                    kind: "to".into(),
                    addresses: vec![(None, "me@example.test".into())],
                },
            ],
            snippet: Some("Please review the numbers before Friday.".into()),
        }
    }

    #[tokio::test]
    async fn persisting_a_body_writes_every_table_and_marks_the_message_read() {
        let (_directory, pool) = seed().await;
        let location = conversation::find_message(&pool, 1).await.unwrap().unwrap();

        let body = persist_body(&pool, &location, parsed()).await.unwrap();
        assert_eq!(body.message_id, 1);
        assert_eq!(
            body.body_text.as_deref(),
            Some("Please review the numbers before Friday.")
        );

        let (is_read, status, snippet, has_attachments): (i64, String, String, i64) =
            sqlx::query_as(
                "SELECT is_read, body_status, snippet, has_attachments FROM messages
                 WHERE message_id = 1",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(is_read, 1);
        assert_eq!(status, "ready");
        assert_eq!(snippet, "Please review the numbers before Friday.");
        assert_eq!(has_attachments, 1);

        let attachment: (String, String, i64) = sqlx::query_as(
            "SELECT filename, mime_type, size_bytes FROM message_attachments WHERE message_id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(attachment.0, "report.pdf");
        assert_eq!(attachment.1, "application/pdf");
        assert_eq!(attachment.2, 42);

        let address_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM message_addresses WHERE message_id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(address_count, 2);

        let hits: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM message_search
             WHERE message_search MATCH 'numbers before' AND message_id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(hits, 1);
    }

    #[tokio::test]
    async fn persisting_a_body_replaces_old_participants_and_attachments() {
        let (_directory, pool) = seed().await;
        let location = conversation::find_message(&pool, 1).await.unwrap().unwrap();
        insert_address(&pool, 1, "to", None, "stale@example.test").await;

        let mut message = parsed();
        message.attachments.clear();
        persist_body(&pool, &location, message).await.unwrap();

        let stale: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM message_addresses WHERE message_id = 1 AND email = 'stale@example.test'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stale, 0);
        let attachments: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM message_attachments WHERE message_id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(attachments, 0);
        let has_attachments: i64 =
            sqlx::query_scalar("SELECT has_attachments FROM messages WHERE message_id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(has_attachments, 0);
    }

    #[tokio::test]
    async fn get_returns_the_body_attachments_and_recipients() {
        let (_directory, pool) = seed().await;
        insert_body(&pool, 1, Some("Hello"), Some("<p>Hello</p>")).await;
        insert_address(&pool, 1, "to", Some("Me"), "me@example.test").await;
        insert_address(&pool, 1, "cc", Some("Bob"), "bob@example.test").await;
        sqlx::query(
            "UPDATE messages SET has_attachments = 1, body_status = 'ready' WHERE message_id = 1",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO message_attachments
                 (message_id, filename, mime_type, content_disposition, size_bytes, created_at)
             VALUES (1, 'a.txt', 'text/plain', 'attachment', 3, '2026-01-01T00:00:00+00:00')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let detail = get(&pool, 1).await.unwrap();
        assert_eq!(detail.summary.to.len(), 1);
        assert_eq!(detail.summary.to[0].email, "me@example.test");
        assert_eq!(detail.summary.cc[0].email, "bob@example.test");
        assert_eq!(detail.body.unwrap().body_text.as_deref(), Some("Hello"));
        assert_eq!(detail.attachments.len(), 1);
        assert_eq!(detail.attachments[0].filename, "a.txt");
        assert!(get(&pool, 99).await.is_err());
    }

    #[tokio::test]
    async fn read_and_star_flags_return_the_updated_summary() {
        let (_directory, pool) = seed().await;

        let read = set_read(&pool, 1, true).await.unwrap();
        assert!(read.is_read);
        let starred = set_starred(&pool, 1, true).await.unwrap();
        assert!(starred.is_starred);
        assert!(starred.is_read);
        let unread = set_read(&pool, 1, false).await.unwrap();
        assert!(!unread.is_read);
        assert_eq!(unread.message_id, 1);
        assert_eq!(unread.folder_path, "INBOX");

        assert!(set_read(&pool, 99, true).await.is_err());
    }

    #[tokio::test]
    async fn raw_reads_the_stored_copy_without_fetching() {
        let (_directory, pool) = seed().await;
        sqlx::query(
            "UPDATE messages SET raw_headers = 'Subject: Stored\r\n', size_bytes = 120
             WHERE message_id = 1",
        )
        .execute(&pool)
        .await
        .unwrap();
        insert_body(&pool, 1, Some("body"), None).await;

        let view = raw(&pool, 1).await.unwrap();
        assert_eq!(view.headers, "Subject: Stored\r\n");
        assert_eq!(view.body_text.as_deref(), Some("body"));
        assert!(view.body_html.is_none());
        assert_eq!(view.size_bytes, 120);

        sqlx::query("UPDATE messages SET raw_headers = NULL WHERE message_id = 1")
            .execute(&pool)
            .await
            .unwrap();
        let empty = raw(&pool, 1).await.unwrap();
        assert!(empty.headers.is_empty());
        assert!(raw(&pool, 99).await.is_err());
    }

    #[tokio::test]
    async fn a_missing_message_has_no_summary() {
        let (_directory, pool) = seed().await;
        assert!(summary_for(&pool, 99).await.unwrap().is_none());
        assert!(summary_for(&pool, 1).await.unwrap().is_some());
    }
}
