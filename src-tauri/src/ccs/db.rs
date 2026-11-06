//! 供应商数据库（SQLite）。
//!
//! 存储从 `providers.json` 迁移到 SQLite：表结构与官方 cc-switch 的 `providers`
//! 表对齐（列名/类型/主键一致），这样既能直读官方库导入，也便于以后对照官方代码。
//! 本模块只负责「连接 + 建表 + 旧 JSON 迁移」；供应商的增删改查（DAO）放在
//! [`super::store`] 里以 `impl Database` 的形式提供，与官方 `database/dao` 的
//! 组织方式一致。
//!
//! 相比官方只保留本项目用到的部分：只建 `providers` 表，不含代理/日志/MCP 等表。

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use super::paths;
use super::provider::Provider;

/// 数据库连接池。
///
/// `SqlitePool` 本身是 `Clone + Send + Sync`，可以直接放进进程内的全局句柄，
/// 不需要额外的锁。
pub struct Database {
    pub(crate) pool: SqlitePool,
}

impl Database {
    /// 打开（必要时创建）应用数据库并建表；首次运行会把旧的 `providers.json`
    /// 迁移进来。
    pub async fn init() -> Result<Self, String> {
        let db_path = paths::store_db();
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }

        // 单连接：与旧的 `Mutex<Connection>` 一样串行化，避免并发写撞
        // "database is locked"（桌面应用单连接足够）。
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true)
                    .foreign_keys(true),
            )
            .await
            .map_err(|e| format!("Failed to open {}: {e}", db_path.display()))?;

        let db = Self { pool };
        db.create_tables().await?;
        db.migrate_legacy_json().await?;
        Ok(db)
    }

    /// 内存数据库（单元测试用）。
    pub async fn memory() -> Result<Self, String> {
        // `sqlite::memory:` 的每条连接都是独立的空库，因此必须限制为一条。
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().in_memory(true))
            .await
            .map_err(|e| e.to_string())?;
        let db = Self { pool };
        db.create_tables().await?;
        Ok(db)
    }

    /// 以只读方式打开某个已有的 cc-switch 数据库（用于「从官方库导入」）。
    pub async fn open_readonly(path: &Path) -> Result<Self, String> {
        // 只读打开不能带 `create_if_missing`，否则会试图新建文件。
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .read_only(true)
                    .foreign_keys(true),
            )
            .await
            .map_err(|e| format!("无法打开数据库 {}：{e}", path.display()))?;
        Ok(Self { pool })
    }

    /// 建表：`providers` 表与官方 cc-switch 的 DDL 一致。
    async fn create_tables(&self) -> Result<(), String> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS providers (
                id TEXT NOT NULL,
                app_type TEXT NOT NULL,
                name TEXT NOT NULL,
                settings_config TEXT NOT NULL,
                website_url TEXT,
                category TEXT,
                created_at INTEGER,
                sort_index INTEGER,
                notes TEXT,
                icon TEXT,
                icon_color TEXT,
                meta TEXT NOT NULL DEFAULT '{}',
                is_current BOOLEAN NOT NULL DEFAULT 0,
                in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
                PRIMARY KEY (id, app_type)
            )",
        )
        .execute(&self.pool)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 若数据库为空且存在旧的 `providers.json`，把它整体迁移进表。
    ///
    /// 迁移成功后把旧文件改名为 `providers.json.migrated`（保留可回退），
    /// 不会删除用户数据。
    async fn migrate_legacy_json(&self) -> Result<(), String> {
        self.migrate_legacy_json_from(&paths::legacy_store_file())
            .await
    }

    /// 从指定路径迁移旧 JSON（路径可注入，便于测试）。
    async fn migrate_legacy_json_from(&self, legacy: &Path) -> Result<(), String> {
        if !legacy.exists() {
            return Ok(());
        }

        {
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM providers")
                .fetch_one(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
            // 数据库已有数据则不重复迁移（幂等）。
            if count > 0 {
                return Ok(());
            }

            let text = fs::read_to_string(legacy)
                .map_err(|e| format!("Failed to read {}: {e}", legacy.display()))?;
            let store: LegacyStore = serde_json::from_str(&text).unwrap_or_default();

            for (app_id, app) in &store.data {
                for (index, provider) in app.list.iter().enumerate() {
                    let is_current = app.current.as_deref() == Some(provider.id.as_str());
                    let settings = serde_json::to_string(&provider.settings_config)
                        .map_err(|e| e.to_string())?;
                    let meta = serde_json::to_string(
                        provider
                            .meta
                            .as_ref()
                            .unwrap_or(&super::provider::ProviderMeta::default()),
                    )
                    .map_err(|e| e.to_string())?;
                    sqlx::query(
                        "INSERT OR REPLACE INTO providers (
                            id, app_type, name, settings_config, website_url, category,
                            created_at, sort_index, notes, icon, icon_color, meta,
                            is_current, in_failover_queue
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0)",
                    )
                    .bind(provider.id.as_str())
                    .bind(app_id.as_str())
                    .bind(provider.name.as_str())
                    .bind(settings)
                    .bind(provider.website_url.as_deref())
                    .bind(provider.category.as_deref())
                    .bind(provider.created_at)
                    .bind(
                        provider
                            .sort_index
                            .map(|v| v as i64)
                            .unwrap_or(index as i64),
                    )
                    .bind(provider.notes.as_deref())
                    .bind(provider.icon.as_deref())
                    .bind(provider.icon_color.as_deref())
                    .bind(meta)
                    .bind(is_current)
                    .execute(&self.pool)
                    .await
                    .map_err(|e| e.to_string())?;
                }
            }
        }

        // 迁移完成后再改名（此时已不再持有数据库连接）。
        let migrated = legacy.with_extension("json.migrated");
        fs::rename(legacy, &migrated)
            .map_err(|e| format!("Failed to archive {}: {e}", legacy.display()))?;
        Ok(())
    }
}

