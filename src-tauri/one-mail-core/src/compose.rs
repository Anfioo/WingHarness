// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Drafts, reply/forward prefill, sending and the outbox.
//!
//! The send path is split in two: [`send_via`] owns the outbox state machine
//! and talks to a [`MailSender`], which in production is `smtp::send` and in
//! tests is a fake. That keeps every state transition testable without opening
//! a socket. Events belong to `commands.rs`; this module only emits
//! `one-mail:mailbox-changed` after a successful send so the conversation list
//! reloads.

use std::collections::HashSet;
use std::fs;

use sqlx::sqlite::SqliteConnection;
use sqlx::SqlitePool;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::{OneMailError, OneMailResult};
use crate::message::{optional_i64, optional_string};
use crate::models::{
    ComposeKind, Draft, DraftAttachmentInput, DraftInput, MailAddress, MailboxChangedPayload,
    OutboxItem, OutboxStatus, PickedAttachment, SendInput, SendResult,
};
use crate::state::{OneMailState, EVENT_MAILBOX_CHANGED};

/// The one operation `send` needs from the transport. Production wires it to
/// `smtp::send`; the tests wire it to a fake that never touches the network.
#[async_trait::async_trait]
trait MailSender {
    async fn deliver(&self, account_id: i64, input: &SendInput) -> OneMailResult<SendResult>;
}

struct SmtpSender<'a> {
    state: &'a OneMailState,
}

#[async_trait::async_trait]
impl MailSender for SmtpSender<'_> {
    async fn deliver(&self, account_id: i64, input: &SendInput) -> OneMailResult<SendResult> {
        crate::smtp::send(self.state, account_id, input).await
    }
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

pub async fn save_draft(pool: &SqlitePool, input: DraftInput) -> OneMailResult<Draft> {
    let from_email = account_email(pool, input.account_id).await?;
    let to_json = addresses_to_json(&input.to)?;
    let cc_json = addresses_to_json(&input.cc)?;
    let bcc_json = addresses_to_json(&input.bcc)?;
    let now = now_iso8601();

    let mut transaction = pool.begin().await.map_err(|error| {
        OneMailError::database(format!("Could not start saving the draft: {error}"))
    })?;

    let outbox_id = match input.outbox_id {
        Some(outbox_id) => {
            let status: Option<String> =
                sqlx::query_scalar("SELECT status FROM outbox_messages WHERE outbox_id = ?1")
                    .bind(outbox_id)
                    .fetch_optional(&mut *transaction)
                    .await
                    .map_err(|error| {
                        OneMailError::database(format!("Could not read the draft: {error}"))
                    })?;
            let Some(status) = status else {
                return Err(OneMailError::not_found(format!(
                    "Draft {outbox_id} does not exist."
                )));
            };
            if OutboxStatus::parse(&status) != Some(OutboxStatus::Draft) {
                return Err(OneMailError::invalid_input(
                    "outboxId",
                    "Only a draft can be overwritten.",
                ));
            }
            sqlx::query(
                "UPDATE outbox_messages SET
                     account_id = ?2, related_message_id = ?3, compose_kind = ?4,
                     from_email = ?5, to_json = ?6, cc_json = ?7, bcc_json = ?8,
                     subject = ?9, body_text = ?10, body_html = ?11, updated_at = ?12
                 WHERE outbox_id = ?1",
            )
            .bind(outbox_id)
            .bind(input.account_id)
            .bind(input.related_message_id)
            .bind(input.compose_kind.as_str())
            .bind(&from_email)
            .bind(&to_json)
            .bind(&cc_json)
            .bind(&bcc_json)
            .bind(&input.subject)
            .bind(&input.body_text)
            .bind(&input.body_html)
            .bind(&now)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not save the draft: {error}"))
            })?;
            outbox_id
        }
        None => sqlx::query_scalar::<_, i64>(
            "INSERT INTO outbox_messages
                 (account_id, related_message_id, compose_kind, status, rfc822_message_id,
                  from_email, to_json, cc_json, bcc_json, subject, body_text, body_html,
                  created_at, updated_at)
             VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
             RETURNING outbox_id",
        )
        .bind(input.account_id)
        .bind(input.related_message_id)
        .bind(input.compose_kind.as_str())
        .bind(new_message_id())
        .bind(&from_email)
        .bind(&to_json)
        .bind(&cc_json)
        .bind(&bcc_json)
        .bind(&input.subject)
        .bind(&input.body_text)
        .bind(&input.body_html)
        .bind(&now)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| OneMailError::database(format!("Could not create the draft: {error}")))?,
    };

    replace_attachments(&mut transaction, outbox_id, &input.attachments).await?;
    let draft = load_draft(&mut transaction, outbox_id)
        .await?
        .ok_or_else(|| OneMailError::internal("The saved draft could not be read back."))?;
    transaction
        .commit()
        .await
        .map_err(|error| OneMailError::database(format!("Could not commit the draft: {error}")))?;
    Ok(draft)
}

pub async fn delete_draft(pool: &SqlitePool, outbox_id: i64) -> OneMailResult<bool> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM outbox_messages WHERE outbox_id = ?1")
            .bind(outbox_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not read the draft: {error}"))
            })?;
    let Some(status) = status else {
        return Ok(false);
    };
    if OutboxStatus::parse(&status) != Some(OutboxStatus::Draft) {
        return Err(OneMailError::invalid_input(
            "outboxId",
            "Only a draft can be deleted through the draft action.",
        ));
    }
    let removed = sqlx::query("DELETE FROM outbox_messages WHERE outbox_id = ?1")
        .bind(outbox_id)
        .execute(pool)
        .await
        .map_err(|error| OneMailError::database(format!("Could not delete the draft: {error}")))?;
    Ok(removed.rows_affected() > 0)
}

