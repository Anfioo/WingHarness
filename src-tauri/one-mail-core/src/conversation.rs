// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Conversation aggregation: the person-centric list, the thread view and the
//! message lookup used by body loading.
//!
//! A conversation is keyed by the account and the set of non-self participants
//! from the `from` / `sender` / `to` / `cc` headers. Bcc is private envelope
//! metadata: a message whose only other participants are in Bcc does not enter a
//! conversation at all, it only shows up in the outbox. The participant set is
//! sorted in SQL, so two messages with the same correspondents share one key no
//! matter what order the headers listed them in.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use crate::error::{OneMailError, OneMailResult};
use crate::message;
use crate::models::{
    ConversationMessagesQuery, ConversationPage, ConversationParticipant, ConversationQuery,
    ConversationSummary, ConversationThread, MessageSummary, ThreadGroup,
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

/// The most messages one conversation view loads. Older mail stays reachable
/// through search and the folder it belongs to.
const MESSAGE_LIMIT: usize = 500;

/// Raw message rows share this prefix: a conversation key is the account id and
/// the sorted, comma-separated non-self participants, or `self:<message_id>`
/// when the account is the only participant.
const KEYED_CTE: &str = r#"
WITH keyed AS (
    SELECT
        m.message_id,
        m.account_id,
        m.folder_id,
        m.rfc822_message_id,
        m.in_reply_to,
        m.references_header,
        m.subject,
        m.from_name,
        m.from_email,
        m.snippet,
        m.is_read,
        m.is_starred,
        m.has_attachments,
        m.body_status,
        m.body_error,
        COALESCE(NULLIF(TRIM(m.received_at), ''), NULLIF(TRIM(m.sent_at), ''), m.created_at)
            AS effective_at,
        (SELECT GROUP_CONCAT(peer_email, ',' ORDER BY peer_email)
         FROM (
             SELECT DISTINCT a.normalized_email AS peer_email
             FROM message_addresses a
             WHERE a.message_id = m.message_id
               AND a.kind IN ('from', 'sender', 'to', 'cc')
               AND a.normalized_email <> ''
               AND a.normalized_email <> acc.normalized_email
         )) AS peers,
        EXISTS (
            SELECT 1 FROM message_addresses b
            WHERE b.message_id = m.message_id AND b.kind = 'bcc'
        ) AS has_bcc
    FROM messages m
    JOIN accounts acc ON acc.account_id = m.account_id
    JOIN folders f ON f.folder_id = m.folder_id
    WHERE m.is_draft = 0
      AND f.role NOT IN ('trash', 'junk', 'drafts')
)
"#;

/// The keyed rows with the conversation key resolved, minus Bcc-only records.
const COMBINED_CTE: &str = r#"
combined AS (
    SELECT
        CASE
            WHEN keyed.peers IS NULL OR keyed.peers = ''
                THEN keyed.account_id || ':self:' || keyed.message_id
            ELSE keyed.account_id || ':' || keyed.peers
        END AS conversation_key,
        keyed.*
    FROM keyed
    WHERE NOT (COALESCE(keyed.peers, '') = '' AND keyed.has_bcc = 1)
)
"#;

pub async fn list(pool: &SqlitePool, query: ConversationQuery) -> OneMailResult<ConversationPage> {
    let limit = i64::from(query.limit.clamp(1, 200));
    let offset = i64::from(query.offset.min(10_000));
    let keyword = query
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let pattern = keyword.map(like_pattern);
    let received_from = query
        .received_from
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let received_before = query
        .received_before
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let sql = format!(
        r#"
{KEYED_CTE},
{COMBINED_CTE},
agg AS (
    SELECT
        conversation_key,
        account_id,
        COUNT(*) AS message_count,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread_count,
        MAX(has_attachments) AS has_attachments,
        MAX(is_starred) AS is_starred,
        MAX(effective_at) AS last_at
    FROM combined
    GROUP BY conversation_key
),
ranked AS (
    SELECT
        conversation_key,
        message_id,
        ROW_NUMBER() OVER (
            PARTITION BY conversation_key
            ORDER BY effective_at DESC, message_id DESC
        ) AS rn
    FROM combined
)
SELECT
    agg.conversation_key,
    agg.account_id,
    agg.message_count,
    agg.unread_count,
    agg.has_attachments,
    agg.is_starred,
    agg.last_at,
    ranked.message_id AS last_message_id,
    COUNT(*) OVER () AS total
FROM agg
JOIN ranked ON ranked.conversation_key = agg.conversation_key AND ranked.rn = 1
WHERE (?1 IS NULL OR agg.account_id = ?1)
  AND (?2 IS NULL OR EXISTS (
        SELECT 1 FROM combined c
        WHERE c.conversation_key = agg.conversation_key
          AND (
              c.subject LIKE ?2 ESCAPE '\'
              OR COALESCE(c.snippet, '') LIKE ?2 ESCAPE '\'
              OR COALESCE(c.from_name, '') LIKE ?2 ESCAPE '\'
              OR COALESCE(c.from_email, '') LIKE ?2 ESCAPE '\'
              OR EXISTS (
                  SELECT 1 FROM message_addresses a
                  WHERE a.message_id = c.message_id
                    AND (a.email LIKE ?2 ESCAPE '\' OR COALESCE(a.name, '') LIKE ?2 ESCAPE '\')
              )
          )
    ))
  AND (?3 = 0 OR agg.unread_count > 0)
  AND (?4 = 0 OR agg.is_starred = 1)
  AND (?5 IS NULL OR agg.last_at >= ?5)
  AND (?6 IS NULL OR agg.last_at < ?6)
ORDER BY agg.last_at DESC, agg.conversation_key ASC
LIMIT ?7 OFFSET ?8
"#
    );

    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(query.account_id)
        .bind(pattern)
        .bind(i64::from(query.unread_only))
        .bind(i64::from(query.starred_only))
        .bind(received_from)
        .bind(received_before)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not list the conversations: {error}"))
        })?;

    let total: i64 = rows
        .first()
        .and_then(|row| sqlx::Row::try_get::<i64, _>(row, "total").ok())
        .unwrap_or(0);

    let last_ids = rows
        .iter()
        .filter_map(|row| sqlx::Row::try_get::<i64, _>(row, "last_message_id").ok())
        .collect::<Vec<_>>();
    let summaries = message::summaries(pool, &last_ids).await?;
    let keys = rows
        .iter()
        .filter_map(|row| sqlx::Row::try_get::<String, _>(row, "conversation_key").ok())
        .collect::<Vec<_>>();
    let participants = participants_for(pool, &keys).await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let conversation_key: String =
            sqlx::Row::try_get(row, "conversation_key").map_err(row_error)?;
        let account_id: i64 = sqlx::Row::try_get(row, "account_id").map_err(row_error)?;
        let last_message_id: i64 = sqlx::Row::try_get(row, "last_message_id").map_err(row_error)?;
        let Some(last_message) = summaries.get(&last_message_id).cloned() else {
            continue;
        };
        let people = participants
            .get(&conversation_key)
            .cloned()
            .unwrap_or_default();
        let display_name = display_name_of(&people, &last_message);
        items.push(ConversationSummary {
            conversation_key,
            account_id,
            participants: people,
            display_name,
            last_message,
            message_count: to_u32(sqlx::Row::try_get(row, "message_count").map_err(row_error)?),
            unread_count: to_u32(sqlx::Row::try_get(row, "unread_count").map_err(row_error)?),
            has_attachments: sqlx::Row::try_get::<i64, _>(row, "has_attachments")
                .map(|value| value != 0)
                .unwrap_or(false),
            is_starred: sqlx::Row::try_get::<i64, _>(row, "is_starred")
                .map(|value| value != 0)
                .unwrap_or(false),
        });
    }

    let page_len = items.len() as i64;
    Ok(ConversationPage {
        items,
        total: to_u32(total),
        has_more: offset + page_len < total,
    })
}

