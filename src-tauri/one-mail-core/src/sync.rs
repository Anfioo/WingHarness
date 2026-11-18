// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Sync orchestration: take the one sync lock, walk the enabled accounts, emit
//! `one-mail:sync-progress` and let the caller cancel between batches.
//!
//! The lock guards the run flags and the cancellation token only. It is released
//! before any network or database work, so `one_mail_sync_status` answers while a
//! sync is running and `one_mail_sync_cancel` can always reach the token.

use std::sync::{Mutex as BlockingMutex, OnceLock};

use sqlx::{Row, SqlitePool};
use tokio_util::sync::CancellationToken;

use crate::error::{OneMailError, OneMailResult};
use crate::models::{
    BodyStatus, MailAddress, MailboxChangedPayload, MessageSummary, NewMailPayload, SyncInput,
    SyncMode, SyncProgressPayload, SyncReport, SyncStatus,
};
use crate::state::{OneMailState, EVENT_MAILBOX_CHANGED, EVENT_NEW_MAIL, EVENT_SYNC_PROGRESS};

/// When the last run finished, and what went wrong in it.
///
/// `SyncRuntime` only carries the live flags, so the outcome of the previous run
/// is kept here instead of widening a frozen struct.
static LAST_RESULT: OnceLock<BlockingMutex<Option<(String, Option<String>)>>> = OnceLock::new();

fn last_result_slot() -> &'static BlockingMutex<Option<(String, Option<String>)>> {
    LAST_RESULT.get_or_init(|| BlockingMutex::new(None))
}

fn remember_result(finished_at: String, error: Option<String>) {
    if let Ok(mut slot) = last_result_slot().lock() {
        *slot = Some((finished_at, error));
    }
}

fn read_last_result() -> (Option<String>, Option<String>) {
    let Ok(slot) = last_result_slot().lock() else {
        return (None, None);
    };
    match slot.as_ref() {
        Some((finished_at, error)) => (Some(finished_at.clone()), error.clone()),
        None => (None, None),
    }
}

/// Run one sync over the requested account, or over every enabled account.
///
/// Returns an aggregate report: a failing account is recorded in `error` and the
/// walk continues, so one broken password does not hide the other mailboxes.
pub async fn start(state: &OneMailState, input: SyncInput) -> OneMailResult<SyncReport> {
    {
        let mut runtime = state.sync().lock().await;
        if runtime.running {
            return Err(OneMailError::busy(
                "A mail sync is already running. Cancel it or wait for it to finish.",
            ));
        }
        runtime.running = true;
        runtime.account_id = input.account_id;
        runtime.started_at = Some(now_iso8601());
        runtime.cancel = CancellationToken::new();
    }

    let outcome = run(state, &input).await;

    {
        let mut runtime = state.sync().lock().await;
        runtime.running = false;
        runtime.account_id = None;
        // `started_at` describes the live run only; the finished time lives in
        // the static last-result record.
        runtime.started_at = None;
    }
    let error = match &outcome {
        Ok(report) => report.error.clone(),
        Err(error) => Some(error.message.clone()),
    };
    remember_result(now_iso8601(), error);
    outcome
}

/// Stop the running sync between batches. Returns whether there was one.
pub fn cancel(state: &OneMailState) -> bool {
    match state.sync().try_lock() {
        Ok(runtime) => {
            if !runtime.running {
                return false;
            }
            runtime.cancel.cancel();
            true
        }
        // The lock is only held for a flag change, so a miss means the run is
        // just starting or just finishing.
        Err(_) => false,
    }
}

pub async fn status(state: &OneMailState) -> SyncStatus {
    let runtime = state.sync().lock().await;
    let (last_finished_at, last_error) = read_last_result();
    SyncStatus {
        running: runtime.running,
        account_id: runtime.account_id,
        started_at: runtime.started_at.clone(),
        last_finished_at,
        last_error,
    }
}