pub async fn reply_draft(
    pool: &SqlitePool,
    message_id: i64,
    reply_all: bool,
) -> OneMailResult<Draft> {
    let source = load_source(pool, message_id).await?;
    let own_email = account_normalized_email(pool, source.account_id).await?;
    let outgoing = source
        .from_email
        .as_deref()
        .map(|email| email.trim().to_lowercase())
        .is_some_and(|email| email == own_email);

    let mut seen = HashSet::new();
    seen.insert(own_email);
    let mut to = Vec::new();
    let mut cc = Vec::new();
    let target_kind = if outgoing {
        "to"
    } else if source
        .addresses
        .iter()
        .any(|address| address.kind == "reply_to")
    {
        "reply_to"
    } else {
        "from"
    };
    collect_addresses(&source.addresses, target_kind, &mut to, &mut seen);
    if reply_all {
        collect_addresses(&source.addresses, "to", &mut to, &mut seen);
        collect_addresses(&source.addresses, "cc", &mut cc, &mut seen);
    }
    if to.is_empty() && !outgoing {
        if let Some(email) = source
            .from_email
            .as_deref()
            .map(str::trim)
            .filter(|email| !email.is_empty())
        {
            if seen.insert(email.to_lowercase()) {
                to.push(MailAddress {
                    name: source.from_name.clone(),
                    email: email.to_string(),
                });
            }
        }
    }

    let in_reply_to = source
        .rfc822_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let references = in_reply_to
        .as_deref()
        .map(|message_id| build_references(source.references_header.as_deref(), message_id))
        .filter(|value| !value.is_empty());
    let quoted = quote_body(&source.plain_body());

    let compose_kind = if reply_all {
        ComposeKind::ReplyAll
    } else {
        ComposeKind::Reply
    };
    let outbox_id = insert_related_draft(
        pool,
        source.account_id,
        compose_kind,
        message_id,
        &to,
        &cc,
        &format_subject(
            SubjectKind::Reply,
            source.subject.as_deref().unwrap_or_default(),
        ),
        &quoted,
        in_reply_to.as_deref(),
        references.as_deref(),
    )
    .await?;
    read_draft(pool, outbox_id).await
}

pub async fn forward_draft(pool: &SqlitePool, message_id: i64) -> OneMailResult<Draft> {
    let source = load_source(pool, message_id).await?;
    let from_display = match (
        source
            .from_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty()),
        source
            .from_email
            .as_deref()
            .map(str::trim)
            .filter(|email| !email.is_empty()),
    ) {
        (Some(name), Some(email)) => format!("{name} <{email}>"),
        (None, Some(email)) => email.to_string(),
        _ => String::new(),
    };
    let body = format!(
        "---------- Forwarded message ----------\nFrom: {}\nDate: {}\nSubject: {}\n\n{}",
        from_display,
        source.received_at.as_deref().unwrap_or_default(),
        source.subject.as_deref().unwrap_or_default(),
        source.plain_body()
    );

    let outbox_id = insert_related_draft(
        pool,
        source.account_id,
        ComposeKind::Forward,
        message_id,
        &[],
        &[],
        &format_subject(
            SubjectKind::Forward,
            source.subject.as_deref().unwrap_or_default(),
        ),
        &body,
        None,
        None,
    )
    .await?;
    read_draft(pool, outbox_id).await
}

#[allow(clippy::too_many_arguments)]
async fn insert_related_draft(
    pool: &SqlitePool,
    account_id: i64,
    compose_kind: ComposeKind,
    related_message_id: i64,
    to: &[MailAddress],
    cc: &[MailAddress],
    subject: &str,
    body_text: &str,
    in_reply_to: Option<&str>,
    references_header: Option<&str>,
) -> OneMailResult<i64> {
    let from_email = account_email(pool, account_id).await?;
    let now = now_iso8601();
    let outbox_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO outbox_messages
             (account_id, related_message_id, compose_kind, status, rfc822_message_id,
              in_reply_to, references_header, from_email, to_json, cc_json, bcc_json, subject,
              body_text, body_html, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, ?9, '[]', ?10, ?11, '', ?12, ?12)
         RETURNING outbox_id",
    )
    .bind(account_id)
    .bind(related_message_id)
    .bind(compose_kind.as_str())
    .bind(new_message_id())
    .bind(in_reply_to)
    .bind(references_header)
    .bind(from_email)
    .bind(addresses_to_json(to)?)
    .bind(addresses_to_json(cc)?)
    .bind(subject)
    .bind(body_text)
    .bind(&now)
    .fetch_one(pool)
    .await
    .map_err(|error| OneMailError::database(format!("Could not create the draft: {error}")))?;
    Ok(outbox_id)
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

pub async fn send(state: &OneMailState, input: SendInput) -> OneMailResult<SendResult> {
    let account_id = input.account_id;
    let pool = state.pool().await?;
    let result = send_via(&pool, &SmtpSender { state }, input).await?;
    state.emit(
        EVENT_MAILBOX_CHANGED,
        MailboxChangedPayload {
            account_id,
            folder_id: None,
        },
    );
    Ok(result)
}

pub async fn retry(state: &OneMailState, outbox_id: i64) -> OneMailResult<SendResult> {
    let pool = state.pool().await?;
    let account_id: Option<i64> =
        sqlx::query_scalar("SELECT account_id FROM outbox_messages WHERE outbox_id = ?1")
            .bind(outbox_id)
            .fetch_optional(&pool)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not read the outbox record: {error}"))
            })?;
    let Some(account_id) = account_id else {
        return Err(OneMailError::not_found(format!(
            "Outbox record {outbox_id} does not exist."
        )));
    };
    let result = retry_via(&pool, &SmtpSender { state }, outbox_id).await?;
    state.emit(
        EVENT_MAILBOX_CHANGED,
        MailboxChangedPayload {
            account_id,
            folder_id: None,
        },
    );
    Ok(result)
}

/// Validate, persist the outbox row as `sending`, hand it to the transport and
/// settle on `sent` or `failed`. The row exists before the socket opens, which
/// is what gives the result a real `outbox_id` and the UI something to show
/// while the send is in flight.
async fn send_via(
    pool: &SqlitePool,
    sender: &dyn MailSender,
    input: SendInput,
) -> OneMailResult<SendResult> {
    validate_recipients(&input)?;
    let (from_email, smtp_enabled) = account_for_send(pool, input.account_id).await?;
    if !smtp_enabled {
        return Err(OneMailError::not_configured(
            "Sending is disabled for this account.",
        ));
    }

    let (outbox_id, message_id) = prepare_outbox(pool, &input, &from_email).await?;
    let mut outgoing = input;
    outgoing.outbox_id = Some(outbox_id);
    let outcome = sender.deliver(outgoing.account_id, &outgoing).await;

    match outcome {
        Ok(mut result) => {
            let sent_at = result.sent_at.clone().unwrap_or_else(now_iso8601);
            sqlx::query(
                "UPDATE outbox_messages
                 SET status = 'sent', sent_at = ?2, last_error = NULL, updated_at = ?3
                 WHERE outbox_id = ?1",
            )
            .bind(outbox_id)
            .bind(&sent_at)
            .bind(now_iso8601())
            .execute(pool)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not mark the message sent: {error}"))
            })?;
            result.outbox_id = outbox_id;
            result.status = OutboxStatus::Sent;
            result.rfc822_message_id = message_id;
            result.sent_at = Some(sent_at);
            Ok(result)
        }
        Err(error) => {
            let last_error = describe_error(&error);
            sqlx::query(
                "UPDATE outbox_messages
                 SET status = 'failed', last_error = ?2, updated_at = ?3
                 WHERE outbox_id = ?1",
            )
            .bind(outbox_id)
            .bind(&last_error)
            .bind(now_iso8601())
            .execute(pool)
            .await
            .map_err(|update_error| {
                OneMailError::database(format!("Could not record the failed send: {update_error}"))
            })?;
            Err(error)
        }
    }
}