/// 全局数据库句柄（进程内单例）。
static DB: OnceLock<Database> = OnceLock::new();

/// 取得全局数据库；首次调用时初始化（建表 + 旧 JSON 迁移）。
pub(crate) async fn global() -> Result<&'static Database, String> {
    if let Some(db) = DB.get() {
        return Ok(db);
    }
    let db = Database::init().await?;
    let _ = DB.set(db);
    DB.get()
        .ok_or_else(|| "Failed to initialize providers database".to_string())
}

// ============================================================================
// 旧 providers.json 结构（仅用于迁移）
// ============================================================================

#[derive(Deserialize, Default)]
struct LegacyStore {
    #[serde(default)]
    data: HashMap<String, LegacyApp>,
}

#[derive(Deserialize, Default)]
struct LegacyApp {
    #[serde(default)]
    current: Option<String>,
    #[serde(default)]
    list: Vec<Provider>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_db_creates_providers_table() {
        let db = Database::memory().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM providers")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn migrates_legacy_json_into_sqlite() {
        let dir = std::env::temp_dir().join(format!("ccs-db-migrate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("providers.json");
        fs::write(
            &legacy,
            r#"{"version":1,"data":{"claude":{"current":"a","list":[
                {"id":"a","name":"A","settingsConfig":{"env":{"X":"1"}},"sortIndex":0},
                {"id":"b","name":"B","settingsConfig":{"env":{}},"sortIndex":1}
            ]}}}"#,
        )
        .unwrap();

        let db = Database::memory().await.unwrap();
        db.migrate_legacy_json_from(&legacy).await.unwrap();

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM providers WHERE app_type='claude'")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(count, 2);
        let current: String =
            sqlx::query_scalar("SELECT id FROM providers WHERE app_type='claude' AND is_current=1")
                .fetch_one(&db.pool)
                .await
                .unwrap();
        assert_eq!(current, "a");

        // 迁移后旧文件被改名归档，不再存在。
        assert!(!legacy.exists());
        assert!(dir.join("providers.json.migrated").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn migration_is_idempotent_when_db_has_rows() {
        let dir = std::env::temp_dir().join(format!("ccs-db-idem-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join("providers.json");
        fs::write(
            &legacy,
            r#"{"version":1,"data":{"pi":{"current":null,"list":[
                {"id":"x","name":"X","settingsConfig":{},"sortIndex":0}
            ]}}}"#,
        )
        .unwrap();

        let db = Database::memory().await.unwrap();
        db.save_provider(
            "pi",
            &Provider::new("z".into(), "Z".into(), serde_json::json!({})),
        )
        .await
        .unwrap();
        db.migrate_legacy_json_from(&legacy).await.unwrap();

        // 库中已有数据：不迁移，旧文件保持原样。
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM providers")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert!(legacy.exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
