// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! FTS5 search with the short-query LIKE fallback and the local filters.
//!
//! The trigram tokenizer makes a 3-character substring search work for Chinese
//! as well as English. Anything shorter cannot be represented as a trigram, so
//! the query falls back to `LIKE` over the subject, the participants and the
//! snippet. Neither path ever returns the body itself — only an excerpt around
//! the hit.

use std::collections::HashMap;

use sqlx::{QueryBuilder, Sqlite, SqlitePool};

use crate::error::{OneMailError, OneMailResult};
use crate::message;
use crate::models::{MessageSearchPage, SearchHit, SearchQuery};

/// Everything around the hit that the excerpt keeps on each side.
const EXCERPT_CHARS: usize = 60;

pub async fn search(pool: &SqlitePool, query: SearchQuery) -> OneMailResult<MessageSearchPage> {
    let keyword = query.keyword.trim();
    if keyword.is_empty() {
        return Ok(MessageSearchPage {
            items: Vec::new(),
            total: 0,
            has_more: false,
        });
    }

    let limit = i64::from(query.limit.clamp(1, 200));
    let offset = i64::from(query.offset.min(10_000));
    let (message_ids, total) = if keyword.chars().count() >= 3 {
        fts_matches(pool, keyword, &query, limit, offset).await?
    } else {
        like_matches(pool, keyword, &query, limit, offset).await?
    };

    let summaries = message::summaries(pool, &message_ids).await?;
    let bodies = bodies_for(pool, &message_ids).await?;
    let mut items = Vec::with_capacity(message_ids.len());
    for message_id in &message_ids {
        let Some(summary) = summaries.get(message_id).cloned() else {
            continue;
        };
        let body = bodies.get(message_id).map(String::as_str);
        let (matched_in, excerpt) = locate(keyword, &summary, body);
        items.push(SearchHit {
            message: summary,
            matched_in,
            excerpt,
        });
    }

    let page_len = items.len() as i64;
    Ok(MessageSearchPage {
        items,
        total: u32::try_from(total.max(0)).unwrap_or(u32::MAX),
        has_more: offset + page_len < total,
    })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async fn fts_matches(
    pool: &SqlitePool,
    keyword: &str,
    query: &SearchQuery,
    limit: i64,
    offset: i64,
) -> OneMailResult<(Vec<i64>, i64)> {
    // A quoted phrase keeps FTS5 operators out of the user's text; doubling an
    // embedded quote is the FTS5 escape.
    let match_expression = format!("\"{}\"", keyword.replace('"', "\"\""));
    let sql = r#"
SELECT m.message_id, COUNT(*) OVER () AS total
FROM message_search
JOIN messages m ON m.message_id = message_search.message_id
JOIN folders f ON f.folder_id = m.folder_id
WHERE message_search MATCH ?1
  AND (?2 IS NULL OR m.account_id = ?2)
  AND (?3 = 0 OR m.is_read = 0)
  AND (?4 = 0 OR m.is_starred = 1)
  AND (?5 IS NULL OR COALESCE(NULLIF(TRIM(m.received_at), ''), NULLIF(TRIM(m.sent_at), ''),
                              m.created_at) >= ?5)
  AND (?6 IS NULL OR COALESCE(NULLIF(TRIM(m.received_at), ''), NULLIF(TRIM(m.sent_at), ''),
                              m.created_at) < ?6)
ORDER BY COALESCE(NULLIF(TRIM(m.received_at), ''), NULLIF(TRIM(m.sent_at), ''), m.created_at) DESC,
         m.message_id DESC
LIMIT ?7 OFFSET ?8
"#;
    run_search_query(pool, sql, match_expression, query, limit, offset).await
}

async fn like_matches(
    pool: &SqlitePool,
    keyword: &str,
    query: &SearchQuery,
    limit: i64,
    offset: i64,
) -> OneMailResult<(Vec<i64>, i64)> {
    let pattern = like_pattern(keyword);
    let sql = r#"
SELECT m.message_id, COUNT(*) OVER () AS total
FROM messages m
JOIN folders f ON f.folder_id = m.folder_id
WHERE (m.subject LIKE ?1 ESCAPE '\'
       OR COALESCE(m.snippet, '') LIKE ?1 ESCAPE '\'
       OR COALESCE(m.from_name, '') LIKE ?1 ESCAPE '\'
       OR COALESCE(m.from_email, '') LIKE ?1 ESCAPE '\'
       OR EXISTS (
           SELECT 1 FROM message_addresses a
           WHERE a.message_id = m.message_id
             AND (a.email LIKE ?1 ESCAPE '\' OR COALESCE(a.name, '') LIKE ?1 ESCAPE '\')
       ))
  AND (?2 IS NULL OR m.account_id = ?2)
  AND (?3 = 0 OR m.is_read = 0)
  AND (?4 = 0 OR m.is_starred = 1)
  AND (?5 IS NULL OR COALESCE(NULLIF(TRIM(m.received_at), ''), NULLIF(TRIM(m.sent_at), ''),
                              m.created_at) >= ?5)
  AND (?6 IS NULL OR COALESCE(NULLIF(TRIM(m.received_at), ''), NULLIF(TRIM(m.sent_at), ''),
                              m.created_at) < ?6)
ORDER BY COALESCE(NULLIF(TRIM(m.received_at), ''), NULLIF(TRIM(m.sent_at), ''), m.created_at) DESC,
         m.message_id DESC
LIMIT ?7 OFFSET ?8
"#;
    run_search_query(pool, sql, pattern, query, limit, offset).await
}

async fn run_search_query(
    pool: &SqlitePool,
    sql: &str,
    keyword_bind: String,
    query: &SearchQuery,
    limit: i64,
    offset: i64,
) -> OneMailResult<(Vec<i64>, i64)> {
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
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()))
        .bind(keyword_bind)
        .bind(query.account_id)
        .bind(i64::from(query.unread_only))
        .bind(i64::from(query.starred_only))
        .bind(received_from)
        .bind(received_before)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await
        .map_err(|error| OneMailError::database(format!("Could not search the mail: {error}")))?;

    let total = rows
        .first()
        .and_then(|row| sqlx::Row::try_get::<i64, _>(row, "total").ok())
        .unwrap_or(0);
    let ids = rows
        .iter()
        .filter_map(|row| sqlx::Row::try_get::<i64, _>(row, "message_id").ok())
        .collect();
    Ok((ids, total))
}