async fn retry_via(
    pool: &SqlitePool,
    sender: &dyn MailSender,
    outbox_id: i64,
) -> OneMailResult<SendResult> {
    let record = load_outbox_record(pool, outbox_id).await?.ok_or_else(|| {
        OneMailError::not_found(format!("Outbox record {outbox_id} does not exist."))
    })?;
    if record.status != OutboxStatus::Failed {
        return Err(OneMailError::invalid_input(
            "outboxId",
            "Only a failed message can be retried.",
        ));
    }
    let input = SendInput {
        outbox_id: Some(outbox_id),
        account_id: record.account_id,
        compose_kind: record.compose_kind,
        related_message_id: record.related_message_id,
        to: record.to,
        cc: record.cc,
        bcc: record.bcc,
        subject: record.subject,
        body_text: record.body_text,
        body_html: record.body_html,
        attachments: record.attachments,
        in_reply_to: record.in_reply_to,
        references_header: record.references_header,
    };
    send_via(pool, sender, input).await
}

/// Insert or reuse the outbox row and put it in `sending`.
async fn prepare_outbox(
    pool: &SqlitePool,
    input: &SendInput,
    from_email: &str,
) -> OneMailResult<(i64, String)> {
    let to_json = addresses_to_json(&input.to)?;
    let cc_json = addresses_to_json(&input.cc)?;
    let bcc_json = addresses_to_json(&input.bcc)?;
    let now = now_iso8601();

    match input.outbox_id {
        Some(outbox_id) => {
            let row = sqlx::query(
                "SELECT status, rfc822_message_id FROM outbox_messages WHERE outbox_id = ?1",
            )
            .bind(outbox_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not read the outbox record: {error}"))
            })?;
            let Some(row) = row else {
                return Err(OneMailError::not_found(format!(
                    "Outbox record {outbox_id} does not exist."
                )));
            };
            let status: String = sqlx::Row::try_get(&row, "status").map_err(|error| {
                OneMailError::database(format!("Could not read the outbox status: {error}"))
            })?;
            match OutboxStatus::parse(&status) {
                Some(OutboxStatus::Sending) => {
                    return Err(OneMailError::busy("This message is already being sent."))
                }
                Some(OutboxStatus::Sent) => {
                    return Err(OneMailError::invalid_input(
                        "outboxId",
                        "This message has already been sent.",
                    ))
                }
                _ => {}
            }
            let stored_id: Option<String> = optional_string(&row, "rfc822_message_id");
            let message_id = stored_id
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(new_message_id);

            let mut transaction = pool.begin().await.map_err(|error| {
                OneMailError::database(format!("Could not start the send: {error}"))
            })?;
            sqlx::query(
                "UPDATE outbox_messages SET
                     account_id = ?2, related_message_id = ?3, compose_kind = ?4,
                     status = 'sending', rfc822_message_id = ?5, in_reply_to = ?6,
                     references_header = ?7, from_email = ?8, to_json = ?9, cc_json = ?10,
                     bcc_json = ?11, subject = ?12, body_text = ?13, body_html = ?14,
                     last_error = NULL, updated_at = ?15
                 WHERE outbox_id = ?1",
            )
            .bind(outbox_id)
            .bind(input.account_id)
            .bind(input.related_message_id)
            .bind(input.compose_kind.as_str())
            .bind(&message_id)
            .bind(&input.in_reply_to)
            .bind(&input.references_header)
            .bind(from_email)
            .bind(&to_json)
            .bind(&cc_json)
            .bind(&bcc_json)
            .bind(&input.subject)
            .bind(&input.body_text)
            .bind(&input.body_html)
            .bind(&now)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not mark the message sending: {error}"))
            })?;
            replace_attachments(&mut transaction, outbox_id, &input.attachments).await?;
            transaction.commit().await.map_err(|error| {
                OneMailError::database(format!("Could not start the send: {error}"))
            })?;
            Ok((outbox_id, message_id))
        }
        None => {
            let message_id = new_message_id();
            let mut transaction = pool.begin().await.map_err(|error| {
                OneMailError::database(format!("Could not start the send: {error}"))
            })?;
            let outbox_id = sqlx::query_scalar::<_, i64>(
                "INSERT INTO outbox_messages
                     (account_id, related_message_id, compose_kind, status, rfc822_message_id,
                      in_reply_to, references_header, from_email, to_json, cc_json, bcc_json,
                      subject, body_text, body_html, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'sending', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                         ?14)
                 RETURNING outbox_id",
            )
            .bind(input.account_id)
            .bind(input.related_message_id)
            .bind(input.compose_kind.as_str())
            .bind(&message_id)
            .bind(&input.in_reply_to)
            .bind(&input.references_header)
            .bind(from_email)
            .bind(&to_json)
            .bind(&cc_json)
            .bind(&bcc_json)
            .bind(&input.subject)
            .bind(&input.body_text)
            .bind(&input.body_html)
            .bind(&now)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not create the outbox record: {error}"))
            })?;
            replace_attachments(&mut transaction, outbox_id, &input.attachments).await?;
            transaction.commit().await.map_err(|error| {
                OneMailError::database(format!("Could not start the send: {error}"))
            })?;
            Ok((outbox_id, message_id))
        }
    }
}

// ---------------------------------------------------------------------------
// Outbox views
// ---------------------------------------------------------------------------

pub async fn list_outbox(
    pool: &SqlitePool,
    account_id: Option<i64>,
) -> OneMailResult<Vec<OutboxItem>> {
    let rows = sqlx::query(
        "SELECT o.outbox_id, o.account_id, o.compose_kind, o.status, o.subject, o.to_json,
                o.cc_json, o.bcc_json, o.body_text, o.created_at, o.sent_at, o.last_error,
                (SELECT COUNT(*) FROM outbox_attachments a
                 WHERE a.outbox_id = o.outbox_id) AS attachment_count
         FROM outbox_messages o
         WHERE (?1 IS NULL OR o.account_id = ?1)
           AND (
               o.status IN ('draft', 'queued', 'sending', 'failed')
               OR (o.status = 'sent' AND o.outbox_id IN (
                   SELECT s.outbox_id FROM outbox_messages s
                   WHERE s.status = 'sent' AND (?1 IS NULL OR s.account_id = ?1)
                   ORDER BY COALESCE(s.sent_at, s.updated_at) DESC
                   LIMIT 100
               ))
           )
         ORDER BY o.updated_at DESC, o.outbox_id DESC",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|error| OneMailError::database(format!("Could not list the outbox: {error}")))?;

    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let status_text: String = sqlx::Row::try_get(row, "status").map_err(row_error)?;
        let kind_text: String = sqlx::Row::try_get(row, "compose_kind").map_err(row_error)?;
        let body_text: Option<String> = optional_string(row, "body_text");
        items.push(OutboxItem {
            outbox_id: sqlx::Row::try_get(row, "outbox_id").map_err(row_error)?,
            account_id: sqlx::Row::try_get(row, "account_id").map_err(row_error)?,
            compose_kind: ComposeKind::parse(&kind_text).unwrap_or(ComposeKind::New),
            status: OutboxStatus::parse(&status_text).unwrap_or(OutboxStatus::Draft),
            subject: optional_string(row, "subject"),
            to: addresses_from_json(
                &sqlx::Row::try_get::<String, _>(row, "to_json").unwrap_or_default(),
            ),
            cc: addresses_from_json(
                &sqlx::Row::try_get::<String, _>(row, "cc_json").unwrap_or_default(),
            ),
            bcc: addresses_from_json(
                &sqlx::Row::try_get::<String, _>(row, "bcc_json").unwrap_or_default(),
            ),
            snippet: body_text
                .as_deref()
                .map(snippet)
                .filter(|value| !value.is_empty()),
            created_at: sqlx::Row::try_get(row, "created_at").map_err(row_error)?,
            sent_at: optional_string(row, "sent_at"),
            last_error: optional_string(row, "last_error"),
            attachment_count: u32::try_from(
                sqlx::Row::try_get::<i64, _>(row, "attachment_count").unwrap_or_default(),
            )
            .unwrap_or(u32::MAX),
        });
    }
    Ok(items)
}

