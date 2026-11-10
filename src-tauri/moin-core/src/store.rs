// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See UPSTREAM.md for the porting record.

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::models::{Task, TaskKind, TaskStatus};

#[derive(Clone)]
pub(crate) struct Store {
    pool: SqlitePool,
}

impl Store {
    pub async fn open(data_dir: &Path) -> Result<Self, String> {
        tokio::fs::create_dir_all(data_dir)
            .await
            .map_err(|error| error.to_string())?;
        let options = SqliteConnectOptions::new()
            .filename(data_dir.join("downloads.db"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                url TEXT NOT NULL,
                filename TEXT NOT NULL,
                dest TEXT NOT NULL,
                status TEXT NOT NULL,
                total INTEGER,
                received INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER,
                archived INTEGER NOT NULL DEFAULT 0,
                active_ms INTEGER NOT NULL DEFAULT 0,
                backend TEXT,
                category TEXT,
                final_dir TEXT,
                headers TEXT
            )",
        )
        .execute(&pool)
        .await
        .map_err(|error| error.to_string())?;
        let schema = [
            ("completed_at", "ALTER TABLE tasks ADD COLUMN completed_at INTEGER"),
            ("archived", "ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"),
            ("active_ms", "ALTER TABLE tasks ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0"),
            ("backend", "ALTER TABLE tasks ADD COLUMN backend TEXT"),
            ("category", "ALTER TABLE tasks ADD COLUMN category TEXT"),
            ("final_dir", "ALTER TABLE tasks ADD COLUMN final_dir TEXT"),
            ("headers", "ALTER TABLE tasks ADD COLUMN headers TEXT"),
        ];
        let columns = sqlx::query("PRAGMA table_info(tasks)")
            .fetch_all(&pool)
            .await
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter_map(|row| row.try_get::<String, _>("name").ok())
            .collect::<std::collections::HashSet<_>>();
        for (column, migration) in schema {
            if !columns.contains(column) {
                sqlx::query(migration)
                    .execute(&pool)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        sqlx::query(
            "UPDATE tasks SET completed_at = updated_at
             WHERE status = 'completed' AND completed_at IS NULL",
        )
        .execute(&pool)
        .await
        .map_err(|error| error.to_string())?;
        Ok(Self { pool })
    }

    pub async fn all(&self) -> Result<Vec<Task>, String> {
        let rows = sqlx::query(
            "SELECT id, kind, url, filename, dest, status, total, received, error,
                    created_at, updated_at, completed_at, archived, active_ms,
                    backend, category, final_dir, headers
             FROM tasks ORDER BY created_at DESC, id DESC",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        rows.into_iter().map(task_from_row).collect()
    }

    pub async fn upsert(&self, task: &Task) -> Result<(), String> {
        let headers = if task.headers.is_empty() {
            None
        } else {
            Some(serde_json::to_string(&task.headers).map_err(|error| error.to_string())?)
        };
        sqlx::query(
            "INSERT INTO tasks (
                id, kind, url, filename, dest, status, total, received, error,
                created_at, updated_at, completed_at, archived, active_ms,
                backend, category, final_dir, headers
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18
             ) ON CONFLICT(id) DO UPDATE SET
                kind=excluded.kind, url=excluded.url, filename=excluded.filename,
                dest=excluded.dest, status=excluded.status, total=excluded.total,
                received=excluded.received, error=excluded.error,
                updated_at=excluded.updated_at, completed_at=excluded.completed_at,
                archived=excluded.archived, active_ms=excluded.active_ms,
                backend=excluded.backend, category=excluded.category,
                final_dir=excluded.final_dir, headers=excluded.headers",
        )
        .bind(&task.id)
        .bind(match task.kind { TaskKind::Http => "http", TaskKind::Media => "media" })
        .bind(&task.url)
        .bind(&task.filename)
        .bind(&task.dest)
        .bind(task.status.as_str())
        .bind(task.total.map(to_sql_integer))
        .bind(to_sql_integer(task.received))
        .bind(&task.error)
        .bind(task.created_at)
        .bind(task.updated_at)
        .bind(task.completed_at)
        .bind(i64::from(task.archived))
        .bind(task.active_ms)
        .bind(&task.backend)
        .bind(&task.category)
        .bind(&task.final_dir)
        .bind(headers)
        .execute(&self.pool)
        .await
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> Result<(), String> {
        sqlx::query("DELETE FROM tasks WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn task_from_row(row: sqlx::sqlite::SqliteRow) -> Result<Task, String> {
    let kind: String = row.try_get("kind").map_err(|error| error.to_string())?;
    let headers: Option<String> = row.try_get("headers").map_err(|error| error.to_string())?;
    let received: i64 = row.try_get("received").map_err(|error| error.to_string())?;
    let total: Option<i64> = row.try_get("total").map_err(|error| error.to_string())?;
    let archived: i64 = row.try_get("archived").map_err(|error| error.to_string())?;
    Ok(Task {
        id: row.try_get("id").map_err(|error| error.to_string())?,
        kind: if kind == "media" { TaskKind::Media } else { TaskKind::Http },
        url: row.try_get("url").map_err(|error| error.to_string())?,
        filename: row.try_get("filename").map_err(|error| error.to_string())?,
        dest: row.try_get("dest").map_err(|error| error.to_string())?,
        status: TaskStatus::parse(&row.try_get::<String, _>("status").map_err(|error| error.to_string())?),
        total: total.map(|value| value.max(0) as u64),
        received: received.max(0) as u64,
        error: row.try_get("error").map_err(|error| error.to_string())?,
        created_at: row.try_get("created_at").map_err(|error| error.to_string())?,
        updated_at: row.try_get("updated_at").map_err(|error| error.to_string())?,
        completed_at: row.try_get("completed_at").map_err(|error| error.to_string())?,
        archived: archived != 0,
        active_ms: row.try_get("active_ms").map_err(|error| error.to_string())?,
        backend: row.try_get("backend").map_err(|error| error.to_string())?,
        category: row.try_get("category").map_err(|error| error.to_string())?,
        final_dir: row.try_get("final_dir").map_err(|error| error.to_string())?,
        headers: headers
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default(),
    })
}

fn to_sql_integer(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::Store;
    use crate::models::{Task, TaskKind, TaskStatus};
    use std::collections::BTreeMap;

    fn task() -> Task {
        Task {
            id: "one".into(),
            kind: TaskKind::Http,
            url: "https://example.test/file.zip".into(),
            filename: "file.zip".into(),
            dest: "C:/Downloads/file.zip".into(),
            status: TaskStatus::Queued,
            total: None,
            received: 0,
            error: None,
            created_at: 1,
            updated_at: 1,
            completed_at: None,
            archived: false,
            active_ms: 0,
            backend: None,
            category: None,
            final_dir: None,
            headers: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn upsert_updates_path_and_progress_without_duplicate_rows() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).await.unwrap();
        let mut task = task();
        store.upsert(&task).await.unwrap();
        task.dest = "D:/Downloads/file.zip".into();
        task.received = 42;
        store.upsert(&task).await.unwrap();
        let all = store.all().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].dest, "D:/Downloads/file.zip");
        assert_eq!(all[0].received, 42);
    }
}