async fn bodies_for(pool: &SqlitePool, message_ids: &[i64]) -> OneMailResult<HashMap<i64, String>> {
    let mut result = HashMap::new();
    if message_ids.is_empty() {
        return Ok(result);
    }
    let mut builder = QueryBuilder::<Sqlite>::new(
        "SELECT message_id, body_text FROM message_bodies WHERE body_text IS NOT NULL
         AND message_id IN (",
    );
    let mut separated = builder.separated(", ");
    for message_id in message_ids {
        separated.push_bind(*message_id);
    }
    separated.push_unseparated(")");
    let rows = builder.build().fetch_all(pool).await.map_err(|error| {
        OneMailError::database(format!("Could not read the search excerpts: {error}"))
    })?;
    for row in &rows {
        if let (Ok(message_id), Ok(Some(body))) = (
            sqlx::Row::try_get::<i64, _>(row, "message_id"),
            sqlx::Row::try_get::<Option<String>, _>(row, "body_text"),
        ) {
            result.insert(message_id, body);
        }
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Match description
// ---------------------------------------------------------------------------

/// Say which field matched and excerpt it. The order is the one the UI uses to
/// label a hit: subject, sender, body, snippet.
fn locate(
    keyword: &str,
    summary: &crate::models::MessageSummary,
    body: Option<&str>,
) -> (String, Option<String>) {
    if let Some(subject) = summary.subject.as_deref() {
        if contains(subject, keyword) {
            return ("subject".to_string(), excerpt(subject, keyword));
        }
    }
    if let Some(found) = summary
        .from_name
        .as_deref()
        .filter(|value| contains(value, keyword))
        .or_else(|| {
            summary
                .from_email
                .as_deref()
                .filter(|value| contains(value, keyword))
        })
    {
        return ("from".to_string(), excerpt(found, keyword));
    }
    if let Some(body) = body.filter(|value| contains(value, keyword)) {
        return ("body".to_string(), excerpt_body(body, keyword));
    }
    if let Some(snippet) = summary
        .snippet
        .as_deref()
        .filter(|value| contains(value, keyword))
    {
        return ("snippet".to_string(), excerpt_body(snippet, keyword));
    }
    // The FTS phrase can match across a token boundary the substring check
    // cannot see; describe the hit with whatever text is available.
    let (field, value) = match (body, summary.snippet.as_deref(), summary.subject.as_deref()) {
        (Some(body), _, _) => ("body", body),
        (_, Some(snippet), _) => ("snippet", snippet),
        (_, _, Some(subject)) => ("subject", subject),
        _ => ("snippet", ""),
    };
    if value.is_empty() {
        return (field.to_string(), None);
    }
    (field.to_string(), excerpt_body(value, keyword))
}

fn like_pattern(keyword: &str) -> String {
    let escaped = keyword
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn contains(haystack: &str, needle: &str) -> bool {
    find_char_position(haystack, needle).is_some()
}

/// Case-folded substring search over chars, so the excerpt boundary is never a
/// byte offset inside a multi-byte character.
fn find_char_position(haystack: &str, needle: &str) -> Option<usize> {
    let haystack = haystack.chars().collect::<Vec<_>>();
    let needle = needle.chars().collect::<Vec<_>>();
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| {
        window
            .iter()
            .zip(&needle)
            .all(|(left, right)| chars_equal(*left, *right))
    })
}

fn chars_equal(left: char, right: char) -> bool {
    left == right || left.to_lowercase().eq(right.to_lowercase())
}

fn excerpt(value: &str, keyword: &str) -> Option<String> {
    let chars = value.chars().collect::<Vec<_>>();
    let position = find_char_position(value, keyword)?;
    let keyword_len = keyword.chars().count();
    let start = position.saturating_sub(EXCERPT_CHARS);
    let end = (position + keyword_len + EXCERPT_CHARS).min(chars.len());
    let mut output = String::new();
    if start > 0 {
        output.push('…');
    }
    output.extend(chars[start..end].iter());
    if end < chars.len() {
        output.push('…');
    }
    Some(output)
}

/// The same excerpt, but first collapse the body's whitespace so a hit that
/// spans a line break still reads as one sentence.
fn excerpt_body(value: &str, keyword: &str) -> Option<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    excerpt(&collapsed, keyword)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::message::test_support::{
        insert_account, insert_body, insert_folder, insert_message, insert_search, open_pool,
        MessageSeed,
    };

    async fn seed() -> (tempfile::TempDir, SqlitePool) {
        let (directory, pool) = open_pool().await;
        insert_account(&pool, 1, "me@example.test").await;
        insert_account(&pool, 2, "other@example.test").await;
        insert_folder(&pool, 1, 1, "INBOX", "inbox").await;
        insert_folder(&pool, 2, 2, "INBOX", "inbox").await;

        insert_message(
            &pool,
            MessageSeed::new(1, 1, 1, 10)
                .from(Some("Alice"), "alice@example.test")
                .subject("Quarterly report")
                .snippet("Numbers are attached")
                .received_at("2026-01-01T10:00:00Z")
                .read(true),
        )
        .await;
        insert_body(
            &pool,
            1,
            Some("The numbers look fine for the quarter."),
            None,
        )
        .await;
        insert_search(
            &pool,
            1,
            1,
            1,
            Some("Quarterly report"),
            Some("Alice"),
            Some("alice@example.test"),
            Some("Numbers are attached"),
            Some("The numbers look fine for the quarter."),
        )
        .await;

        insert_message(
            &pool,
            MessageSeed::new(2, 1, 1, 11)
                .from(Some("Bob"), "bob@example.test")
                .subject("Lunch")
                .snippet("Pizza today")
                .received_at("2026-01-02T10:00:00Z")
                .starred(),
        )
        .await;
        insert_search(
            &pool,
            2,
            1,
            1,
            Some("Lunch"),
            Some("Bob"),
            Some("bob@example.test"),
            Some("Pizza today"),
            Some("Pizza today at noon."),
        )
        .await;

        insert_message(
            &pool,
            MessageSeed::new(3, 2, 2, 12)
                .from(Some("Carol"), "carol@example.test")
                .subject("Quarterly report copy")
                .received_at("2026-01-03T10:00:00Z"),
        )
        .await;
        insert_search(
            &pool,
            3,
            2,
            2,
            Some("Quarterly report copy"),
            Some("Carol"),
            Some("carol@example.test"),
            None,
            None,
        )
        .await;

        (directory, pool)
    }

    fn query(keyword: &str) -> SearchQuery {
        SearchQuery {
            account_id: None,
            keyword: keyword.to_string(),
            unread_only: false,
            starred_only: false,
            received_from: None,
            received_before: None,
            limit: 50,
            offset: 0,
        }
    }

    #[tokio::test]
    async fn fts_finds_subject_sender_and_body_and_says_which_matched() {
        let (_directory, pool) = seed().await;

        let subject = search(&pool, query("Quarterly")).await.unwrap();
        assert_eq!(subject.total, 2);
        assert_eq!(subject.items[0].message.message_id, 3);
        assert!(subject
            .items
            .iter()
            .all(|hit| hit.matched_in == "subject" || hit.matched_in == "body"));

        let sender = search(&pool, query("alice@example")).await.unwrap();
        assert_eq!(sender.total, 1);
        assert_eq!(sender.items[0].matched_in, "from");
        assert_eq!(
            sender.items[0].excerpt.as_deref(),
            Some("alice@example.test")
        );

        let body = search(&pool, query("numbers look")).await.unwrap();
        assert_eq!(body.total, 1);
        assert_eq!(body.items[0].matched_in, "body");
        assert!(body.items[0]
            .excerpt
            .as_deref()
            .unwrap()
            .contains("numbers look"));
    }

    #[tokio::test]
    async fn short_queries_fall_back_to_like() {
        let (_directory, pool) = seed().await;

        let hit = search(&pool, query("Bo")).await.unwrap();
        assert_eq!(hit.total, 1);
        assert_eq!(hit.items[0].message.message_id, 2);
        assert_eq!(hit.items[0].matched_in, "from");

        let snippet = search(&pool, query("Pi")).await.unwrap();
        assert_eq!(snippet.total, 1);
        assert_eq!(snippet.items[0].matched_in, "snippet");
    }

    #[tokio::test]
    async fn quotes_and_operators_are_escaped_instead_of_breaking_the_query() {
        let (_directory, pool) = seed().await;
        insert_message(
            &pool,
            MessageSeed::new(4, 1, 1, 13)
                .from(Some("Dan"), "dan@example.test")
                .subject("He said \"hello\" loudly")
                .received_at("2026-01-04T10:00:00Z"),
        )
        .await;
        insert_search(
            &pool,
            4,
            1,
            1,
            Some("He said \"hello\" loudly"),
            Some("Dan"),
            Some("dan@example.test"),
            None,
            None,
        )
        .await;

        let quoted = search(&pool, query("said \"hello")).await.unwrap();
        assert_eq!(quoted.total, 1);
        assert_eq!(quoted.items[0].message.message_id, 4);

        let operator = search(&pool, query("NEAR(hello)")).await.unwrap();
        assert_eq!(operator.total, 0);

        let short_quote = search(&pool, query("\"")).await.unwrap();
        assert_eq!(short_quote.total, 1);
    }

    #[tokio::test]
    async fn filters_pagination_and_totals_are_applied_before_the_page() {
        let (_directory, pool) = seed().await;

        let first = search(
            &pool,
            SearchQuery {
                limit: 1,
                ..query("Quarterly")
            },
        )
        .await
        .unwrap();
        assert_eq!(first.total, 2);
        assert_eq!(first.items.len(), 1);
        assert!(first.has_more);
        let second = search(
            &pool,
            SearchQuery {
                limit: 1,
                offset: 1,
                ..query("Quarterly")
            },
        )
        .await
        .unwrap();
        assert_eq!(second.items.len(), 1);
        assert!(!second.has_more);

        let account = search(
            &pool,
            SearchQuery {
                account_id: Some(2),
                ..query("Quarterly")
            },
        )
        .await
        .unwrap();
        assert_eq!(account.total, 1);
        assert_eq!(account.items[0].message.account_id, 2);

        let starred = search(
            &pool,
            SearchQuery {
                starred_only: true,
                ..query("Pizza")
            },
        )
        .await
        .unwrap();
        assert_eq!(starred.total, 1);

        let unread = search(
            &pool,
            SearchQuery {
                unread_only: true,
                ..query("Quarterly")
            },
        )
        .await
        .unwrap();
        assert_eq!(unread.total, 1);
        assert_eq!(unread.items[0].message.message_id, 3);

        let ranged = search(
            &pool,
            SearchQuery {
                received_from: Some("2026-01-02T00:00:00Z".to_string()),
                received_before: Some("2026-01-03T00:00:00Z".to_string()),
                ..query("Quarterly")
            },
        )
        .await
        .unwrap();
        assert_eq!(ranged.total, 0);
    }

    #[tokio::test]
    async fn an_empty_keyword_returns_nothing() {
        let (_directory, pool) = seed().await;
        let page = search(&pool, query("   ")).await.unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);
    }

    #[test]
    fn excerpts_keep_sixty_characters_on_each_side() {
        let body = format!("{} needle {}", "a".repeat(100), "b".repeat(100));
        let excerpt = excerpt_body(&body, "needle").unwrap();
        assert!(excerpt.starts_with('…'));
        assert!(excerpt.ends_with('…'));
        assert!(excerpt.contains("needle"));
        assert_eq!(excerpt.chars().count(), 1 + 60 + 6 + 60 + 1);
    }
}
