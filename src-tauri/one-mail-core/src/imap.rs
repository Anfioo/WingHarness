// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! UID selection, batched FETCH and incremental sync for one account.
//!
//! One session serves every folder of the account: logging in again per folder
//! is what makes a first sync slow and trips a provider's rate limits. Every
//! batch commits its own short transaction, so cancelling between batches keeps
//! what was already saved instead of losing the whole folder.

use std::collections::HashSet;

use async_imap::types::Flag;
use futures_util::TryStreamExt;
use sqlx::{Row, SqlitePool};
use tokio_util::sync::CancellationToken;

use crate::error::{OneMailError, OneMailErrorCode, OneMailResult};
use crate::mime::{self, ParsedHeaders};
use crate::models::{FolderRole, FolderSyncReport, SyncMode, SyncProgressPayload, SyncReport};
use crate::state::{OneMailState, EVENT_SYNC_PROGRESS};
use crate::transport::{self, ImapConnectionConfig, ImapSession};

/// Never pull more than this many messages per folder in one run.
pub(crate) const MAX_MESSAGES_PER_FOLDER: usize = 200;
/// UIDs per `UID FETCH`, small enough that one batch stays well inside the
/// command timeout on a slow mailbox.
pub(crate) const FETCH_BATCH_SIZE: usize = 100;
/// Summary query: UID and flags for the read state, the date for the sort
/// order, the size for the list row, and the header block for everything else.
const SUMMARY_QUERY: &str = "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])";

#[derive(Clone, Debug)]
struct SyncFolder {
    folder_id: i64,
    path: String,
    role: FolderRole,
}

/// One message as it comes out of a summary fetch.
struct FetchedSummary {
    uid: u32,
    headers: ParsedHeaders,
    size_bytes: u32,
    is_read: bool,
    is_answered: bool,
    is_starred: bool,
    is_draft: bool,
    internal_date: Option<String>,
}

struct FolderOutcome {
    report: FolderSyncReport,
    new_message_ids: Vec<i64>,
}

/// The frozen entry point: sync one account and return its report.
pub async fn sync_account(
    state: &OneMailState,
    account_id: i64,
    mode: SyncMode,
) -> OneMailResult<SyncReport> {
    let (report, _new_message_ids) = sync_account_with_new(state, account_id, mode).await?;
    Ok(report)
}

/// The same run, but it also hands back the row ids of the messages it inserted
/// into INBOX, so `sync::start` can raise `one-mail:new-mail` once per account.
pub(crate) async fn sync_account_with_new(
    state: &OneMailState,
    account_id: i64,
    mode: SyncMode,
) -> OneMailResult<(SyncReport, Vec<i64>)> {
    let account = transport::load_account(state, account_id).await?;
    transport::ensure_supported_auth(account.auth_type)?;
    set_account_status(state, account_id, "syncing", None).await?;

    let pool = state.pool().await?;
    ensure_inbox(&pool, account_id).await?;
    let folders = load_sync_folders(&pool, account_id).await?;
    emit_progress(state, account_id, None, "folders", 0, 0, None);
    if folders.is_empty() {
        set_account_status(state, account_id, "active", None).await?;
        return Ok((empty_report(account_id, true), Vec::new()));
    }

    // Copy the token: checking it must not need the lock, and the lock is never
    // held across the network work.
    let cancel = state.sync().lock().await.cancel.clone();
    let config = account.imap_config();
    let mut session = match transport::connect_authenticated(&config, &account.password).await {
        Ok(session) => session,
        Err(error) => {
            set_account_status(
                state,
                account_id,
                status_for_error(&error),
                Some(&error.message),
            )
            .await?;
            emit_progress(
                state,
                account_id,
                None,
                "error",
                0,
                0,
                Some(error.message.clone()),
            );
            let mut report = empty_report(account_id, false);
            report.error = Some(error.message);
            return Ok((report, Vec::new()));
        }
    };

    let window_days = crate::settings::read()
        .map(|settings| settings.sync_window_days.max(1))
        .unwrap_or(90);
    let mut folder_reports = Vec::with_capacity(folders.len());
    let mut failures = Vec::new();
    let mut new_message_ids = Vec::new();
    let mut cancelled = false;

    for folder in &folders {
        if cancel.is_cancelled() {
            cancelled = true;
            break;
        }
        let outcome = sync_folder(
            state,
            &pool,
            &config,
            &mut session,
            account_id,
            folder,
            mode,
            window_days,
            &cancel,
        )
        .await;
        match outcome {
            Ok(outcome) => {
                new_message_ids.extend(outcome.new_message_ids);
                folder_reports.push(outcome.report);
            }
            Err(error) => {
                record_folder_error(&pool, folder.folder_id, &error.message).await;
                failures.push(format!("{}: {}", folder.path, error.message));
                folder_reports.push(FolderSyncReport {
                    folder_id: folder.folder_id,
                    path: folder.path.clone(),
                    scanned: 0,
                    inserted: 0,
                    updated: 0,
                    error: Some(error.message),
                });
            }
        }
    }

    emit_progress(state, account_id, None, "saving", 0, 0, None);
    // A failed LOGOUT must not hide the batches that are already committed.
    transport::logout(&mut session).await;

    let error = (!failures.is_empty()).then(|| {
        format!(
            "Some folders of this account could not be synced: {}",
            failures.join("; ")
        )
    });
    let ok = failures.is_empty() && !cancelled;
    match &error {
        Some(error) => set_account_status(state, account_id, "sync_error", Some(error)).await?,
        None => set_account_status(state, account_id, "active", None).await?,
    }

    Ok((
        SyncReport {
            account_id: Some(account_id),
            folders: folder_reports,
            new_message_count: u32::try_from(new_message_ids.len()).unwrap_or(u32::MAX),
            ok,
            error,
        },
        new_message_ids,
    ))
}