pub async fn messages(
    pool: &SqlitePool,
    query: ConversationMessagesQuery,
) -> OneMailResult<ConversationThread> {
    let sql = format!(
        r#"
{KEYED_CTE}
SELECT
    message_id,
    rfc822_message_id,
    in_reply_to,
    references_header,
    subject,
    effective_at
FROM keyed
WHERE account_id = ?1
  AND (CASE
           WHEN peers IS NULL OR peers = ''
               THEN account_id || ':self:' || message_id
           ELSE account_id || ':' || peers
       END) = ?2
ORDER BY effective_at DESC, message_id DESC
LIMIT ?3
"#
    );

    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(query.account_id)
        .bind(&query.conversation_key)
        .bind(i64::try_from(MESSAGE_LIMIT + 1).unwrap_or(501))
        .fetch_all(pool)
        .await
        .map_err(|error| {
            OneMailError::database(format!("Could not read the conversation messages: {error}"))
        })?;

    let mut thread_rows = rows
        .iter()
        .map(|row| {
            Ok(ThreadRow {
                message_id: sqlx::Row::try_get(row, "message_id").map_err(row_error)?,
                rfc822_message_id: message::optional_string(row, "rfc822_message_id"),
                in_reply_to: message::optional_string(row, "in_reply_to"),
                references_header: message::optional_string(row, "references_header"),
                subject: message::optional_string(row, "subject"),
                effective_at: sqlx::Row::try_get(row, "effective_at").map_err(row_error)?,
            })
        })
        .collect::<OneMailResult<Vec<_>>>()?;

    let truncated = thread_rows.len() > MESSAGE_LIMIT;
    if truncated {
        thread_rows.truncate(MESSAGE_LIMIT);
        log::warn!(
            "one_mail_conversation_truncated account={} conversation={} limit={MESSAGE_LIMIT}",
            query.account_id,
            query.conversation_key
        );
    }
    // The query hands back the newest first; grouping and every response walk
    // the thread from the oldest message.
    thread_rows.reverse();

    let ids = thread_rows
        .iter()
        .map(|row| row.message_id)
        .collect::<Vec<_>>();
    let summaries = message::summaries(pool, &ids).await?;
    let groups = group_threads(&thread_rows, &summaries);
    let participants = participants_for(pool, std::slice::from_ref(&query.conversation_key))
        .await?
        .remove(&query.conversation_key)
        .unwrap_or_default();

    Ok(ConversationThread {
        conversation_key: query.conversation_key,
        account_id: query.account_id,
        participants,
        groups,
        truncated,
    })
}