async fn run(state: &OneMailState, input: &SyncInput) -> OneMailResult<SyncReport> {
    let targets = load_targets(state, input.account_id).await?;
    if targets.is_empty() {
        if input.account_id.is_some() {
            return Err(OneMailError::not_found("That mail account does not exist."));
        }
        return Ok(SyncReport {
            account_id: input.account_id,
            folders: Vec::new(),
            new_message_count: 0,
            ok: true,
            error: None,
        });
    }

    let mut reports = Vec::new();
    let mut failures = Vec::new();
    let mut new_message_count = 0_u32;

    for target in &targets {
        emit_progress(state, target.account_id, None, "connecting", 0, 0, None);
        match crate::imap::sync_account_with_new(state, target.account_id, input.mode).await {
            Ok((report, new_message_ids)) => {
                new_message_count = new_message_count.saturating_add(report.new_message_count);
                if let Some(error) = &report.error {
                    failures.push(error.clone());
                }
                reports.extend(report.folders);
                if input.mode == SyncMode::Refresh && !new_message_ids.is_empty() {
                    publish_new_mail(state, target, &new_message_ids).await;
                }
                emit_progress(
                    state,
                    target.account_id,
                    None,
                    if report.error.is_some() {
                        "error"
                    } else {
                        "done"
                    },
                    0,
                    report.new_message_count,
                    report.error.clone(),
                );
            }
            Err(error) => {
                failures.push(error.message.clone());
                emit_progress(
                    state,
                    target.account_id,
                    None,
                    "error",
                    0,
                    0,
                    Some(error.message.clone()),
                );
            }
        }
        state.emit(
            EVENT_MAILBOX_CHANGED,
            MailboxChangedPayload {
                account_id: target.account_id,
                folder_id: None,
            },
        );
    }

    let error = (!failures.is_empty()).then(|| failures.join("; "));
    Ok(SyncReport {
        account_id: input.account_id,
        folders: reports,
        new_message_count,
        ok: error.is_none(),
        error,
    })
}

struct SyncTarget {
    account_id: i64,
    account_label: String,
}

async fn load_targets(
    state: &OneMailState,
    account_id: Option<i64>,
) -> OneMailResult<Vec<SyncTarget>> {
    let pool = state.pool().await?;
    let rows = match account_id {
        Some(account_id) => {
            sqlx::query(
                "SELECT account_id, account_label, email FROM accounts WHERE account_id = ?1",
            )
            .bind(account_id)
            .fetch_all(&pool)
            .await
        }
        None => {
            sqlx::query(
                "SELECT account_id, account_label, email FROM accounts
             WHERE sync_enabled = 1 AND status <> 'disabled'
             ORDER BY sort_order, account_id",
            )
            .fetch_all(&pool)
            .await
        }
    }
    .map_err(|error| {
        OneMailError::database(format!("Could not read the accounts to sync: {error}"))
    })?;

    Ok(rows
        .iter()
        .filter_map(|row| {
            let account_id: i64 = row.try_get("account_id").ok()?;
            let label: Option<String> = row.try_get("account_label").unwrap_or_default();
            let email: Option<String> = row.try_get("email").unwrap_or_default();
            let account_label = label
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .or_else(|| email.filter(|value| !value.trim().is_empty()))
                .unwrap_or_else(|| format!("account {account_id}"));
            Some(SyncTarget {
                account_id,
                account_label,
            })
        })
        .collect())
}

/// Raise `one-mail:new-mail` with the freshly inserted INBOX rows, then tell the
/// page the mailbox moved.
async fn publish_new_mail(state: &OneMailState, target: &SyncTarget, message_ids: &[i64]) {
    let summaries = match load_summaries(state, message_ids).await {
        Ok(summaries) => summaries,
        Err(error) => {
            log::warn!(
                "Could not load the new messages of account {}: {}",
                target.account_id,
                error.message
            );
            return;
        }
    };
    if summaries.is_empty() {
        return;
    }
    state.emit(
        EVENT_NEW_MAIL,
        NewMailPayload {
            account_id: target.account_id,
            account_label: target.account_label.clone(),
            messages: summaries,
        },
    );
}

async fn load_summaries(
    state: &OneMailState,
    message_ids: &[i64],
) -> OneMailResult<Vec<MessageSummary>> {
    let pool = state.pool().await?;
    let rows = sqlx::query(
        "SELECT m.message_id, m.account_id, m.folder_id, m.subject, m.from_name, m.from_email,
                m.received_at, m.snippet, m.is_read, m.is_starred, m.has_attachments,
                m.body_status, m.body_error, f.path AS folder_path, f.role AS folder_role
         FROM messages m
         JOIN folders f ON f.folder_id = m.folder_id
         WHERE m.message_id IN (SELECT value FROM json_each(?1))
         ORDER BY m.received_at DESC, m.message_id DESC",
    )
    .bind(message_ids_json(message_ids))
    .fetch_all(&pool)
    .await
    .map_err(|error| OneMailError::database(format!("Could not read the new messages: {error}")))?;

    let addresses = load_summary_addresses(&pool, message_ids).await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let message_id: i64 = row.try_get("message_id").ok()?;
            let (to, cc) = addresses
                .iter()
                .find(|(id, _, _)| *id == message_id)
                .map(|(_, to, cc)| (to.clone(), cc.clone()))
                .unwrap_or_default();
            Some(MessageSummary {
                message_id,
                account_id: row.try_get("account_id").ok()?,
                folder_id: row.try_get("folder_id").ok()?,
                folder_path: row.try_get("folder_path").unwrap_or_default(),
                folder_role: crate::transport::role_from_str(
                    &row.try_get::<String, _>("folder_role").unwrap_or_default(),
                ),
                subject: row.try_get("subject").unwrap_or_default(),
                from_name: row.try_get("from_name").unwrap_or_default(),
                from_email: row.try_get("from_email").unwrap_or_default(),
                to,
                cc,
                received_at: row.try_get("received_at").unwrap_or_default(),
                snippet: row.try_get("snippet").unwrap_or_default(),
                is_read: row.try_get::<i64, _>("is_read").unwrap_or(0) != 0,
                is_starred: row.try_get::<i64, _>("is_starred").unwrap_or(0) != 0,
                has_attachments: row.try_get::<i64, _>("has_attachments").unwrap_or(0) != 0,
                body_status: body_status_of(
                    &row.try_get::<String, _>("body_status").unwrap_or_default(),
                ),
                body_error: row.try_get("body_error").unwrap_or_default(),
            })
        })
        .collect())
}