fn empty_report(account_id: i64, ok: bool) -> SyncReport {
    SyncReport {
        account_id: Some(account_id),
        folders: Vec::new(),
        new_message_count: 0,
        ok,
        error: None,
    }
}

#[allow(clippy::too_many_arguments)]
async fn sync_folder(
    state: &OneMailState,
    pool: &SqlitePool,
    config: &ImapConnectionConfig,
    session: &mut ImapSession,
    account_id: i64,
    folder: &SyncFolder,
    mode: SyncMode,
    window_days: u32,
    cancel: &CancellationToken,
) -> OneMailResult<FolderOutcome> {
    let mailbox =
        transport::command_timeout(config, "SELECT", session.select(&folder.path)).await?;
    let current_uid_validity = mailbox.uid_validity.map(|value| value.to_string());
    let stored = load_folder_state(pool, folder.folder_id).await?;
    let previous_uid_validity = stored.as_ref().and_then(|row| row.1.clone());
    let reset = uid_validity_changed(
        previous_uid_validity.as_deref(),
        current_uid_validity.as_deref(),
    );
    // A new UIDVALIDITY means every stored UID now points at a different
    // message: throw the folder away and start over from the window.
    if reset {
        purge_folder(pool, folder.folder_id).await?;
    }
    let last_uid = if reset {
        0
    } else {
        stored.as_ref().map(|row| row.0).unwrap_or(0)
    };

    let query = uid_search_query(mode, last_uid, &since_date(window_days));
    let mut remote = transport::command_timeout(config, "SEARCH", session.uid_search(&query))
        .await?
        .into_iter()
        .collect::<Vec<u32>>();
    remote.sort_unstable();

    let existing = load_existing_uids(pool, folder.folder_id).await?;
    // A refresh only ever inserts what it has not seen; a full scan also walks
    // the stored messages again, which is how their `\Seen` / `\Flagged` flags
    // catch up with what happened on the server.
    let selected = match mode {
        SyncMode::Refresh => filter_existing(select_uids(&remote, last_uid, mode), &existing),
        SyncMode::Full => select_uids(&remote, last_uid, mode),
    };
    let already_sent = if folder.role == FolderRole::Sent {
        load_sent_message_ids(pool).await?
    } else {
        HashSet::new()
    };

    let mut report = FolderSyncReport {
        folder_id: folder.folder_id,
        path: folder.path.clone(),
        scanned: 0,
        inserted: 0,
        updated: 0,
        error: None,
    };
    let mut new_message_ids = Vec::new();
    let mut highest_uid = last_uid;

    for batch in chunk_uids(&selected) {
        if cancel.is_cancelled() {
            break;
        }
        let fetched = fetch_batch(config, session, &batch).await?;
        for summary in fetched {
            if folder.role == FolderRole::Sent {
                if let Some(message_id) = summary
                    .headers
                    .message_id
                    .as_deref()
                    .map(|value| value.trim().to_string())
                {
                    if already_sent.contains(&message_id) {
                        // The local outbox is the canonical copy of what this
                        // app sent; importing the server copy would duplicate it.
                        highest_uid = highest_uid.max(i64::from(summary.uid));
                        continue;
                    }
                }
            }
            let is_new = !existing.contains(&summary.uid);
            let message_id = save_message(pool, account_id, folder, &summary, is_new).await?;
            report.scanned += 1;
            if is_new {
                report.inserted += 1;
                if folder.role == FolderRole::Inbox {
                    new_message_ids.push(message_id);
                }
            } else {
                report.updated += 1;
            }
            highest_uid = highest_uid.max(i64::from(summary.uid));
        }
        emit_progress(
            state,
            account_id,
            Some(&folder.path),
            "headers",
            report.scanned,
            report.inserted,
            None,
        );
    }

    save_folder_state(
        pool,
        folder.folder_id,
        highest_uid,
        current_uid_validity.as_deref(),
    )
    .await?;
    refresh_folder_counts(pool, folder.folder_id).await?;
    emit_progress(
        state,
        account_id,
        Some(&folder.path),
        "saving",
        report.scanned,
        report.inserted,
        None,
    );

    Ok(FolderOutcome {
        report,
        new_message_ids,
    })
}

