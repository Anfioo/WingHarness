// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! `downloads.db`: the task table, its migrations and the four operations the
//! engine needs.
//!
//! The pool holds a single connection, so `SQLite` serialises access by itself
//! and the store carries no `std::sync::Mutex`. Callers must not hold one of
//! these futures across slow work: read the task, drop the borrow, transfer.

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow};
use sqlx::{Row, SqlitePool};

use crate::error::{MoinError, MoinResult};
use crate::models::{Task, TaskKind, TaskStatus};

/// Column order follows the frozen table in `Plan/moin/plan.1.md` §5.1.
const CREATE_TASKS: &str = "\
CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    url          TEXT NOT NULL,
    filename     TEXT NOT NULL,
    dest         TEXT NOT NULL,
    status       TEXT NOT NULL,
    total        INTEGER,
    received     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    archived     INTEGER NOT NULL DEFAULT 0,
    active_ms    INTEGER NOT NULL DEFAULT 0,
    completed_at INTEGER,
    backend      TEXT,
    category     TEXT,
    headers      TEXT,
    final_dir    TEXT
)";

/// Every column added after the first release, in the order the source store
/// adds them. The torrent-only columns (`info_hash`, `torrent_source`,
/// `uploaded`, `torrent_files`, `own_dir`, `skip_torrent_export`,
/// `force_start`) are the only ones this port drops.
const ADDED_COLUMNS: [&str; 7] = [
    "ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN completed_at INTEGER",
    "ALTER TABLE tasks ADD COLUMN backend TEXT",
    "ALTER TABLE tasks ADD COLUMN category TEXT",
    "ALTER TABLE tasks ADD COLUMN headers TEXT",
    "ALTER TABLE tasks ADD COLUMN final_dir TEXT",
];

const SELECT_TASKS: &str = "\
SELECT id, kind, url, filename, dest, status, total, received, error,
       created_at, updated_at, archived, active_ms, completed_at, backend,
       category, headers, final_dir
  FROM tasks
 ORDER BY created_at DESC, id DESC";

