//! Integration with the official cc-switch app.
//!
//! cc-switch keeps its provider list in `~/.cc-switch/cc-switch.db`, but the
//! device-level "current provider" pointer lives in `~/.cc-switch/settings.json`
//! (`currentProvider<App>`). Its UI reads that pointer first and only falls back
//! to the database's `is_current` column, so a switch here has to write both.
//!
//! Only the default paths are supported. Without the database the user has no
//! cc-switch installed and every call is a no-op. Writing is best-effort: a
//! failure never affects this app's own switch.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::app_type::AppType;
use super::import;
use super::switch::atomic_write;

/// Default cc-switch database path (`~/.cc-switch/cc-switch.db`).
pub fn default_db_path() -> PathBuf {
    import::default_cc_switch_db()
}

/// Moves the app's "current" marker in the default database to `provider_id`.
///
/// Returns whether anything was written: `false` when the database is missing or
/// holds no provider with that id.
pub async fn sync_current(app: AppType, provider_id: &str) -> Result<bool, String> {
    let path = default_db_path();
    if !path.is_file() {
        return Ok(false);
    }
    sync_current_in(app, provider_id, &path).await
}

/// The current provider id of an app in the official database.
///
/// Returns `None` when the database is missing.
pub async fn current_provider(app: AppType) -> Result<Option<String>, String> {
    let path = default_db_path();
    if !path.is_file() {
        return Ok(None);
    }
    current_provider_in(app, &path).await
}

/// `settings.json` that lives next to the database.
fn settings_path(db_path: &Path) -> PathBuf {
    db_path.with_file_name("settings.json")
}

/// cc-switch's `currentProvider*` key for an app.
///
/// Pi and MiniMax Code have no pointer: cc-switch tracks them as additive apps.
fn current_key(app: AppType) -> Option<&'static str> {
    Some(match app {
        AppType::Claude => "currentProviderClaude",
        AppType::Codex => "currentProviderCodex",
        AppType::Gemini => "currentProviderGemini",
        AppType::GrokBuild => "currentProviderGrokbuild",
        AppType::OpenCode => "currentProviderOpencode",
        AppType::OpenClaw => "currentProviderOpenclaw",
        AppType::Hermes => "currentProviderHermes",
        AppType::Pi | AppType::Mcode => return None,
    })
}

/// Reads the pointer from `settings.json`. A missing or unreadable file yields
/// `None`, which makes the database column authoritative.
fn read_pointer(path: &Path, app: AppType) -> Option<String> {
    let key = current_key(app)?;
    let text = std::fs::read_to_string(path).ok()?;
    let root: serde_json::Value = serde_json::from_str(&text).ok()?;
    root.get(key)?.as_str().map(str::to_owned)
}

/// Points `settings.json` at `provider_id`, leaving every other key untouched.
///
/// Returns whether the file was changed. A missing file is skipped on purpose:
/// cc-switch then falls back to the database, which is already written.
fn write_pointer(path: &Path, app: AppType, provider_id: &str) -> Result<bool, String> {
    let Some(key) = current_key(app) else {
        return Ok(false);
    };
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("Failed to read {}: {e}", path.display())),
    };
    let mut root: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Failed to parse {}: {e}", path.display()))?;
    let Some(map) = root.as_object_mut() else {
        return Err(format!("{} is not a JSON object", path.display()));
    };
    if map.get(key).and_then(|v| v.as_str()) == Some(provider_id) {
        return Ok(true);
    }
    map.insert(
        key.to_owned(),
        serde_json::Value::String(provider_id.to_owned()),
    );
    let json = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    atomic_write(path, &json)?;
    Ok(true)
}

async fn open_read_only(path: &Path) -> Result<SqlitePool, String> {
    SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(2))
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .read_only(true)
                .busy_timeout(Duration::from_millis(800)),
        )
        .await
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))
}

async fn current_provider_in(app: AppType, db_path: &Path) -> Result<Option<String>, String> {
    let pool = open_read_only(db_path).await?;

    // A pointer that no longer exists in the database is stale: cc-switch itself
    // clears it and falls back, so do the same.
    let pointer = read_pointer(&settings_path(db_path), app);
    let id = match pointer {
        Some(id) if provider_exists(&pool, app, &id).await? => Some(id),
        _ => sqlx::query_scalar(
            "SELECT id FROM providers WHERE app_type = ?1 AND is_current = 1 LIMIT 1",
        )
        .bind(app.as_str())
        .fetch_optional(&pool)
        .await
        .map_err(|e| e.to_string())?,
    };
    pool.close().await;
    Ok(id)
}

async fn provider_exists(pool: &SqlitePool, app: AppType, id: &str) -> Result<bool, String> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM providers WHERE id = ?1 AND app_type = ?2)")
        .bind(id)
        .bind(app.as_str())
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())
}