async fn fetch_batch(
    config: &ImapConnectionConfig,
    session: &mut ImapSession,
    batch: &[u32],
) -> OneMailResult<Vec<FetchedSummary>> {
    let uid_set = batch
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let mut stream =
        transport::command_timeout(config, "FETCH", session.uid_fetch(&uid_set, SUMMARY_QUERY))
            .await?;
    let mut summaries = Vec::with_capacity(batch.len());
    loop {
        let next = tokio::time::timeout(transport::COMMAND_TIMEOUT, stream.try_next())
            .await
            .map_err(|_| {
                OneMailError::network(format!(
                    "Reading message summaries from {} timed out.",
                    config.host
                ))
            })?;
        let Some(item) = next.map_err(|error| transport::imap_error(config, "FETCH", &error))?
        else {
            break;
        };
        let Some(uid) = item.uid else { continue };
        let Some(header_bytes) = item.header() else {
            continue;
        };
        let headers = mime::parse_raw_headers(header_bytes)?;
        summaries.push(FetchedSummary {
            uid,
            headers,
            size_bytes: item.size.unwrap_or(0),
            is_read: item.flags().any(|flag| matches!(flag, Flag::Seen)),
            is_answered: item.flags().any(|flag| matches!(flag, Flag::Answered)),
            is_starred: item.flags().any(|flag| matches!(flag, Flag::Flagged)),
            is_draft: item.flags().any(|flag| matches!(flag, Flag::Draft)),
            internal_date: item.internal_date().map(|value| {
                value
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            }),
        });
    }
    drop(stream);
    Ok(summaries)
}

// ---------------------------------------------------------------------------
// Pure selection helpers
// ---------------------------------------------------------------------------

/// The `UID SEARCH` criteria for this run.
///
/// `UID n:*` returns the newest message even when `n` is beyond it, so the
/// caller still filters on `last_uid`; `SINCE` bounds a first or full scan to
/// the configured window instead of the whole mailbox.
pub(crate) fn uid_search_query(mode: SyncMode, last_uid: i64, since: &str) -> String {
    match mode {
        SyncMode::Refresh if last_uid > 0 && last_uid < i64::from(u32::MAX) => {
            format!("UID {}:*", last_uid + 1)
        }
        _ => format!("SINCE {since}"),
    }
}

/// The IMAP `SINCE` date (`12-Aug-2026`) for a window of `days` days.
pub(crate) fn since_date(days: u32) -> String {
    let start = chrono::Utc::now() - chrono::Duration::days(i64::from(days.max(1)));
    start.format("%d-%b-%Y").to_string()
}

/// Keep only what this run may insert: everything above the cursor, capped at
/// the newest [`MAX_MESSAGES_PER_FOLDER`] messages.
pub(crate) fn select_uids(remote: &[u32], last_uid: i64, mode: SyncMode) -> Vec<u32> {
    let mut uids = remote
        .iter()
        .copied()
        .filter(|uid| match mode {
            SyncMode::Refresh => i64::from(*uid) > last_uid,
            SyncMode::Full => true,
        })
        .collect::<Vec<_>>();
    uids.sort_unstable();
    uids.dedup();
    if uids.len() > MAX_MESSAGES_PER_FOLDER {
        uids = uids.split_off(uids.len() - MAX_MESSAGES_PER_FOLDER);
    }
    uids
}