pub async fn get_outbox(pool: &SqlitePool, outbox_id: i64) -> OneMailResult<Draft> {
    read_draft(pool, outbox_id).await
}

pub async fn delete_outbox(pool: &SqlitePool, outbox_id: i64) -> OneMailResult<bool> {
    let status: Option<String> =
        sqlx::query_scalar("SELECT status FROM outbox_messages WHERE outbox_id = ?1")
            .bind(outbox_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not read the outbox record: {error}"))
            })?;
    let Some(status) = status else {
        return Ok(false);
    };
    if OutboxStatus::parse(&status) == Some(OutboxStatus::Sending) {
        return Err(OneMailError::busy("This message is being sent."));
    }
    let removed = sqlx::query("DELETE FROM outbox_messages WHERE outbox_id = ?1")
        .bind(outbox_id)
        .execute(pool)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not delete the outbox record: {error}"))
        })?;
    Ok(removed.rows_affected() > 0)
}

pub async fn pick_attachments(app: &AppHandle) -> OneMailResult<Vec<PickedAttachment>> {
    let Some(files) = app.dialog().file().blocking_pick_files() else {
        return Ok(Vec::new());
    };
    let mut picked = Vec::new();
    for file in files {
        let path = file.into_path().map_err(|_| {
            OneMailError::invalid_input("attachments", "A selected file has no local path.")
        })?;
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("attachment")
            .to_string();
        let metadata = fs::metadata(&path).map_err(|_| {
            OneMailError::invalid_input(
                "attachments",
                format!("The attachment {filename} could not be read."),
            )
        })?;
        if !metadata.is_file() {
            return Err(OneMailError::invalid_input(
                "attachments",
                format!("The attachment {filename} is not a regular file."),
            ));
        }
        picked.push(PickedAttachment {
            file_path: path.to_string_lossy().into_owned(),
            mime_type: guess_mime_type(&filename).map(str::to_string),
            filename,
            size_bytes: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
        });
    }
    Ok(picked)
}

/// A small extension table for the attachments the composer can add. It is not
/// sniffing: the only consumer is the outgoing MIME part's `Content-Type`, and
/// `smtp` already falls back to `application/octet-stream` for anything else.
fn guess_mime_type(filename: &str) -> Option<&'static str> {
    let extension = filename.rsplit_once('.')?.1.trim().to_ascii_lowercase();
    let mime = match extension.as_str() {
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => return None,
    };
    Some(mime)
}

// ---------------------------------------------------------------------------
// Draft persistence helpers
// ---------------------------------------------------------------------------

async fn read_draft(pool: &SqlitePool, outbox_id: i64) -> OneMailResult<Draft> {
    let mut connection = pool.acquire().await.map_err(|error| {
        OneMailError::database(format!("Could not open the outbox record: {error}"))
    })?;
    load_draft(&mut connection, outbox_id)
        .await?
        .ok_or_else(|| {
            OneMailError::not_found(format!("Outbox record {outbox_id} does not exist."))
        })
}

async fn load_draft(
    connection: &mut SqliteConnection,
    outbox_id: i64,
) -> OneMailResult<Option<Draft>> {
    let row = sqlx::query(
        "SELECT outbox_id, account_id, compose_kind, related_message_id, to_json, cc_json,
                bcc_json, subject, body_text, body_html, in_reply_to, references_header,
                updated_at
         FROM outbox_messages WHERE outbox_id = ?1",
    )
    .bind(outbox_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| {
        OneMailError::database(format!("Could not read the outbox record: {error}"))
    })?;
    let Some(row) = row else {
        return Ok(None);
    };

    let attachments = sqlx::query(
        "SELECT file_path, filename, mime_type, size_bytes FROM outbox_attachments
         WHERE outbox_id = ?1 ORDER BY attachment_id",
    )
    .bind(outbox_id)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| {
        OneMailError::database(format!("Could not read the outbox attachments: {error}"))
    })?;

    let kind_text: String = sqlx::Row::try_get(&row, "compose_kind").map_err(row_error)?;
    Ok(Some(Draft {
        outbox_id: sqlx::Row::try_get(&row, "outbox_id").map_err(row_error)?,
        account_id: sqlx::Row::try_get(&row, "account_id").map_err(row_error)?,
        compose_kind: ComposeKind::parse(&kind_text).unwrap_or(ComposeKind::New),
        related_message_id: optional_i64(&row, "related_message_id"),
        to: addresses_from_json(
            &sqlx::Row::try_get::<String, _>(&row, "to_json").unwrap_or_default(),
        ),
        cc: addresses_from_json(
            &sqlx::Row::try_get::<String, _>(&row, "cc_json").unwrap_or_default(),
        ),
        bcc: addresses_from_json(
            &sqlx::Row::try_get::<String, _>(&row, "bcc_json").unwrap_or_default(),
        ),
        subject: sqlx::Row::try_get::<Option<String>, _>(&row, "subject")
            .ok()
            .flatten()
            .unwrap_or_default(),
        body_text: sqlx::Row::try_get::<Option<String>, _>(&row, "body_text")
            .ok()
            .flatten()
            .unwrap_or_default(),
        body_html: sqlx::Row::try_get::<Option<String>, _>(&row, "body_html")
            .ok()
            .flatten()
            .unwrap_or_default(),
        attachments: attachments
            .iter()
            .map(|attachment| DraftAttachmentInput {
                file_path: optional_string(attachment, "file_path"),
                filename: sqlx::Row::try_get(attachment, "filename").unwrap_or_default(),
                mime_type: optional_string(attachment, "mime_type"),
                size_bytes: sqlx::Row::try_get(attachment, "size_bytes").unwrap_or_default(),
            })
            .collect(),
        in_reply_to: optional_string(&row, "in_reply_to"),
        references_header: optional_string(&row, "references_header"),
        updated_at: sqlx::Row::try_get(&row, "updated_at").map_err(row_error)?,
    }))
}