/// `url`, `filename`, `dest` and `created_at` describe where the task came from
/// and are written once, exactly like the source store: a resumed download must
/// not be able to point at a different file.
const UPSERT_TASK: &str = "\
INSERT INTO tasks (
    id, kind, url, filename, dest, status, total, received, error,
    created_at, updated_at, archived, active_ms, completed_at, backend,
    category, headers, final_dir
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
ON CONFLICT(id) DO UPDATE SET
    kind = excluded.kind,
    status = excluded.status,
    total = excluded.total,
    received = excluded.received,
    error = excluded.error,
    updated_at = excluded.updated_at,
    archived = excluded.archived,
    active_ms = excluded.active_ms,
    completed_at = excluded.completed_at,
    backend = excluded.backend,
    category = excluded.category,
    headers = excluded.headers,
    final_dir = excluded.final_dir";

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    /// Open (or create) `downloads.db` inside `data_dir` and bring the schema up
    /// to date. A database that cannot be opened is an `io` error: the download
    /// list shows an empty state instead of taking the window down.
    pub async fn open(data_dir: &Path) -> MoinResult<Self> {
        tokio::fs::create_dir_all(data_dir).await.map_err(|error| {
            MoinError::io(format!("Could not create the moin data directory: {error}"))
        })?;
        let options = SqliteConnectOptions::new()
            .filename(data_dir.join("downloads.db"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        sqlx::query(CREATE_TASKS).execute(&pool).await?;
        for statement in ADDED_COLUMNS {
            if let Err(error) = sqlx::query(statement).execute(&pool).await {
                // `ADD COLUMN` has no `IF NOT EXISTS`. A column that is already
                // there is the normal case for an existing database and must not
                // fail the open; anything else is a real failure.
                if !error.to_string().contains("duplicate column name") {
                    return Err(error.into());
                }
            }
        }
        Ok(Self { pool })
    }

    pub async fn all(&self) -> MoinResult<Vec<Task>> {
        let rows = sqlx::query(SELECT_TASKS).fetch_all(&self.pool).await?;
        rows.into_iter().map(task_from_row).collect()
    }

    pub async fn upsert(&self, task: &Task) -> MoinResult<()> {
        let headers = if task.headers.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&task.headers).map_err(|error| {
                MoinError::internal(format!("Could not encode the request headers: {error}"))
            })?)
        };
        sqlx::query(UPSERT_TASK)
            .bind(&task.id)
            .bind(kind_column(task.kind))
            .bind(&task.url)
            .bind(&task.filename)
            .bind(&task.dest)
            .bind(task.status.as_str())
            .bind(task.total.map(to_sql_integer))
            .bind(to_sql_integer(task.received))
            .bind(&task.error)
            .bind(task.created_at)
            .bind(task.updated_at)
            .bind(i64::from(task.archived))
            .bind(task.active_ms)
            .bind(task.completed_at)
            .bind(&task.backend)
            .bind(&task.category)
            .bind(headers)
            .bind(&task.final_dir)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> MoinResult<()> {
        sqlx::query("DELETE FROM tasks WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

/// `?` on a `sqlx` call inside this module turns into an `io` error with the
/// database message attached, which is what the engine reports to the UI.
impl From<sqlx::Error> for MoinError {
    fn from(error: sqlx::Error) -> Self {
        MoinError::io(format!("The downloads database rejected the request: {error}"))
    }
}

/// `engine.rs` still funnels store failures through `MoinError::io(error)`,
/// which needs the error to become its message. Kept until that call site uses
/// `?` directly (see `Plan/moin/inbox/B1.md` → 待协调).
impl From<MoinError> for String {
    fn from(error: MoinError) -> Self {
        error.message
    }
}

fn task_from_row(row: SqliteRow) -> MoinResult<Task> {
    let kind: String = row.try_get("kind")?;
    let received: i64 = row.try_get("received")?;
    let total: Option<i64> = row.try_get("total")?;
    let archived: i64 = row.try_get("archived")?;
    let headers: Option<String> = row.try_get("headers")?;
    Ok(Task {
        id: row.try_get("id")?,
        kind: if kind == "media" {
            TaskKind::Media
        } else {
            TaskKind::Http
        },
        url: row.try_get("url")?,
        filename: row.try_get("filename")?,
        dest: row.try_get("dest")?,
        status: TaskStatus::parse(&row.try_get::<String, _>("status")?),
        total: total.map(|value| value.max(0) as u64),
        received: received.max(0) as u64,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        completed_at: row.try_get("completed_at")?,
        archived: archived != 0,
        active_ms: row.try_get("active_ms")?,
        backend: row.try_get("backend")?,
        category: row.try_get("category")?,
        final_dir: row.try_get("final_dir")?,
        headers: headers
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default(),
    })
}

fn kind_column(kind: TaskKind) -> &'static str {
    match kind {
        TaskKind::Http => "http",
        TaskKind::Media => "media",
    }
}

fn to_sql_integer(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::Store;
    use crate::models::{Task, TaskKind, TaskStatus};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::Row;
    use std::collections::BTreeMap;

    fn task(id: &str, created_at: i64) -> Task {
        Task {
            id: id.to_string(),
            kind: TaskKind::Http,
            url: "https://example.test/file.zip".to_string(),
            filename: "file.zip".to_string(),
            dest: "C:/Downloads/file.zip".to_string(),
            status: TaskStatus::Queued,
            total: None,
            received: 0,
            error: None,
            created_at,
            updated_at: created_at,
            completed_at: None,
            archived: false,
            active_ms: 0,
            backend: None,
            category: None,
            final_dir: None,
            headers: BTreeMap::new(),
        }
    }

    async fn raw_headers(store: &Store, id: &str) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>("SELECT headers FROM tasks WHERE id = ?1")
            .bind(id)
            .fetch_one(&store.pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn creates_the_table_on_first_open() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        assert!(dir.path().join("downloads.db").exists());
        assert!(store.all().await.unwrap().is_empty());
        let columns: Vec<String> = sqlx::query("PRAGMA table_info(tasks)")
            .fetch_all(&store.pool)
            .await
            .unwrap()
            .into_iter()
            .filter_map(|row| row.try_get::<String, _>("name").ok())
            .collect();
        for column in ["headers", "final_dir", "backend", "category", "completed_at"] {
            assert!(columns.iter().any(|name| name == column), "{column} is missing");
        }
    }

    #[tokio::test]
    async fn upsert_is_idempotent_and_keeps_the_identity_columns() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        let mut task = task("one", 1);
        store.upsert(&task).await.unwrap();
        task.url = "https://example.test/other.zip".to_string();
        task.filename = "other.zip".to_string();
        task.dest = "D:/Downloads/other.zip".to_string();
        task.created_at = 99;
        task.status = TaskStatus::Downloading;
        task.received = 42;
        store.upsert(&task).await.unwrap();
        let all = store.all().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].url, "https://example.test/file.zip");
        assert_eq!(all[0].filename, "file.zip");
        assert_eq!(all[0].dest, "C:/Downloads/file.zip");
        assert_eq!(all[0].created_at, 1);
        assert_eq!(all[0].status, TaskStatus::Downloading);
        assert_eq!(all[0].received, 42);
    }

    #[tokio::test]
    async fn headers_are_null_when_empty_and_round_trip_as_json() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        store.upsert(&task("plain", 1)).await.unwrap();
        let mut with_headers = task("auth", 2);
        with_headers.headers.insert("Cookie".to_string(), "a=b".to_string());
        with_headers.headers.insert("Referer".to_string(), "https://example.test/".to_string());
        store.upsert(&with_headers).await.unwrap();

        assert_eq!(raw_headers(&store, "plain").await, None);
        let stored = raw_headers(&store, "auth").await.expect("headers column");
        assert_eq!(
            serde_json::from_str::<BTreeMap<String, String>>(&stored).unwrap(),
            with_headers.headers
        );

        let all = store.all().await.unwrap();
        let auth = all.iter().find(|task| task.id == "auth").unwrap();
        assert_eq!(auth.headers, with_headers.headers);
        assert!(all.iter().find(|task| task.id == "plain").unwrap().headers.is_empty());
    }

    #[tokio::test]
    async fn migrates_a_database_without_the_newer_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("downloads.db");
        {
            let options = SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true);
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(options)
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE tasks (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, url TEXT NOT NULL,
                    filename TEXT NOT NULL, dest TEXT NOT NULL, status TEXT NOT NULL,
                    total INTEGER, received INTEGER NOT NULL DEFAULT 0, error TEXT,
                    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                )",
            )
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO tasks (id, kind, url, filename, dest, status, received, created_at, updated_at)
                 VALUES ('legacy', 'http', 'https://example.test/old.bin', 'old.bin',
                         'C:/Downloads/old.bin', 'completed', 10, 5, 6)",
            )
            .execute(&pool)
            .await
            .unwrap();
            pool.close().await;
        }

        let store = Store::open(dir.path()).await.unwrap();
        let all = store.all().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "legacy");
        assert_eq!(all[0].received, 10);
        assert_eq!(all[0].completed_at, None);
        assert!(all[0].headers.is_empty());

        let mut migrated = all[0].clone();
        migrated.completed_at = Some(7);
        migrated.backend = Some("embedded".to_string());
        migrated.category = Some("archives".to_string());
        migrated.final_dir = Some("D:/Downloads".to_string());
        migrated.headers.insert("Cookie".to_string(), "a=b".to_string());
        store.upsert(&migrated).await.unwrap();

        let reloaded = store.all().await.unwrap();
        assert_eq!(reloaded[0].completed_at, Some(7));
        assert_eq!(reloaded[0].backend.as_deref(), Some("embedded"));
        assert_eq!(reloaded[0].category.as_deref(), Some("archives"));
        assert_eq!(reloaded[0].final_dir.as_deref(), Some("D:/Downloads"));
        assert_eq!(reloaded[0].headers.get("Cookie").map(String::as_str), Some("a=b"));
    }

    #[tokio::test]
    async fn lists_newest_first_and_deletes_without_residue() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        for (id, created_at) in [("old", 1), ("newest", 3), ("middle", 2)] {
            store.upsert(&task(id, created_at)).await.unwrap();
        }
        let ids: Vec<String> = store
            .all()
            .await
            .unwrap()
            .into_iter()
            .map(|task| task.id)
            .collect();
        assert_eq!(ids, ["newest", "middle", "old"]);

        store.delete("middle").await.unwrap();
        let ids: Vec<String> = store
            .all()
            .await
            .unwrap()
            .into_iter()
            .map(|task| task.id)
            .collect();
        assert_eq!(ids, ["newest", "old"]);
    }
}