/// Split a run into `UID FETCH` batches of at most [`FETCH_BATCH_SIZE`].
pub(crate) fn chunk_uids(uids: &[u32]) -> Vec<Vec<u32>> {
    if uids.is_empty() {
        return Vec::new();
    }
    uids.chunks(FETCH_BATCH_SIZE).map(<[u32]>::to_vec).collect()
}

/// Drop the UIDs already stored for this folder: their summary is there and
/// their body is fetched on demand.
pub(crate) fn filter_existing(uids: Vec<u32>, existing: &HashSet<u32>) -> Vec<u32> {
    uids.into_iter()
        .filter(|uid| !existing.contains(uid))
        .collect()
}

/// A UID is only comparable within one UIDVALIDITY.
pub(crate) fn uid_validity_changed(previous: Option<&str>, current: Option<&str>) -> bool {
    matches!((previous, current), (Some(previous), Some(current)) if previous != current)
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async fn ensure_inbox(pool: &SqlitePool, account_id: i64) -> OneMailResult<()> {
    let now = now_iso8601();
    sqlx::query(
        "INSERT OR IGNORE INTO folders
             (account_id, path, name, role, is_selectable, sync_enabled, total_count, unread_count,
              created_at, updated_at)
         VALUES (?1, 'INBOX', 'INBOX', 'inbox', 1, 1, 0, 0, ?2, ?2)",
    )
    .bind(account_id)
    .bind(now)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|error| OneMailError::database(format!("Could not make sure INBOX exists: {error}")))
}

async fn load_sync_folders(pool: &SqlitePool, account_id: i64) -> OneMailResult<Vec<SyncFolder>> {
    let rows = sqlx::query(
        "SELECT folder_id, path, role FROM folders
         WHERE account_id = ?1 AND is_selectable = 1
           AND (sync_enabled = 1 OR upper(path) = 'INBOX')
         ORDER BY CASE WHEN upper(path) = 'INBOX' THEN 0 ELSE 1 END, folder_id",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    .map_err(|error| {
        OneMailError::database(format!("Could not read the folders to sync: {error}"))
    })?;
    rows.iter()
        .map(|row| {
            Ok(SyncFolder {
                folder_id: row.try_get("folder_id").map_err(|error| {
                    OneMailError::database(format!("Could not read a folder id: {error}"))
                })?,
                path: row.try_get("path").map_err(|error| {
                    OneMailError::database(format!("Could not read a folder path: {error}"))
                })?,
                role: transport::role_from_str(
                    &row.try_get::<String, _>("role").unwrap_or_default(),
                ),
            })
        })
        .collect()
}

/// `(last_uid, uid_validity)` as stored for the folder.
async fn load_folder_state(
    pool: &SqlitePool,
    folder_id: i64,
) -> OneMailResult<Option<(i64, Option<String>)>> {
    let row =
        sqlx::query("SELECT last_uid, uid_validity FROM folder_sync_states WHERE folder_id = ?1")
            .bind(folder_id)
            .fetch_optional(pool)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not read the folder UID cursor: {error}"))
            })?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some((
        row.try_get("last_uid").unwrap_or(0),
        row.try_get("uid_validity").unwrap_or_default(),
    )))
}

async fn load_existing_uids(pool: &SqlitePool, folder_id: i64) -> OneMailResult<HashSet<u32>> {
    let rows = sqlx::query("SELECT uid FROM messages WHERE folder_id = ?1")
        .bind(folder_id)
        .fetch_all(pool)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not read the stored UIDs: {error}"))
        })?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let uid: i64 = row.try_get("uid").ok()?;
            u32::try_from(uid).ok()
        })
        .collect())
}

/// The Message-IDs this app already recorded as sent, so a Sent folder scan
/// does not duplicate them.
async fn load_sent_message_ids(pool: &SqlitePool) -> OneMailResult<HashSet<String>> {
    let rows = sqlx::query(
        "SELECT rfc822_message_id FROM outbox_messages
         WHERE status = 'sent' AND rfc822_message_id IS NOT NULL AND TRIM(rfc822_message_id) <> ''",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| {
        OneMailError::database(format!("Could not read the sent message ids: {error}"))
    })?;
    Ok(rows
        .iter()
        .filter_map(|row| row.try_get::<String, _>("rfc822_message_id").ok())
        .map(|value| value.trim().to_string())
        .collect())
}