async fn replace_attachments(
    connection: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    outbox_id: i64,
    attachments: &[DraftAttachmentInput],
) -> OneMailResult<()> {
    sqlx::query("DELETE FROM outbox_attachments WHERE outbox_id = ?1")
        .bind(outbox_id)
        .execute(&mut **connection)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not refresh the draft attachments: {error}"))
        })?;
    for attachment in attachments {
        let source_kind = if attachment.file_path.is_some() {
            "local_file"
        } else {
            "forwarded_attachment"
        };
        sqlx::query(
            "INSERT INTO outbox_attachments
                 (outbox_id, source_kind, file_path, filename, mime_type, size_bytes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(outbox_id)
        .bind(source_kind)
        .bind(&attachment.file_path)
        .bind(&attachment.filename)
        .bind(&attachment.mime_type)
        .bind(attachment.size_bytes)
        .bind(now_iso8601())
        .execute(&mut **connection)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not save a draft attachment: {error}"))
        })?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Source messages, addresses and text
// ---------------------------------------------------------------------------

struct SourceAddress {
    kind: String,
    name: Option<String>,
    email: String,
}

struct SourceMessage {
    account_id: i64,
    subject: Option<String>,
    from_name: Option<String>,
    from_email: Option<String>,
    rfc822_message_id: Option<String>,
    references_header: Option<String>,
    snippet: Option<String>,
    received_at: Option<String>,
    body_text: Option<String>,
    body_html: Option<String>,
    addresses: Vec<SourceAddress>,
}

impl SourceMessage {
    fn plain_body(&self) -> String {
        self.body_text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                self.body_html
                    .as_deref()
                    .map(crate::mime::html_to_text)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
            .or_else(|| self.snippet.clone())
            .unwrap_or_default()
    }
}

async fn load_source(pool: &SqlitePool, message_id: i64) -> OneMailResult<SourceMessage> {
    let row = sqlx::query(
        "SELECT m.account_id, m.subject, m.from_name, m.from_email, m.rfc822_message_id,
                m.references_header, m.snippet, m.received_at, b.body_text, b.body_html
         FROM messages m
         LEFT JOIN message_bodies b ON b.message_id = m.message_id
         WHERE m.message_id = ?1",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        OneMailError::database(format!("Could not read the original message: {error}"))
    })?;
    let Some(row) = row else {
        return Err(OneMailError::not_found(format!(
            "Message {message_id} does not exist."
        )));
    };

    let addresses = sqlx::query(
        "SELECT kind, name, email FROM message_addresses
         WHERE message_id = ?1 ORDER BY sort_order, address_id",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(|error| {
        OneMailError::database(format!("Could not read the original participants: {error}"))
    })?
    .iter()
    .map(|address| {
        Ok(SourceAddress {
            kind: sqlx::Row::try_get(address, "kind").map_err(row_error)?,
            name: optional_string(address, "name"),
            email: sqlx::Row::try_get(address, "email").unwrap_or_default(),
        })
    })
    .collect::<OneMailResult<Vec<_>>>()?;

    Ok(SourceMessage {
        account_id: sqlx::Row::try_get(&row, "account_id").map_err(row_error)?,
        subject: optional_string(&row, "subject"),
        from_name: optional_string(&row, "from_name"),
        from_email: optional_string(&row, "from_email"),
        rfc822_message_id: optional_string(&row, "rfc822_message_id"),
        references_header: optional_string(&row, "references_header"),
        snippet: optional_string(&row, "snippet"),
        received_at: optional_string(&row, "received_at"),
        body_text: optional_string(&row, "body_text"),
        body_html: optional_string(&row, "body_html"),
        addresses,
    })
}

fn collect_addresses(
    addresses: &[SourceAddress],
    kind: &str,
    target: &mut Vec<MailAddress>,
    seen: &mut HashSet<String>,
) {
    for address in addresses.iter().filter(|address| address.kind == kind) {
        let normalized = address.email.trim().to_lowercase();
        if normalized.is_empty() || !seen.insert(normalized) {
            continue;
        }
        target.push(MailAddress {
            name: address.name.clone(),
            email: address.email.trim().to_string(),
        });
    }
}

enum SubjectKind {
    Reply,
    Forward,
}

fn format_subject(kind: SubjectKind, subject: &str) -> String {
    let trimmed = subject.trim();
    let lower = trimmed.to_lowercase();
    let already = match kind {
        SubjectKind::Reply => ["re:", "回复:", "回复：", "答复:", "答复："]
            .iter()
            .any(|prefix| lower.starts_with(prefix)),
        SubjectKind::Forward => ["fwd:", "fw:", "转发:", "转发："]
            .iter()
            .any(|prefix| lower.starts_with(prefix)),
    };
    if already {
        return trimmed.to_string();
    }
    let prefix = match kind {
        SubjectKind::Reply => "Re:",
        SubjectKind::Forward => "Fwd:",
    };
    format!("{prefix} {trimmed}").trim().to_string()
}