pub async fn find_message(
    pool: &SqlitePool,
    message_id: i64,
) -> OneMailResult<Option<MessageLocation>> {
    let row = sqlx::query(
        "SELECT m.message_id, m.account_id, m.folder_id, f.path, m.uid
         FROM messages m
         JOIN folders f ON f.folder_id = m.folder_id
         WHERE m.message_id = ?1",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| OneMailError::database(format!("Could not locate the message: {error}")))?;

    let Some(row) = row else {
        return Ok(None);
    };
    let uid: i64 = sqlx::Row::try_get(&row, "uid").map_err(row_error)?;
    let Ok(uid) = u32::try_from(uid) else {
        return Ok(None);
    };
    Ok(Some(MessageLocation {
        message_id: sqlx::Row::try_get(&row, "message_id").map_err(row_error)?,
        account_id: sqlx::Row::try_get(&row, "account_id").map_err(row_error)?,
        folder_id: sqlx::Row::try_get(&row, "folder_id").map_err(row_error)?,
        folder_path: sqlx::Row::try_get(&row, "path").map_err(row_error)?,
        uid,
    }))
}

// ---------------------------------------------------------------------------
// Participants and display names
// ---------------------------------------------------------------------------

/// Load the public participants of each conversation, keyed by conversation
/// key. One person appears once per conversation even when several messages
/// carry them.
async fn participants_for(
    pool: &SqlitePool,
    keys: &[String],
) -> OneMailResult<HashMap<String, Vec<ConversationParticipant>>> {
    let mut result: HashMap<String, Vec<ConversationParticipant>> = HashMap::new();
    if keys.is_empty() {
        return Ok(result);
    }

    let mut builder = QueryBuilder::<Sqlite>::new(KEYED_CTE);
    builder.push(", ");
    builder.push(COMBINED_CTE);
    builder.push(
        " SELECT c.conversation_key, a.name, a.email
          FROM combined c
          JOIN message_addresses a ON a.message_id = c.message_id
          JOIN accounts acc ON acc.account_id = c.account_id
          WHERE a.kind IN ('from', 'sender', 'to', 'cc')
            AND a.normalized_email <> ''
            AND a.normalized_email <> acc.normalized_email
            AND c.conversation_key IN (",
    );
    let mut separated = builder.separated(", ");
    for key in keys {
        separated.push_bind(key.clone());
    }
    separated.push_unseparated(
        ") ORDER BY c.conversation_key, a.normalized_email, a.sort_order, a.address_id",
    );

    let rows = builder.build().fetch_all(pool).await.map_err(|error| {
        OneMailError::database(format!(
            "Could not read the conversation participants: {error}"
        ))
    })?;

    for row in &rows {
        let key: String = sqlx::Row::try_get(row, "conversation_key").map_err(row_error)?;
        let name: Option<String> = message::optional_string(row, "name");
        let email: String = sqlx::Row::try_get(row, "email").map_err(row_error)?;
        let entry = result.entry(key).or_default();
        // A later duplicate may carry the display name the first copy lacked.
        if let Some(existing) = entry
            .iter_mut()
            .find(|person| person.email.eq_ignore_ascii_case(&email))
        {
            if existing.name.is_none() && name.is_some() {
                existing.name = name;
            }
            continue;
        }
        entry.push(ConversationParticipant { name, email });
    }
    Ok(result)
}

fn display_name_of(participants: &[ConversationParticipant], last: &MessageSummary) -> String {
    if !participants.is_empty() {
        return participants
            .iter()
            .map(|person| {
                person
                    .name
                    .as_deref()
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .unwrap_or(&person.email)
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join(", ");
    }
    last.subject
        .as_deref()
        .map(str::trim)
        .filter(|subject| !subject.is_empty())
        .unwrap_or_default()
        .to_string()
}

// ---------------------------------------------------------------------------
// Thread grouping
// ---------------------------------------------------------------------------

struct ThreadRow {
    message_id: i64,
    rfc822_message_id: Option<String>,
    in_reply_to: Option<String>,
    references_header: Option<String>,
    subject: Option<String>,
    effective_at: String,
}

/// Union the messages that reference each other, fall back to the normalized
/// subject for the ones with no references at all, and emit the groups oldest
/// first.
fn group_threads(rows: &[ThreadRow], summaries: &HashMap<i64, MessageSummary>) -> Vec<ThreadGroup> {
    let mut set = DisjointSet::new(rows.len());
    let references = rows
        .iter()
        .map(|row| {
            let mut tokens = Vec::new();
            for value in [row.in_reply_to.as_deref(), row.references_header.as_deref()] {
                if let Some(value) = value {
                    tokens.extend(value.split_whitespace().filter_map(normalize_reference));
                }
            }
            tokens
        })
        .collect::<Vec<_>>();

    let mut by_message_id: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        if let Some(id) = row
            .rfc822_message_id
            .as_deref()
            .and_then(normalize_reference)
        {
            by_message_id.entry(id).or_default().push(index);
        }
    }
    for (index, tokens) in references.iter().enumerate() {
        for token in tokens {
            if let Some(targets) = by_message_id.get(token) {
                for &target in targets {
                    if target != index {
                        set.union(index, target);
                    }
                }
            }
        }
    }

    // A message with no references at all joins the other unreferenced
    // messages that share its normalized subject.
    let mut by_subject: HashMap<String, usize> = HashMap::new();
    for index in 0..rows.len() {
        if !references[index].is_empty() {
            continue;
        }
        let subject = normalize_subject(rows[index].subject.as_deref().unwrap_or_default());
        let bucket = if subject.is_empty() {
            format!("message:{}", rows[index].message_id)
        } else {
            subject
        };
        match by_subject.get(&bucket) {
            Some(&first) => set.union(first, index),
            None => {
                by_subject.insert(bucket, index);
            }
        }
    }

    let mut components: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for index in 0..rows.len() {
        components.entry(set.find(index)).or_default().push(index);
    }

    let mut groups = components
        .into_values()
        .map(|indices| {
            // `indices` is ascending, and the rows are oldest first, so the
            // first entry is the earliest message of the component.
            let earliest = &rows[indices[0]];
            let thread_key = earliest
                .rfc822_message_id
                .as_deref()
                .and_then(normalize_reference)
                .or_else(|| {
                    let subject =
                        normalize_subject(earliest.subject.as_deref().unwrap_or_default());
                    (!subject.is_empty()).then_some(subject)
                })
                .unwrap_or_else(|| format!("message:{}", earliest.message_id));
            let messages = indices
                .iter()
                .filter_map(|&index| summaries.get(&rows[index].message_id).cloned())
                .collect::<Vec<_>>();
            (
                earliest.effective_at.clone(),
                ThreadGroup {
                    thread_key,
                    subject: earliest.subject.clone(),
                    messages,
                },
            )
        })
        .collect::<Vec<_>>();
    groups.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.thread_key.cmp(&right.1.thread_key))
    });
    groups.into_iter().map(|(_, group)| group).collect()
}