async fn save_message(
    pool: &SqlitePool,
    account_id: i64,
    folder: &SyncFolder,
    summary: &FetchedSummary,
    is_new: bool,
) -> OneMailResult<i64> {
    let headers = &summary.headers;
    let received_at = summary
        .internal_date
        .clone()
        .or_else(|| headers.sent_at.clone());
    let mut transaction = pool.begin().await.map_err(|error| {
        OneMailError::database(format!("Could not start saving a message: {error}"))
    })?;

    let message_id = if is_new {
        let message_id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO messages
                 (account_id, folder_id, uid, rfc822_message_id, in_reply_to, references_header,
                  subject, from_name, from_email, sent_at, received_at, size_bytes, is_read,
                  is_answered, is_starred, is_draft, has_attachments, body_status, raw_headers,
                  created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                     'none', ?18, ?19, ?19)
             RETURNING message_id",
        )
        .bind(account_id)
        .bind(folder.folder_id)
        .bind(i64::from(summary.uid))
        .bind(headers.message_id.clone())
        .bind(headers.in_reply_to.clone())
        .bind(headers.references_header.clone())
        .bind(headers.subject.clone())
        .bind(headers.from_name.clone())
        .bind(headers.from_email.clone())
        .bind(headers.sent_at.clone())
        .bind(received_at)
        .bind(i64::from(summary.size_bytes))
        .bind(i64::from(summary.is_read))
        .bind(i64::from(summary.is_answered))
        .bind(i64::from(summary.is_starred))
        .bind(i64::from(summary.is_draft))
        .bind(i64::from(headers.has_attachments))
        .bind(headers.raw_headers.clone())
        .bind(now_iso8601())
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not save a message summary: {error}"))
        })?;
        save_addresses(&mut transaction, message_id, headers).await?;
        message_id
    } else {
        let stored = sqlx::query_scalar::<_, i64>(
            "SELECT message_id FROM messages
             WHERE account_id = ?1 AND folder_id = ?2 AND uid = ?3",
        )
        .bind(account_id)
        .bind(folder.folder_id)
        .bind(i64::from(summary.uid))
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not read the stored message: {error}"))
        })?;
        let Some(message_id) = stored else {
            return Err(OneMailError::internal(
                "A message disappeared between listing and updating it.",
            ));
        };
        sqlx::query(
            "UPDATE messages SET
                 is_read = ?2, is_answered = ?3, is_starred = ?4, is_draft = ?5,
                 subject = COALESCE(NULLIF(TRIM(?6), ''), subject),
                 from_name = COALESCE(NULLIF(TRIM(?7), ''), from_name),
                 from_email = COALESCE(NULLIF(TRIM(?8), ''), from_email),
                 rfc822_message_id = COALESCE(NULLIF(TRIM(?9), ''), rfc822_message_id),
                 in_reply_to = COALESCE(NULLIF(TRIM(?10), ''), in_reply_to),
                 references_header = COALESCE(NULLIF(TRIM(?11), ''), references_header),
                 sent_at = COALESCE(NULLIF(TRIM(?12), ''), sent_at),
                 received_at = COALESCE(NULLIF(TRIM(?13), ''), received_at),
                 size_bytes = CASE WHEN ?14 > 0 THEN ?14 ELSE size_bytes END,
                 has_attachments = CASE WHEN ?15 = 1 THEN 1 ELSE has_attachments END,
                 updated_at = ?16
             WHERE message_id = ?1",
        )
        .bind(message_id)
        .bind(i64::from(summary.is_read))
        .bind(i64::from(summary.is_answered))
        .bind(i64::from(summary.is_starred))
        .bind(i64::from(summary.is_draft))
        .bind(headers.subject.clone())
        .bind(headers.from_name.clone())
        .bind(headers.from_email.clone())
        .bind(headers.message_id.clone())
        .bind(headers.in_reply_to.clone())
        .bind(headers.references_header.clone())
        .bind(headers.sent_at.clone())
        .bind(received_at)
        .bind(i64::from(summary.size_bytes))
        .bind(i64::from(headers.has_attachments))
        .bind(now_iso8601())
        .execute(&mut *transaction)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not update a message summary: {error}"))
        })?;
        message_id
    };

    transaction.commit().await.map_err(|error| {
        OneMailError::database(format!("Could not commit a message summary: {error}"))
    })?;
    Ok(message_id)
}

async fn save_addresses(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    message_id: i64,
    headers: &ParsedHeaders,
) -> OneMailResult<()> {
    for group in &headers.addresses {
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
            .bind(now_iso8601())
            .execute(&mut **transaction)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not save a message participant: {error}"))
            })?;
        }
    }
    Ok(())
}