fn quote_body(body: &str) -> String {
    if body.trim().is_empty() {
        return String::new();
    }
    body.lines()
        .map(|line| format!("> {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn build_references(references: Option<&str>, in_reply_to: &str) -> String {
    let mut tokens = references
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let normalized = normalize_reference(in_reply_to);
    if !tokens
        .iter()
        .any(|token| normalize_reference(token) == normalized)
    {
        tokens.push(in_reply_to.trim().to_string());
    }
    tokens.join(" ")
}

fn normalize_reference(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .to_string()
}

// ---------------------------------------------------------------------------
// Records, accounts and small helpers
// ---------------------------------------------------------------------------

struct OutboxRecord {
    account_id: i64,
    compose_kind: ComposeKind,
    related_message_id: Option<i64>,
    status: OutboxStatus,
    in_reply_to: Option<String>,
    references_header: Option<String>,
    to: Vec<MailAddress>,
    cc: Vec<MailAddress>,
    bcc: Vec<MailAddress>,
    subject: String,
    body_text: String,
    body_html: String,
    attachments: Vec<DraftAttachmentInput>,
}

async fn load_outbox_record(
    pool: &SqlitePool,
    outbox_id: i64,
) -> OneMailResult<Option<OutboxRecord>> {
    let row = sqlx::query(
        "SELECT account_id, compose_kind, related_message_id, status, in_reply_to,
                references_header, to_json, cc_json, bcc_json, subject, body_text, body_html
         FROM outbox_messages WHERE outbox_id = ?1",
    )
    .bind(outbox_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        OneMailError::database(format!("Could not read the outbox record: {error}"))
    })?;
    let Some(row) = row else {
        return Ok(None);
    };
    let attachments = sqlx::query(
        "SELECT file_path, filename, mime_type, size_bytes FROM outbox_attachments
         WHERE outbox_id = ?1 ORDER BY attachment_id",
    )
    .bind(outbox_id)
    .fetch_all(pool)
    .await
    .map_err(|error| {
        OneMailError::database(format!("Could not read the outbox attachments: {error}"))
    })?;

    let kind_text: String = sqlx::Row::try_get(&row, "compose_kind").map_err(row_error)?;
    let status_text: String = sqlx::Row::try_get(&row, "status").map_err(row_error)?;
    Ok(Some(OutboxRecord {
        account_id: sqlx::Row::try_get(&row, "account_id").map_err(row_error)?,
        compose_kind: ComposeKind::parse(&kind_text).unwrap_or(ComposeKind::New),
        related_message_id: optional_i64(&row, "related_message_id"),
        status: OutboxStatus::parse(&status_text).unwrap_or(OutboxStatus::Draft),
        in_reply_to: optional_string(&row, "in_reply_to"),
        references_header: optional_string(&row, "references_header"),
        to: addresses_from_json(
            &sqlx::Row::try_get::<String, _>(&row, "to_json").unwrap_or_default(),
        ),
        cc: addresses_from_json(
            &sqlx::Row::try_get::<String, _>(&row, "cc_json").unwrap_or_default(),
        ),
        bcc: addresses_from_json(
            &sqlx::Row::try_get::<String, _>(&row, "bcc_json").unwrap_or_default(),
        ),
        subject: sqlx::Row::try_get::<Option<String>, _>(&row, "subject")
            .ok()
            .flatten()
            .unwrap_or_default(),
        body_text: sqlx::Row::try_get::<Option<String>, _>(&row, "body_text")
            .ok()
            .flatten()
            .unwrap_or_default(),
        body_html: sqlx::Row::try_get::<Option<String>, _>(&row, "body_html")
            .ok()
            .flatten()
            .unwrap_or_default(),
        attachments: attachments
            .iter()
            .map(|attachment| DraftAttachmentInput {
                file_path: optional_string(attachment, "file_path"),
                filename: sqlx::Row::try_get(attachment, "filename").unwrap_or_default(),
                mime_type: optional_string(attachment, "mime_type"),
                size_bytes: sqlx::Row::try_get(attachment, "size_bytes").unwrap_or_default(),
            })
            .collect(),
    }))
}

async fn account_email(pool: &SqlitePool, account_id: i64) -> OneMailResult<String> {
    let email: Option<String> =
        sqlx::query_scalar("SELECT email FROM accounts WHERE account_id = ?1")
            .bind(account_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not read the account: {error}"))
            })?;
    email.ok_or_else(|| OneMailError::not_found(format!("Account {account_id} does not exist.")))
}

async fn account_normalized_email(pool: &SqlitePool, account_id: i64) -> OneMailResult<String> {
    let email: Option<String> =
        sqlx::query_scalar("SELECT normalized_email FROM accounts WHERE account_id = ?1")
            .bind(account_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not read the account: {error}"))
            })?;
    email.ok_or_else(|| OneMailError::not_found(format!("Account {account_id} does not exist.")))
}

async fn account_for_send(pool: &SqlitePool, account_id: i64) -> OneMailResult<(String, bool)> {
    let row = sqlx::query("SELECT email, smtp_enabled FROM accounts WHERE account_id = ?1")
        .bind(account_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| OneMailError::database(format!("Could not read the account: {error}")))?;
    let Some(row) = row else {
        return Err(OneMailError::not_found(format!(
            "Account {account_id} does not exist."
        )));
    };
    Ok((
        sqlx::Row::try_get(&row, "email").map_err(row_error)?,
        sqlx::Row::try_get::<i64, _>(&row, "smtp_enabled").unwrap_or_default() != 0,
    ))
}

fn validate_recipients(input: &SendInput) -> OneMailResult<()> {
    if input.to.is_empty() && input.cc.is_empty() && input.bcc.is_empty() {
        return Err(OneMailError::invalid_input(
            "to",
            "A message needs at least one recipient.",
        ));
    }
    for address in input
        .to
        .iter()
        .chain(input.cc.iter())
        .chain(input.bcc.iter())
    {
        let email = address.email.trim();
        if email.is_empty() || !email.contains('@') || email.chars().any(char::is_whitespace) {
            return Err(OneMailError::invalid_input(
                "address",
                format!("\"{email}\" is not a valid e-mail address."),
            ));
        }
    }
    Ok(())
}

fn addresses_to_json(addresses: &[MailAddress]) -> OneMailResult<String> {
    serde_json::to_string(addresses)
        .map_err(|error| OneMailError::internal(format!("Could not encode an address: {error}")))
}

fn addresses_from_json(value: &str) -> Vec<MailAddress> {
    serde_json::from_str(value).unwrap_or_default()
}

fn new_message_id() -> String {
    format!("<{}@one-mail.local>", uuid::Uuid::new_v4())
}

fn describe_error(error: &OneMailError) -> String {
    let code = serde_json::to_value(error.code)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "internal".to_string());
    let value = format!("{code}: {}", error.message);
    value.chars().take(300).collect()
}

fn snippet(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(200).collect()
}

fn row_error(error: sqlx::Error) -> OneMailError {
    OneMailError::database(format!("Could not read an outbox row: {error}"))
}

fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::message::test_support::{
        insert_account, insert_address, insert_body, insert_folder, insert_message, open_pool,
        MessageSeed,
    };

    struct SuccessSender;

    #[async_trait::async_trait]
    impl MailSender for SuccessSender {
        async fn deliver(&self, _account_id: i64, _input: &SendInput) -> OneMailResult<SendResult> {
            Ok(SendResult {
                outbox_id: 0,
                status: OutboxStatus::Sent,
                rfc822_message_id: String::new(),
                sent_at: Some("2026-02-01T00:00:00Z".to_string()),
                warning: None,
            })
        }
    }

    struct FailingSender;

    #[async_trait::async_trait]
    impl MailSender for FailingSender {
        async fn deliver(&self, _account_id: i64, _input: &SendInput) -> OneMailResult<SendResult> {
            Err(OneMailError::network(
                "The SMTP server at smtp.example.test:587 could not be reached.",
            ))
        }
    }

    async fn seed() -> (tempfile::TempDir, SqlitePool) {
        let (directory, pool) = open_pool().await;
        insert_account(&pool, 1, "me@example.test").await;
        insert_folder(&pool, 1, 1, "INBOX", "inbox").await;
        insert_folder(&pool, 2, 1, "Sent", "sent").await;
        (directory, pool)
    }

    fn address(email: &str) -> MailAddress {
        MailAddress {
            name: None,
            email: email.to_string(),
        }
    }

    fn send_input() -> SendInput {
        SendInput {
            outbox_id: None,
            account_id: 1,
            compose_kind: ComposeKind::New,
            related_message_id: None,
            to: vec![address("alice@example.test")],
            cc: Vec::new(),
            bcc: Vec::new(),
            subject: "Hello".to_string(),
            body_text: "Body".to_string(),
            body_html: String::new(),
            attachments: Vec::new(),
            in_reply_to: None,
            references_header: None,
        }
    }

    fn draft_input() -> DraftInput {
        DraftInput {
            outbox_id: None,
            account_id: 1,
            compose_kind: ComposeKind::New,
            related_message_id: None,
            to: vec![address("alice@example.test")],
            cc: Vec::new(),
            bcc: Vec::new(),
            subject: "Draft subject".to_string(),
            body_text: "Draft body".to_string(),
            body_html: String::new(),
            attachments: vec![DraftAttachmentInput {
                file_path: Some("C:/tmp/a.txt".to_string()),
                filename: "a.txt".to_string(),
                mime_type: Some("text/plain".to_string()),
                size_bytes: 3,
            }],
        }
    }

    #[tokio::test]
    async fn a_draft_round_trips_and_attachments_are_replaced() {
        let (_directory, pool) = seed().await;
        let saved = save_draft(&pool, draft_input()).await.unwrap();
        assert_eq!(saved.subject, "Draft subject");
        assert_eq!(saved.attachments.len(), 1);
        assert_eq!(saved.to[0].email, "alice@example.test");
        assert!(saved.in_reply_to.is_none());

        let mut update = draft_input();
        update.outbox_id = Some(saved.outbox_id);
        update.subject = "Edited".to_string();
        update.attachments = vec![DraftAttachmentInput {
            file_path: Some("C:/tmp/b.txt".to_string()),
            filename: "b.txt".to_string(),
            mime_type: None,
            size_bytes: 9,
        }];
        let edited = save_draft(&pool, update).await.unwrap();
        assert_eq!(edited.outbox_id, saved.outbox_id);
        assert_eq!(edited.subject, "Edited");
        assert_eq!(edited.attachments.len(), 1);
        assert_eq!(edited.attachments[0].filename, "b.txt");

        let status: String =
            sqlx::query_scalar("SELECT status FROM outbox_messages WHERE outbox_id = ?1")
                .bind(saved.outbox_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "draft");
    }

    #[tokio::test]
    async fn saving_over_a_sent_row_and_deleting_one_are_refused() {
        let (_directory, pool) = seed().await;
        let draft = save_draft(&pool, draft_input()).await.unwrap();
        sqlx::query("UPDATE outbox_messages SET status = 'sent' WHERE outbox_id = ?1")
            .bind(draft.outbox_id)
            .execute(&pool)
            .await
            .unwrap();

        let mut update = draft_input();
        update.outbox_id = Some(draft.outbox_id);
        assert!(save_draft(&pool, update).await.is_err());
        assert!(delete_draft(&pool, draft.outbox_id).await.is_err());
        assert!(delete_outbox(&pool, draft.outbox_id).await.unwrap());
    }

    #[tokio::test]
    async fn delete_draft_removes_only_drafts() {
        let (_directory, pool) = seed().await;
        let draft = save_draft(&pool, draft_input()).await.unwrap();
        assert!(delete_draft(&pool, draft.outbox_id).await.unwrap());
        assert!(!delete_draft(&pool, draft.outbox_id).await.unwrap());
    }

    fn source_seed() -> MessageSeed {
        MessageSeed::new(10, 1, 1, 100)
            .from(Some("Alice"), "alice@example.test")
            .subject("Project plan")
            .rfc822("<plan@example.test>")
            .references("<older@example.test>")
            .received_at("2026-01-05T09:00:00Z")
            .snippet("The plan is ready")
    }

    #[tokio::test]
    async fn reply_prefills_the_sender_subject_quote_and_thread_headers() {
        let (_directory, pool) = seed().await;
        insert_message(&pool, source_seed()).await;
        insert_address(&pool, 10, "to", Some("Me"), "me@example.test").await;
        insert_address(&pool, 10, "cc", Some("Bob"), "bob@example.test").await;
        insert_body(&pool, 10, Some("Line one\nLine two"), None).await;

        let draft = reply_draft(&pool, 10, false).await.unwrap();
        assert_eq!(draft.compose_kind, ComposeKind::Reply);
        assert_eq!(draft.related_message_id, Some(10));
        assert_eq!(draft.to.len(), 1);
        assert_eq!(draft.to[0].email, "alice@example.test");
        assert!(draft.cc.is_empty());
        assert_eq!(draft.subject, "Re: Project plan");
        assert_eq!(draft.body_text, "> Line one\n> Line two");
        assert_eq!(draft.in_reply_to.as_deref(), Some("<plan@example.test>"));
        assert_eq!(
            draft.references_header.as_deref(),
            Some("<older@example.test> <plan@example.test>")
        );

        let status: String =
            sqlx::query_scalar("SELECT status FROM outbox_messages WHERE outbox_id = ?1")
                .bind(draft.outbox_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "draft");
    }

    #[tokio::test]
    async fn reply_all_keeps_the_public_recipients_and_drops_the_account() {
        let (_directory, pool) = seed().await;
        insert_message(&pool, source_seed()).await;
        insert_address(&pool, 10, "to", Some("Me"), "me@example.test").await;
        insert_address(&pool, 10, "cc", Some("Bob"), "bob@example.test").await;

        let draft = reply_draft(&pool, 10, true).await.unwrap();
        assert_eq!(draft.compose_kind, ComposeKind::ReplyAll);
        assert_eq!(draft.to.len(), 1);
        assert_eq!(draft.to[0].email, "alice@example.test");
        assert_eq!(draft.cc.len(), 1);
        assert_eq!(draft.cc[0].email, "bob@example.test");
    }

    #[tokio::test]
    async fn forward_prefills_the_block_and_leaves_recipients_empty() {
        let (_directory, pool) = seed().await;
        insert_message(&pool, source_seed()).await;
        insert_body(&pool, 10, Some("Forwarded body"), None).await;

        let draft = forward_draft(&pool, 10).await.unwrap();
        assert_eq!(draft.compose_kind, ComposeKind::Forward);
        assert!(draft.to.is_empty());
        assert!(draft.cc.is_empty());
        assert!(draft.bcc.is_empty());
        assert_eq!(draft.subject, "Fwd: Project plan");
        assert!(draft
            .body_text
            .starts_with("---------- Forwarded message ----------"));
        assert!(draft.body_text.contains("From: Alice <alice@example.test>"));
        assert!(draft.body_text.contains("Forwarded body"));
        assert!(draft.in_reply_to.is_none());
        assert!(draft.references_header.is_none());
    }

    #[tokio::test]
    async fn send_moves_the_row_through_sending_to_sent() {
        let (_directory, pool) = seed().await;
        let result = send_via(&pool, &SuccessSender, send_input()).await.unwrap();
        assert_eq!(result.status, OutboxStatus::Sent);
        assert!(result.outbox_id > 0);
        assert!(result.rfc822_message_id.ends_with("@one-mail.local>"));

        let (status, sent_at, last_error, stored_id): (
            String,
            Option<String>,
            Option<String>,
            String,
        ) = sqlx::query_as(
            "SELECT status, sent_at, last_error, rfc822_message_id FROM outbox_messages
             WHERE outbox_id = ?1",
        )
        .bind(result.outbox_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "sent");
        assert_eq!(sent_at.as_deref(), Some("2026-02-01T00:00:00Z"));
        assert!(last_error.is_none());
        assert_eq!(stored_id, result.rfc822_message_id);
    }

    #[tokio::test]
    async fn a_failed_send_is_recorded_sanitized_and_can_be_retried() {
        let (_directory, pool) = seed().await;
        let error = send_via(&pool, &FailingSender, send_input())
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::error::OneMailErrorCode::Network);

        let (outbox_id, status, last_error): (i64, String, String) = sqlx::query_as(
            "SELECT outbox_id, status, last_error FROM outbox_messages ORDER BY outbox_id LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "failed");
        assert!(last_error.starts_with("network: "));
        assert!(last_error.contains("smtp.example.test"));

        let retried = retry_via(&pool, &SuccessSender, outbox_id).await.unwrap();
        assert_eq!(retried.outbox_id, outbox_id);
        assert_eq!(retried.status, OutboxStatus::Sent);
        let status: String =
            sqlx::query_scalar("SELECT status FROM outbox_messages WHERE outbox_id = ?1")
                .bind(outbox_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "sent");
    }

    #[tokio::test]
    async fn retry_refuses_anything_but_a_failed_row() {
        let (_directory, pool) = seed().await;
        let draft = save_draft(&pool, draft_input()).await.unwrap();

        let error = retry_via(&pool, &SuccessSender, draft.outbox_id)
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::error::OneMailErrorCode::InvalidInput);
        assert!(retry_via(&pool, &SuccessSender, 999).await.is_err());
    }

    #[tokio::test]
    async fn sending_a_sent_row_or_a_missing_account_is_refused() {
        let (_directory, pool) = seed().await;
        let result = send_via(&pool, &SuccessSender, send_input()).await.unwrap();

        let mut duplicate = send_input();
        duplicate.outbox_id = Some(result.outbox_id);
        let error = send_via(&pool, &SuccessSender, duplicate)
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::error::OneMailErrorCode::InvalidInput);

        let mut unknown = send_input();
        unknown.account_id = 99;
        assert!(send_via(&pool, &SuccessSender, unknown).await.is_err());

        let mut empty = send_input();
        empty.to.clear();
        empty.cc.clear();
        empty.bcc.clear();
        let error = send_via(&pool, &SuccessSender, empty).await.unwrap_err();
        assert_eq!(error.code, crate::error::OneMailErrorCode::InvalidInput);

        let mut malformed = send_input();
        malformed.to = vec![address("not-an-address")];
        assert!(send_via(&pool, &SuccessSender, malformed).await.is_err());
    }

    #[tokio::test]
    async fn list_outbox_orders_by_update_and_counts_attachments() {
        let (_directory, pool) = seed().await;
        let saved = save_draft(&pool, draft_input()).await.unwrap();
        send_via(&pool, &FailingSender, send_input())
            .await
            .unwrap_err();

        let items = list_outbox(&pool, Some(1)).await.unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().any(|item| item.outbox_id == saved.outbox_id
            && item.attachment_count == 1
            && item.status == OutboxStatus::Draft));
        assert!(items
            .iter()
            .any(|item| item.status == OutboxStatus::Failed && item.last_error.is_some()));

        let other_account = list_outbox(&pool, Some(2)).await.unwrap();
        assert!(other_account.is_empty());
    }

    #[tokio::test]
    async fn deleting_a_sending_row_is_busy_and_other_rows_are_removed() {
        let (_directory, pool) = seed().await;
        let draft = save_draft(&pool, draft_input()).await.unwrap();
        sqlx::query("UPDATE outbox_messages SET status = 'sending' WHERE outbox_id = ?1")
            .bind(draft.outbox_id)
            .execute(&pool)
            .await
            .unwrap();

        let error = delete_outbox(&pool, draft.outbox_id).await.unwrap_err();
        assert_eq!(error.code, crate::error::OneMailErrorCode::Busy);

        sqlx::query("UPDATE outbox_messages SET status = 'failed' WHERE outbox_id = ?1")
            .bind(draft.outbox_id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(delete_outbox(&pool, draft.outbox_id).await.unwrap());
        assert!(!delete_outbox(&pool, draft.outbox_id).await.unwrap());
    }

    #[test]
    fn subject_prefixes_are_not_doubled() {
        assert_eq!(format_subject(SubjectKind::Reply, "Hello"), "Re: Hello");
        assert_eq!(format_subject(SubjectKind::Reply, "RE: Hello"), "RE: Hello");
        assert_eq!(
            format_subject(SubjectKind::Reply, "回复：你好"),
            "回复：你好"
        );
        assert_eq!(format_subject(SubjectKind::Forward, "Hello"), "Fwd: Hello");
        assert_eq!(
            format_subject(SubjectKind::Forward, "Fwd: Hello"),
            "Fwd: Hello"
        );
        assert_eq!(format_subject(SubjectKind::Reply, ""), "Re:");
    }

    #[test]
    fn references_append_the_reply_id_once() {
        assert_eq!(build_references(Some("<a> <b>"), "<c>"), "<a> <b> <c>");
        assert_eq!(build_references(Some("<a> <b>"), "<b>"), "<a> <b>");
        assert_eq!(build_references(None, "<a>"), "<a>");
    }

    #[test]
    fn a_blank_body_has_no_quote_block() {
        assert_eq!(quote_body(""), "");
        assert_eq!(quote_body("a\nb"), "> a\n> b");
    }

    #[test]
    fn attachment_types_come_from_the_extension() {
        assert_eq!(guess_mime_type("invoice.PDF"), Some("application/pdf"));
        assert_eq!(guess_mime_type("notes.md"), Some("text/plain"));
        assert_eq!(guess_mime_type("photo.jpeg"), Some("image/jpeg"));
        assert_eq!(guess_mime_type("archive.7z"), None);
        assert_eq!(guess_mime_type("README"), None);
    }
}