struct DisjointSet {
    parent: Vec<usize>,
}

impl DisjointSet {
    fn new(size: usize) -> Self {
        Self {
            parent: (0..size).collect(),
        }
    }

    fn find(&mut self, index: usize) -> usize {
        let mut root = index;
        while self.parent[root] != root {
            root = self.parent[root];
        }
        let mut current = index;
        while self.parent[current] != current {
            let next = self.parent[current];
            self.parent[current] = root;
            current = next;
        }
        root
    }

    fn union(&mut self, left: usize, right: usize) {
        let left_root = self.find(left);
        let right_root = self.find(right);
        if left_root != right_root {
            self.parent[right_root] = left_root;
        }
    }
}

fn normalize_reference(value: &str) -> Option<String> {
    let trimmed = value
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Strip the reply / forward prefixes and collapse whitespace, so
/// `"RE:  Quarterly   report"` and `"Quarterly report"` group together.
fn normalize_subject(subject: &str) -> String {
    let mut value = subject.trim();
    loop {
        let trimmed = value.trim_start();
        let lower = trimmed.to_lowercase();
        let Some(prefix) = SUBJECT_PREFIXES
            .iter()
            .find(|prefix| lower.starts_with(&prefix.to_lowercase()))
        else {
            value = trimmed;
            break;
        };
        value = &trimmed[prefix.len()..];
    }
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

const SUBJECT_PREFIXES: &[&str] = &[
    "re:",
    "re :",
    "fwd:",
    "fw:",
    "回复:",
    "回复：",
    "答复:",
    "答复：",
    "转发:",
    "转发：",
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn like_pattern(keyword: &str) -> String {
    let escaped = keyword
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn to_u32(value: i64) -> u32 {
    u32::try_from(value.max(0)).unwrap_or(u32::MAX)
}

fn row_error(error: sqlx::Error) -> OneMailError {
    OneMailError::database(format!("Could not read a conversation row: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::message::test_support::{
        insert_account, insert_address, insert_folder, insert_message, open_pool, MessageSeed,
    };

    async fn seed_two_accounts() -> (tempfile::TempDir, SqlitePool) {
        let (directory, pool) = open_pool().await;
        insert_account(&pool, 1, "me@example.test").await;
        insert_account(&pool, 2, "other@example.test").await;
        insert_folder(&pool, 1, 1, "INBOX", "inbox").await;
        insert_folder(&pool, 2, 1, "Sent", "sent").await;
        insert_folder(&pool, 3, 2, "INBOX", "inbox").await;
        (directory, pool)
    }

    #[tokio::test]
    async fn own_address_is_excluded_and_sent_mail_joins_the_same_conversation() {
        let (_directory, pool) = seed_two_accounts().await;
        insert_message(
            &pool,
            MessageSeed::new(1, 1, 1, 10)
                .from(Some("Alice"), "alice@example.test")
                .subject("Hello")
                .received_at("2026-01-01T10:00:00Z"),
        )
        .await;
        insert_address(&pool, 1, "to", None, "me@example.test").await;
        insert_message(
            &pool,
            MessageSeed::new(2, 1, 2, 20)
                .from(Some("Me"), "me@example.test")
                .subject("Re: Hello")
                .received_at("2026-01-02T10:00:00Z"),
        )
        .await;
        insert_address(&pool, 2, "to", Some("Alice"), "alice@example.test").await;

        let page = list(
            &pool,
            ConversationQuery {
                account_id: None,
                keyword: None,
                unread_only: false,
                starred_only: false,
                received_from: None,
                received_before: None,
                limit: 50,
                offset: 0,
            },
        )
        .await
        .unwrap();

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].conversation_key, "1:alice@example.test");
        assert_eq!(page.items[0].message_count, 2);
        assert_eq!(page.items[0].participants.len(), 1);
        assert_eq!(page.items[0].participants[0].email, "alice@example.test");
        assert_eq!(page.items[0].last_message.message_id, 2);
        assert_eq!(page.items[0].display_name, "Alice");
    }

    #[tokio::test]
    async fn public_participants_are_sorted_so_header_order_does_not_split_a_group() {
        let (_directory, pool) = seed_two_accounts().await;
        insert_message(
            &pool,
            MessageSeed::new(1, 1, 1, 10)
                .from(Some("Zoe"), "zoe@example.test")
                .subject("Team")
                .received_at("2026-01-01T10:00:00Z"),
        )
        .await;
        insert_address(&pool, 1, "to", Some("Amy"), "amy@example.test").await;
        insert_address(&pool, 1, "cc", Some("Bob"), "bob@example.test").await;
        insert_message(
            &pool,
            MessageSeed::new(2, 1, 1, 11)
                .from(Some("Amy"), "amy@example.test")
                .subject("Re: Team")
                .received_at("2026-01-02T10:00:00Z"),
        )
        .await;
        insert_address(&pool, 2, "to", Some("Zoe"), "zoe@example.test").await;
        insert_address(&pool, 2, "cc", Some("Bob"), "bob@example.test").await;

        let page = list(
            &pool,
            ConversationQuery {
                account_id: None,
                keyword: None,
                unread_only: false,
                starred_only: false,
                received_from: None,
                received_before: None,
                limit: 50,
                offset: 0,
            },
        )
        .await
        .unwrap();

        assert_eq!(page.items.len(), 1);
        assert_eq!(
            page.items[0].conversation_key,
            "1:amy@example.test,bob@example.test,zoe@example.test"
        );
        assert_eq!(page.items[0].message_count, 2);
    }

    #[tokio::test]
    async fn bcc_only_records_never_enter_a_conversation() {
        let (_directory, pool) = seed_two_accounts().await;
        insert_message(
            &pool,
            MessageSeed::new(1, 1, 2, 20)
                .from(Some("Me"), "me@example.test")
                .subject("Secret")
                .received_at("2026-01-01T10:00:00Z"),
        )
        .await;
        insert_address(&pool, 1, "bcc", Some("Hidden"), "hidden@example.test").await;

        let page = list(
            &pool,
            ConversationQuery {
                account_id: None,
                keyword: None,
                unread_only: false,
                starred_only: false,
                received_from: None,
                received_before: None,
                limit: 50,
                offset: 0,
            },
        )
        .await
        .unwrap();

        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);
    }

    #[tokio::test]
    async fn the_same_correspondent_in_two_accounts_stays_two_conversations() {
        let (_directory, pool) = seed_two_accounts().await;
        insert_message(
            &pool,
            MessageSeed::new(1, 1, 1, 10)
                .from(Some("Alice"), "alice@example.test")
                .subject("First")
                .received_at("2026-01-01T10:00:00Z"),
        )
        .await;
        insert_message(
            &pool,
            MessageSeed::new(2, 2, 3, 11)
                .from(Some("Alice"), "alice@example.test")
                .subject("Second")
                .received_at("2026-01-02T10:00:00Z"),
        )
        .await;

        let page = list(
            &pool,
            ConversationQuery {
                account_id: None,
                keyword: None,
                unread_only: false,
                starred_only: false,
                received_from: None,
                received_before: None,
                limit: 50,
                offset: 0,
            },
        )
        .await
        .unwrap();

        assert_eq!(page.total, 2);
        let keys = page
            .items
            .iter()
            .map(|item| item.conversation_key.as_str())
            .collect::<Vec<_>>();
        assert!(keys.contains(&"1:alice@example.test"));
        assert!(keys.contains(&"2:alice@example.test"));
    }

    #[test]
    fn subject_normalization_strips_every_reply_prefix_and_case() {
        assert_eq!(
            normalize_subject("RE: Quarterly   Report "),
            "quarterly report"
        );
        assert_eq!(normalize_subject("Re: Fwd: report"), "report");
        assert_eq!(normalize_subject("回复： 报告"), "报告");
        assert_eq!(normalize_subject("转发:  报告"), "报告");
        assert_eq!(normalize_subject("  plain  "), "plain");
    }

    #[tokio::test]
    async fn references_group_a_thread_and_missing_references_fall_back_to_subject() {
        let (_directory, pool) = seed_two_accounts().await;
        insert_message(
            &pool,
            MessageSeed::new(1, 1, 1, 10)
                .from(Some("Alice"), "alice@example.test")
                .subject("Plan")
                .rfc822("<root@example.test>")
                .received_at("2026-01-01T10:00:00Z"),
        )
        .await;
        insert_message(
            &pool,
            MessageSeed::new(2, 1, 1, 11)
                .from(Some("Me"), "me@example.test")
                .subject("Re: Plan")
                .rfc822("<reply@example.test>")
                .in_reply_to("<root@example.test>")
                .received_at("2026-01-02T10:00:00Z"),
        )
        .await;
        insert_address(&pool, 2, "to", Some("Alice"), "alice@example.test").await;
        insert_message(
            &pool,
            MessageSeed::new(3, 1, 1, 12)
                .from(Some("Alice"), "alice@example.test")
                .subject("Re: Plan")
                .rfc822("<second@example.test>")
                .references("<root@example.test> <reply@example.test>")
                .received_at("2026-01-03T10:00:00Z"),
        )
        .await;
        insert_message(
            &pool,
            MessageSeed::new(4, 1, 1, 13)
                .from(Some("Alice"), "alice@example.test")
                .subject("Invoice")
                .received_at("2026-01-04T10:00:00Z"),
        )
        .await;
        insert_message(
            &pool,
            MessageSeed::new(5, 1, 1, 14)
                .from(Some("Alice"), "alice@example.test")
                .subject("Re: Invoice")
                .received_at("2026-01-05T10:00:00Z"),
        )
        .await;

        let thread = messages(
            &pool,
            ConversationMessagesQuery {
                account_id: 1,
                conversation_key: "1:alice@example.test".to_string(),
            },
        )
        .await
        .unwrap();

        assert_eq!(thread.groups.len(), 2);
        let referenced = &thread.groups[0];
        assert_eq!(referenced.thread_key, "root@example.test");
        assert_eq!(referenced.subject.as_deref(), Some("Plan"));
        assert_eq!(
            referenced
                .messages
                .iter()
                .map(|message| message.message_id)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        let subject_group = &thread.groups[1];
        assert_eq!(subject_group.thread_key, "invoice");
        assert_eq!(
            subject_group
                .messages
                .iter()
                .map(|message| message.message_id)
                .collect::<Vec<_>>(),
            vec![4, 5]
        );
    }

    #[tokio::test]
    async fn list_filters_unread_starred_keyword_and_pages_with_a_total() {
        let (_directory, pool) = seed_two_accounts().await;
        insert_message(
            &pool,
            MessageSeed::new(1, 1, 1, 10)
                .from(Some("Alice"), "alice@example.test")
                .subject("Invoice")
                .received_at("2026-01-01T10:00:00Z")
                .read(true),
        )
        .await;
        insert_message(
            &pool,
            MessageSeed::new(2, 1, 1, 11)
                .from(Some("Bob"), "bob@example.test")
                .subject("Lunch")
                .received_at("2026-01-02T10:00:00Z")
                .unread()
                .starred(),
        )
        .await;
        insert_message(
            &pool,
            MessageSeed::new(3, 2, 3, 12)
                .from(Some("Carol"), "carol@example.test")
                .subject("Invoice copy")
                .received_at("2026-01-03T10:00:00Z")
                .read(true),
        )
        .await;

        let all = list(&pool, query(50, 0)).await.unwrap();
        assert_eq!(all.total, 3);
        assert_eq!(all.items.len(), 3);
        assert!(!all.has_more);

        let paged = list(&pool, query(2, 0)).await.unwrap();
        assert_eq!(paged.items.len(), 2);
        assert!(paged.has_more);
        let second = list(&pool, query(2, 2)).await.unwrap();
        assert_eq!(second.items.len(), 1);
        assert!(!second.has_more);

        let unread = list(
            &pool,
            ConversationQuery {
                unread_only: true,
                ..query(50, 0)
            },
        )
        .await
        .unwrap();
        assert_eq!(unread.total, 1);
        assert_eq!(unread.items[0].conversation_key, "1:bob@example.test");

        let starred = list(
            &pool,
            ConversationQuery {
                starred_only: true,
                ..query(50, 0)
            },
        )
        .await
        .unwrap();
        assert_eq!(starred.total, 1);

        let keyword = list(
            &pool,
            ConversationQuery {
                keyword: Some("invoice".to_string()),
                ..query(50, 0)
            },
        )
        .await
        .unwrap();
        assert_eq!(keyword.total, 2);

        let by_account = list(
            &pool,
            ConversationQuery {
                account_id: Some(2),
                ..query(50, 0)
            },
        )
        .await
        .unwrap();
        assert_eq!(by_account.total, 1);
        assert_eq!(by_account.items[0].conversation_key, "2:carol@example.test");
    }

    #[tokio::test]
    async fn find_message_returns_the_server_location() {
        let (_directory, pool) = seed_two_accounts().await;
        insert_message(
            &pool,
            MessageSeed::new(7, 1, 1, 42)
                .from(Some("Alice"), "alice@example.test")
                .subject("Where"),
        )
        .await;

        let location = find_message(&pool, 7).await.unwrap().unwrap();
        assert_eq!(location.account_id, 1);
        assert_eq!(location.folder_id, 1);
        assert_eq!(location.folder_path, "INBOX");
        assert_eq!(location.uid, 42);
        assert!(find_message(&pool, 99).await.unwrap().is_none());
    }

    fn query(limit: u32, offset: u32) -> ConversationQuery {
        ConversationQuery {
            account_id: None,
            keyword: None,
            unread_only: false,
            starred_only: false,
            received_from: None,
            received_before: None,
            limit,
            offset,
        }
    }
}
