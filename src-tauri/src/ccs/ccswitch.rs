//! 与官方 cc-switch 数据库的联动。
//!
//! 切换供应商时把官方库里该应用的 `is_current` 标记同步过去，让两个工具的
//! 「当前供应商」保持一致。只认默认路径 `~/.cc-switch/cc-switch.db`；库不存在
//! 说明用户没装 cc-switch，静默跳过。
//!
//! 同步是单向的：cc-switch 自己切换时不会回写本应用，两边仍可能漂移。写失败
//! 也不影响切换本身 —— 此时 CLI 配置文件与本应用的当前指针都已经写好。

use std::path::{Path, PathBuf};
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use super::app_type::AppType;
use super::import;

/// 官方 cc-switch 数据库的默认路径。
pub fn default_db_path() -> PathBuf {
    import::default_cc_switch_db()
}

/// 把默认库里该应用的「当前」标记切到 `provider_id`。
///
/// 返回是否真的写入：库不存在，或库里没有这个 ID 时返回 `false`。
pub async fn sync_current(app: AppType, provider_id: &str) -> Result<bool, String> {
    let path = default_db_path();
    if !path.is_file() {
        return Ok(false);
    }
    sync_current_in(app, provider_id, &path).await
}

/// 同步到指定路径（路径可注入，便于测试）。
async fn sync_current_in(app: AppType, provider_id: &str, path: &Path) -> Result<bool, String> {
    // cc-switch 运行时可能正持有写锁：总线等时 800ms，宁可放弃也不要拖住切换。
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(2))
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .busy_timeout(Duration::from_millis(800)),
        )
        .await
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;

    let result = write_current(&pool, app, provider_id).await;
    pool.close().await;
    result
}

async fn write_current(
    pool: &SqlitePool,
    app: AppType,
    provider_id: &str,
) -> Result<bool, String> {
    // 库里没有这个 ID 时什么都不做：直接置位会把 cc-switch 的当前选择清空。
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM providers WHERE id = ?1 AND app_type = ?2)")
            .bind(provider_id)
            .bind(app.as_str())
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
    if !exists {
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

    /// 建一个只含 `providers` 表的最小库：a 是当前，b 不是。
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
}