type SummaryAddresses = (i64, Vec<MailAddress>, Vec<MailAddress>);

async fn load_summary_addresses(
    pool: &SqlitePool,
    message_ids: &[i64],
) -> OneMailResult<Vec<SummaryAddresses>> {
    let rows = sqlx::query(
        "SELECT message_id, kind, name, email FROM message_addresses
         WHERE message_id IN (SELECT value FROM json_each(?1)) AND kind IN ('to', 'cc')
         ORDER BY message_id, kind, sort_order",
    )
    .bind(message_ids_json(message_ids))
    .fetch_all(pool)
    .await
    .map_err(|error| {
        OneMailError::database(format!("Could not read the message participants: {error}"))
    })?;

    let mut grouped: Vec<SummaryAddresses> = Vec::new();
    for row in &rows {
        let Ok(message_id) = row.try_get::<i64, _>("message_id") else {
            continue;
        };
        let kind: String = row.try_get("kind").unwrap_or_default();
        let address = MailAddress {
            name: row.try_get("name").unwrap_or_default(),
            email: row.try_get("email").unwrap_or_default(),
        };
        let entry = match grouped.iter_mut().find(|(id, _, _)| *id == message_id) {
            Some(entry) => entry,
            None => {
                grouped.push((message_id, Vec::new(), Vec::new()));
                grouped.last_mut().expect("the entry was just pushed")
            }
        };
        if kind == "to" {
            entry.1.push(address);
        } else {
            entry.2.push(address);
        }
    }
    Ok(grouped)
}

/// A JSON array of ids for `json_each`, so an `IN` list never needs a query
/// string built from values.
fn message_ids_json(message_ids: &[i64]) -> String {
    serde_json::to_string(message_ids).unwrap_or_else(|_| "[]".to_string())
}

fn body_status_of(value: &str) -> BodyStatus {
    match value.trim().to_ascii_lowercase().as_str() {
        "loading" => BodyStatus::Loading,
        "ready" => BodyStatus::Ready,
        "error" => BodyStatus::Error,
        _ => BodyStatus::None,
    }
}

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

fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::{body_status_of, message_ids_json};
    use crate::models::BodyStatus;

    #[test]
    fn message_ids_become_a_json_array_for_json_each() {
        assert_eq!(message_ids_json(&[7]), "[7]");
        assert_eq!(message_ids_json(&[1, 2, 3]), "[1,2,3]");
        assert_eq!(message_ids_json(&[]), "[]");
    }

    #[test]
    fn an_unknown_body_status_reads_as_none() {
        assert_eq!(body_status_of("ready"), BodyStatus::Ready);
        assert_eq!(body_status_of("loading"), BodyStatus::Loading);
        assert_eq!(body_status_of("error"), BodyStatus::Error);
        assert_eq!(body_status_of("whatever"), BodyStatus::None);
        assert_eq!(body_status_of(""), BodyStatus::None);
    }

    /// The new-mail query filters with `json_each` so an `IN` list never needs a
    /// query string built from values; that only works if the bundled SQLite
    /// carries JSON1.
    #[tokio::test]
    async fn json_each_is_available_in_the_bundled_sqlite() {
        let directory = tempfile::tempdir().expect("temp dir");
        let pool = crate::store::open_at(&directory.path().join("onemail.db"))
            .await
            .expect("open the mail database");
        let ids: Vec<i64> = sqlx::query_scalar("SELECT value FROM json_each(?1)")
            .bind(super::message_ids_json(&[4, 5]))
            .fetch_all(&pool)
            .await
            .expect("json_each must exist");
        assert_eq!(ids, vec![4, 5]);
    }
}