async fn purge_folder(pool: &SqlitePool, folder_id: i64) -> OneMailResult<()> {
    let mut transaction = pool.begin().await.map_err(|error| {
        OneMailError::database(format!("Could not start resetting the folder: {error}"))
    })?;
    for statement in [
        "DELETE FROM message_search WHERE folder_id = ?1",
        "DELETE FROM messages WHERE folder_id = ?1",
        "DELETE FROM folder_sync_states WHERE folder_id = ?1",
    ] {
        sqlx::query(statement)
            .bind(folder_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                OneMailError::database(format!("Could not reset the folder: {error}"))
            })?;
    }
    transaction.commit().await.map_err(|error| {
        OneMailError::database(format!("Could not commit the folder reset: {error}"))
    })
}

async fn save_folder_state(
    pool: &SqlitePool,
    folder_id: i64,
    last_uid: i64,
    uid_validity: Option<&str>,
) -> OneMailResult<()> {
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO folder_sync_states
             (folder_id, last_uid, uid_validity, last_success_at, last_error, status,
              created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, 'idle', ?4, ?4)
         ON CONFLICT(folder_id) DO UPDATE SET
             last_uid = MAX(COALESCE(folder_sync_states.last_uid, 0), COALESCE(excluded.last_uid, 0)),
             uid_validity = COALESCE(excluded.uid_validity, folder_sync_states.uid_validity),
             last_success_at = excluded.last_success_at,
             last_error = NULL,
             status = 'idle',
             updated_at = excluded.updated_at",
    )
    .bind(folder_id)
    .bind(last_uid)
    .bind(uid_validity)
    .bind(now)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|error| {
        OneMailError::database(format!("Could not save the folder UID cursor: {error}"))
    })
}

async fn refresh_folder_counts(pool: &SqlitePool, folder_id: i64) -> OneMailResult<()> {
    sqlx::query(
        "UPDATE folders SET
             total_count = (SELECT COUNT(*) FROM messages WHERE folder_id = ?1),
             unread_count = (SELECT COUNT(*) FROM messages WHERE folder_id = ?1 AND is_read = 0),
             last_sync_at = ?2,
             updated_at = ?2
         WHERE folder_id = ?1",
    )
    .bind(folder_id)
    .bind(now_iso8601())
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|error| {
        OneMailError::database(format!("Could not refresh the folder counts: {error}"))
    })
}

async fn record_folder_error(pool: &SqlitePool, folder_id: i64, error: &str) {
    let now = now_iso8601();
    let result = sqlx::query(
        "INSERT INTO folder_sync_states (folder_id, last_error, status, created_at, updated_at)
         VALUES (?1, ?2, 'error', ?3, ?3)
         ON CONFLICT(folder_id) DO UPDATE SET
             last_error = excluded.last_error,
             status = 'error',
             updated_at = excluded.updated_at",
    )
    .bind(folder_id)
    .bind(error)
    .bind(now)
    .execute(pool)
    .await;
    if let Err(db_error) = result {
        log::warn!("Could not record a folder sync error: {db_error}");
    }
}

async fn set_account_status(
    state: &OneMailState,
    account_id: i64,
    status: &str,
    error: Option<&str>,
) -> OneMailResult<()> {
    let pool = state.pool().await?;
    sqlx::query(
        "UPDATE accounts SET
             status = ?2,
             last_error = ?3,
             last_sync_at = CASE WHEN ?2 = 'active' THEN ?4 ELSE last_sync_at END,
             updated_at = ?4
         WHERE account_id = ?1",
    )
    .bind(account_id)
    .bind(status)
    .bind(error)
    .bind(now_iso8601())
    .execute(&pool)
    .await
    .map(|_| ())
    .map_err(|error| {
        OneMailError::database(format!("Could not update the account sync status: {error}"))
    })
}

fn status_for_error(error: &OneMailError) -> &'static str {
    match error.code {
        OneMailErrorCode::AuthFailed => "auth_error",
        OneMailErrorCode::Network | OneMailErrorCode::Tls => "network_error",
        _ => "sync_error",
    }
}

fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Progress events are serialized outside every lock: the sync runtime lock is
/// only ever held for a flag change.
fn emit_progress(
    state: &OneMailState,
    account_id: i64,
    folder_path: Option<&str>,
    stage: &str,
    fetched: u32,
    inserted: u32,
    error: Option<String>,
) {
    state.emit(
        EVENT_SYNC_PROGRESS,
        SyncProgressPayload {
            account_id,
            folder_path: folder_path.map(str::to_string),
            stage: stage.to_string(),
            fetched,
            inserted,
            error,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::{
        chunk_uids, filter_existing, select_uids, since_date, uid_search_query,
        uid_validity_changed, FETCH_BATCH_SIZE, MAX_MESSAGES_PER_FOLDER,
    };
    use crate::models::SyncMode;
    use std::collections::HashSet;

    #[test]
    fn a_first_scan_fetches_the_newest_messages_only() {
        let remote = (1..=250).collect::<Vec<_>>();
        assert_eq!(
            select_uids(&remote, 0, SyncMode::Refresh),
            (51..=250).collect::<Vec<_>>()
        );
        assert_eq!(
            select_uids(&remote, 0, SyncMode::Full).len(),
            MAX_MESSAGES_PER_FOLDER
        );
    }

    #[test]
    fn a_refresh_fetches_only_uids_above_the_cursor() {
        let remote = vec![249, 250, 251];
        assert_eq!(select_uids(&remote, 249, SyncMode::Refresh), vec![250, 251]);
        assert!(select_uids(&remote, 251, SyncMode::Refresh).is_empty());
    }

    #[test]
    fn a_full_scan_rescans_the_whole_window() {
        let remote = vec![3, 1, 2];
        assert_eq!(select_uids(&remote, 2, SyncMode::Full), vec![1, 2, 3]);
    }

    #[test]
    fn the_batch_size_is_one_hundred_and_every_uid_is_covered() {
        let uids = (1..=250).collect::<Vec<_>>();
        let batches = chunk_uids(&uids);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].len(), FETCH_BATCH_SIZE);
        assert_eq!(batches[2], (201..=250).collect::<Vec<_>>());
        assert!(chunk_uids(&[]).is_empty());
    }

    #[test]
    fn existing_uids_are_skipped() {
        let existing = HashSet::from([10_u32, 12]);
        assert_eq!(filter_existing(vec![9, 10, 11, 12], &existing), vec![9, 11]);
        assert!(filter_existing(vec![10], &existing).is_empty());
    }

    #[test]
    fn a_refresh_with_a_cursor_searches_above_it() {
        assert_eq!(
            uid_search_query(SyncMode::Refresh, 41, "01-Jan-2026"),
            "UID 42:*"
        );
    }

    #[test]
    fn a_first_or_full_scan_searches_the_window() {
        assert_eq!(
            uid_search_query(SyncMode::Refresh, 0, "01-Jan-2026"),
            "SINCE 01-Jan-2026"
        );
        assert_eq!(
            uid_search_query(SyncMode::Full, 41, "01-Jan-2026"),
            "SINCE 01-Jan-2026"
        );
    }

    #[test]
    fn the_window_date_is_the_configured_number_of_days_back() {
        let date = since_date(90);
        let parsed = chrono::NaiveDate::parse_from_str(&date, "%d-%b-%Y")
            .expect("the SINCE date must be a valid IMAP date");
        let expected = (chrono::Utc::now() - chrono::Duration::days(90)).date_naive();
        assert_eq!(parsed, expected);
    }

    #[test]
    fn a_changed_uid_validity_is_a_reset() {
        assert!(uid_validity_changed(Some("100"), Some("101")));
        assert!(!uid_validity_changed(Some("100"), Some("100")));
        assert!(!uid_validity_changed(None, Some("100")));
        assert!(!uid_validity_changed(Some("100"), None));
    }

    /// The writes have to fit B1's real DDL, which is where a missing
    /// `created_at` or a role outside the `CHECK` list would surface — not at
    /// compile time.
    #[tokio::test]
    async fn summaries_and_cursors_round_trip_through_the_real_schema() {
        use super::{
            ensure_inbox, purge_folder, record_folder_error, refresh_folder_counts,
            save_folder_state, save_message, FetchedSummary, SyncFolder,
        };
        use crate::mime::{ParsedAddressGroup, ParsedHeaders};
        use crate::models::FolderRole;
        use crate::store;

        let directory = tempfile::tempdir().expect("temp dir");
        let pool = store::open_at(&directory.path().join("onemail.db"))
            .await
            .expect("open the mail database");
        sqlx::query(
            "INSERT INTO accounts (account_id, provider_key, email, normalized_email,
               account_label, avatar_text, color_key, auth_type, imap_host, imap_port,
               imap_security, password, created_at, updated_at)
             VALUES (1, 'custom', 'owner@example.com', 'owner@example.com', 'Owner', 'O', 'blue',
               'password', 'imap.example.com', 993, 'ssl_tls', 'secret', ?1, ?1)",
        )
        .bind("2026-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .expect("insert the account");

        ensure_inbox(&pool, 1).await.expect("ensure INBOX");
        let folder_id: i64 =
            sqlx::query_scalar("SELECT folder_id FROM folders WHERE account_id = 1")
                .fetch_one(&pool)
                .await
                .expect("read INBOX");
        let folder = SyncFolder {
            folder_id,
            path: "INBOX".to_string(),
            role: FolderRole::Inbox,
        };
        let summary = FetchedSummary {
            uid: 7,
            headers: ParsedHeaders {
                subject: Some("Quarterly report".to_string()),
                from_name: Some("Sender".to_string()),
                from_email: Some("sender@example.com".to_string()),
                sent_at: Some("2026-08-09T12:00:00Z".to_string()),
                addresses: vec![ParsedAddressGroup {
                    kind: "from".to_string(),
                    addresses: vec![(Some("Sender".to_string()), "sender@example.com".to_string())],
                }],
                ..ParsedHeaders::default()
            },
            size_bytes: 1234,
            is_read: false,
            is_answered: false,
            is_starred: false,
            is_draft: false,
            internal_date: Some("2026-08-09T12:00:05Z".to_string()),
        };

        let message_id = save_message(&pool, 1, &folder, &summary, true)
            .await
            .expect("insert a summary");
        save_message(&pool, 1, &folder, &summary, false)
            .await
            .expect("update the same summary");
        save_folder_state(&pool, folder_id, 7, Some("100"))
            .await
            .expect("write the cursor");
        save_folder_state(&pool, folder_id, 9, Some("100"))
            .await
            .expect("advance the cursor");
        refresh_folder_counts(&pool, folder_id)
            .await
            .expect("refresh the counts");

        let (subject, received_at): (String, Option<String>) =
            sqlx::query_as("SELECT subject, received_at FROM messages WHERE message_id = ?1")
                .bind(message_id)
                .fetch_one(&pool)
                .await
                .expect("read the summary");
        assert_eq!(subject, "Quarterly report");
        assert_eq!(received_at.as_deref(), Some("2026-08-09T12:00:05Z"));

        let addresses: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM message_addresses WHERE message_id = ?1")
                .bind(message_id)
                .fetch_one(&pool)
                .await
                .expect("count the participants");
        assert_eq!(addresses, 1, "the update must not duplicate participants");

        let (last_uid, uid_validity): (i64, String) = sqlx::query_as(
            "SELECT last_uid, uid_validity FROM folder_sync_states WHERE folder_id = ?1",
        )
        .bind(folder_id)
        .fetch_one(&pool)
        .await
        .expect("read the cursor");
        assert_eq!(last_uid, 9);
        assert_eq!(uid_validity, "100");

        let (total, unread): (i64, i64) =
            sqlx::query_as("SELECT total_count, unread_count FROM folders WHERE folder_id = ?1")
                .bind(folder_id)
                .fetch_one(&pool)
                .await
                .expect("read the counts");
        assert_eq!((total, unread), (1, 1));

        record_folder_error(&pool, folder_id, "the server said no").await;
        let stored_error: Option<String> =
            sqlx::query_scalar("SELECT last_error FROM folder_sync_states WHERE folder_id = ?1")
                .bind(folder_id)
                .fetch_one(&pool)
                .await
                .expect("read the folder error");
        assert_eq!(stored_error.as_deref(), Some("the server said no"));
        save_folder_state(&pool, folder_id, 9, Some("100"))
            .await
            .expect("a success clears the folder error");
        let cleared: Option<String> =
            sqlx::query_scalar("SELECT last_error FROM folder_sync_states WHERE folder_id = ?1")
                .bind(folder_id)
                .fetch_one(&pool)
                .await
                .expect("read the folder error");
        assert_eq!(cleared, None);

        purge_folder(&pool, folder_id)
            .await
            .expect("purge the folder");
        let remaining: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE folder_id = ?1")
                .bind(folder_id)
                .fetch_one(&pool)
                .await
                .expect("count what is left");
        assert_eq!(remaining, 0, "a UIDVALIDITY reset must drop the folder");
    }
}