/// Syncs to an injected path, so tests can use a temporary directory.
async fn sync_current_in(app: AppType, provider_id: &str, db_path: &Path) -> Result<bool, String> {
    // A running cc-switch may hold the write lock: wait 800 ms at most rather
    // than stalling the switch.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(2))
        .connect_with(
            SqliteConnectOptions::new()
                .filename(db_path)
                .busy_timeout(Duration::from_millis(800)),
        )
        .await
        .map_err(|e| format!("Failed to open {}: {e}", db_path.display()))?;

    let written = write_current(&pool, app, provider_id).await;
    pool.close().await;
    if !written? {
        return Ok(false);
    }
    write_pointer(&settings_path(db_path), app, provider_id)?;
    Ok(true)
}

async fn write_current(pool: &SqlitePool, app: AppType, provider_id: &str) -> Result<bool, String> {
    // Do nothing when the id is unknown: flipping the flag blind would clear
    // cc-switch's current selection.
    if !provider_exists(pool, app, provider_id).await? {
        return Ok(false);
    }

    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE providers SET is_current = 0 WHERE app_type = ?1")
        .bind(app.as_str())
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE providers SET is_current = 1 WHERE id = ?1 AND app_type = ?2")
        .bind(provider_id)
        .bind(app.as_str())
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal database with a `providers` table: `a` is current, `b` is not.
    async fn temp_db(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ccswitch-sync-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cc-switch.db");

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE providers (
                id TEXT NOT NULL,
                app_type TEXT NOT NULL,
                settings_config TEXT NOT NULL,
                is_current BOOLEAN NOT NULL DEFAULT 0,
                PRIMARY KEY (id, app_type)
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        for (id, current) in [("a", 1), ("b", 0)] {
            sqlx::query(
                "INSERT INTO providers (id, app_type, settings_config, is_current)
                 VALUES (?1, 'claude', '{}', ?2)",
            )
            .bind(id)
            .bind(current)
            .execute(&pool)
            .await
            .unwrap();
        }
        pool.close().await;
        path
    }

    fn write_settings(db_path: &Path, json: &str) {
        std::fs::write(settings_path(db_path), json).unwrap();
    }

    fn read_settings(db_path: &Path) -> serde_json::Value {
        let text = std::fs::read_to_string(settings_path(db_path)).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    async fn current_ids(path: &Path) -> Vec<String> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(path).read_only(true))
            .await
            .unwrap();
        let ids = sqlx::query_scalar(
            "SELECT id FROM providers WHERE app_type = 'claude' AND is_current = 1 ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        pool.close().await;
        ids
    }

    #[tokio::test]
    async fn switches_to_an_existing_provider() {
        let path = temp_db("switch").await;
        assert!(sync_current_in(AppType::Claude, "b", &path).await.unwrap());
        assert_eq!(current_ids(&path).await, vec!["b".to_string()]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn keeps_the_current_provider_when_the_id_is_unknown() {
        let path = temp_db("unknown").await;
        assert!(!sync_current_in(AppType::Claude, "missing", &path)
            .await
            .unwrap());
        assert_eq!(current_ids(&path).await, vec!["a".to_string()]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn updates_the_pointer_and_keeps_the_other_settings() {
        let path = temp_db("pointer").await;
        write_settings(
            &path,
            r#"{"theme":"dark","currentProviderClaude":"a","webdavSync":{"url":"x"}}"#,
        );

        assert!(sync_current_in(AppType::Claude, "b", &path).await.unwrap());

        let settings = read_settings(&path);
        assert_eq!(settings["currentProviderClaude"], "b");
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["webdavSync"]["url"], "x");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn reads_the_current_provider() {
        let path = temp_db("read").await;
        assert_eq!(
            current_provider_in(AppType::Claude, &path).await.unwrap(),
            Some("a".to_string())
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn prefers_the_pointer_over_the_database() {
        let path = temp_db("read-pointer").await;
        write_settings(&path, r#"{"currentProviderClaude":"b"}"#);
        assert_eq!(
            current_provider_in(AppType::Claude, &path).await.unwrap(),
            Some("b".to_string())
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn ignores_a_pointer_whose_provider_is_gone() {
        let path = temp_db("stale-pointer").await;
        write_settings(&path, r#"{"currentProviderClaude":"deleted"}"#);
        assert_eq!(
            current_provider_in(AppType::Claude, &path).await.unwrap(),
            Some("a".to_string())
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn reads_nothing_for_an_app_without_rows() {
        let path = temp_db("other-app").await;
        assert_eq!(
            current_provider_in(AppType::Codex, &path).await.unwrap(),
            None
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn apps_without_a_pointer_are_skipped() {
        assert_eq!(current_key(AppType::Pi), None);
        assert_eq!(current_key(AppType::Mcode), None);
        assert_eq!(
            current_key(AppType::OpenCode),
            Some("currentProviderOpencode")
        );
    }
}
