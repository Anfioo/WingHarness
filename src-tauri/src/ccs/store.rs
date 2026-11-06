//! 供应商数据持久化（SQLite DAO）。
//!
//! 数据存在应用数据目录下的 `ccs.db`（见 [`super::paths::store_db`]），表结构
//! 对齐官方 cc-switch 的 `providers` 表。CRUD 方法挂在 [`Database`] 上，与官方
//! `database/dao/providers.rs` 的组织方式一致；模块级函数（[`list`] 等）是给调用方
//! 用的薄封装，内部走进程内的全局数据库句柄。
//!
//! 相比官方去掉了 `provider_endpoints` / `provider_health` / 故障转移队列等本项目
//! 不用的特性，`in_failover_queue` 列保留以保持表结构对齐。

use sqlx::Row;

use super::app_type::AppType;
use super::db;
use super::provider::{Provider, ProviderMeta};

impl db::Database {
    /// 列出某应用的全部供应商（按 sort_index、创建时间、id 排序）。
    pub(crate) async fn list_providers(&self, app_type: &str) -> Result<Vec<Provider>, String> {
        let rows = sqlx::query(
            "SELECT id, name, settings_config, website_url, category, created_at,
                    sort_index, notes, icon, icon_color, meta, in_failover_queue
             FROM providers WHERE app_type = ?1
             ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC",
        )
        .bind(app_type)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let mut providers = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.try_get("id").map_err(|e| e.to_string())?;
            let name: String = row.try_get("name").map_err(|e| e.to_string())?;
            let settings: String = row.try_get("settings_config").map_err(|e| e.to_string())?;
            let website_url: Option<String> =
                row.try_get("website_url").map_err(|e| e.to_string())?;
            let category: Option<String> = row.try_get("category").map_err(|e| e.to_string())?;
            let created_at: Option<i64> = row.try_get("created_at").map_err(|e| e.to_string())?;
            let sort_index: Option<i64> = row.try_get("sort_index").map_err(|e| e.to_string())?;
            let notes: Option<String> = row.try_get("notes").map_err(|e| e.to_string())?;
            let icon: Option<String> = row.try_get("icon").map_err(|e| e.to_string())?;
            let icon_color: Option<String> =
                row.try_get("icon_color").map_err(|e| e.to_string())?;
            let meta: String = row.try_get("meta").map_err(|e| e.to_string())?;
            providers.push(Provider {
                id,
                name,
                settings_config: serde_json::from_str(&settings).unwrap_or(serde_json::Value::Null),
                website_url,
                category,
                created_at,
                sort_index: sort_index.map(|v| v.max(0) as usize),
                notes,
                meta: Some(serde_json::from_str(&meta).unwrap_or_default()),
                icon,
                icon_color,
            });
        }
        Ok(providers)
    }

    /// 获取单个供应商。
    pub(crate) async fn get_provider(
        &self,
        app_type: &str,
        id: &str,
    ) -> Result<Option<Provider>, String> {
        let row = sqlx::query(
            "SELECT name, settings_config, website_url, category, created_at,
                    sort_index, notes, icon, icon_color, meta
             FROM providers WHERE id = ?1 AND app_type = ?2",
        )
        .bind(id)
        .bind(app_type)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())?;

        let Some(row) = row else {
            return Ok(None);
        };

        let name: String = row.try_get("name").map_err(|e| e.to_string())?;
        let settings: String = row.try_get("settings_config").map_err(|e| e.to_string())?;
        let website_url: Option<String> = row.try_get("website_url").map_err(|e| e.to_string())?;
        let category: Option<String> = row.try_get("category").map_err(|e| e.to_string())?;
        let created_at: Option<i64> = row.try_get("created_at").map_err(|e| e.to_string())?;
        let sort_index: Option<i64> = row.try_get("sort_index").map_err(|e| e.to_string())?;
        let notes: Option<String> = row.try_get("notes").map_err(|e| e.to_string())?;
        let icon: Option<String> = row.try_get("icon").map_err(|e| e.to_string())?;
        let icon_color: Option<String> = row.try_get("icon_color").map_err(|e| e.to_string())?;
        let meta: String = row.try_get("meta").map_err(|e| e.to_string())?;

        Ok(Some(Provider {
            id: id.to_string(),
            name,
            settings_config: serde_json::from_str(&settings).unwrap_or(serde_json::Value::Null),
            website_url,
            category,
            created_at,
            sort_index: sort_index.map(|v| v.max(0) as usize),
            notes,
            meta: Some(serde_json::from_str(&meta).unwrap_or_default()),
            icon,
            icon_color,
        }))
    }

    /// 当前生效供应商的 ID。
    pub(crate) async fn get_current_provider(
        &self,
        app_type: &str,
    ) -> Result<Option<String>, String> {
        sqlx::query_scalar(
            "SELECT id FROM providers WHERE app_type = ?1 AND is_current = 1 LIMIT 1",
        )
        .bind(app_type)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| e.to_string())
    }

    /// 下一个可用的 sort_index（追加到末尾）。
    pub(crate) async fn next_sort_index(&self, app_type: &str) -> Result<i64, String> {
        let max: Option<i64> =
            sqlx::query_scalar("SELECT MAX(sort_index) FROM providers WHERE app_type = ?1")
                .bind(app_type)
                .fetch_one(&self.pool)
                .await
                .map_err(|e| e.to_string())?;
        Ok(max.map(|v| v + 1).unwrap_or(0))
    }

    /// 插入或更新一个供应商（按 (id, app_type) 主键）。
    ///
    /// 更新时保留现有的 `is_current` / `in_failover_queue`，并沿用现有 sort_index
    /// （`provider.sort_index` 为空时）。
    pub(crate) async fn save_provider(
        &self,
        app_type: &str,
        provider: &Provider,
    ) -> Result<(), String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;

        let existing: Option<(bool, bool, Option<i64>)> = sqlx::query_as(
            "SELECT is_current, in_failover_queue, sort_index
             FROM providers WHERE id = ?1 AND app_type = ?2",
        )
        .bind(provider.id.as_str())
        .bind(app_type)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        let settings = serde_json::to_string(&provider.settings_config)
            .map_err(|e| format!("Failed to serialize settings_config: {e}"))?;
        let meta =
            serde_json::to_string(provider.meta.as_ref().unwrap_or(&ProviderMeta::default()))
                .map_err(|e| format!("Failed to serialize meta: {e}"))?;

        match existing {
            Some((is_current, in_failover_queue, existing_sort)) => {
                let sort_index = provider.sort_index.map(|v| v as i64).or(existing_sort);
                sqlx::query(
                    "UPDATE providers SET
                        name = ?1, settings_config = ?2, website_url = ?3, category = ?4,
                        created_at = ?5, sort_index = ?6, notes = ?7, icon = ?8,
                        icon_color = ?9, meta = ?10, is_current = ?11, in_failover_queue = ?12
                     WHERE id = ?13 AND app_type = ?14",
                )
                .bind(provider.name.as_str())
                .bind(settings)
                .bind(provider.website_url.as_deref())
                .bind(provider.category.as_deref())
                .bind(provider.created_at)
                .bind(sort_index)
                .bind(provider.notes.as_deref())
                .bind(provider.icon.as_deref())
                .bind(provider.icon_color.as_deref())
                .bind(meta)
                .bind(is_current)
                .bind(in_failover_queue)
                .bind(provider.id.as_str())
                .bind(app_type)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            }
            None => {
                let sort_index = provider.sort_index.map(|v| v as i64).unwrap_or(0);
                sqlx::query(
                    "INSERT INTO providers (
                        id, app_type, name, settings_config, website_url, category,
                        created_at, sort_index, notes, icon, icon_color, meta,
                        is_current, in_failover_queue
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, 0)",
                )
                .bind(provider.id.as_str())
                .bind(app_type)
                .bind(provider.name.as_str())
                .bind(settings)
                .bind(provider.website_url.as_deref())
                .bind(provider.category.as_deref())
                .bind(provider.created_at)
                .bind(sort_index)
                .bind(provider.notes.as_deref())
                .bind(provider.icon.as_deref())
                .bind(provider.icon_color.as_deref())
                .bind(meta)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            }
        }

        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 就地重命名供应商主键（id 变更）并更新其余字段。
    ///
    /// 直接改写主键，保留 is_current / in_failover_queue / sort_index，避免
    /// 「删旧行 + 插新行」导致的排序错位（本项目没有 provider_endpoints 等子表
    /// 需要跟随，所以无需像官方那样搬引用）。
    pub(crate) async fn rename_provider(
        &self,
        app_type: &str,
        original_id: &str,
        provider: &Provider,
    ) -> Result<(), String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;

        let (is_current, in_failover_queue, existing_sort): (bool, bool, Option<i64>) =
            sqlx::query_as(
                "SELECT is_current, in_failover_queue, sort_index
                 FROM providers WHERE id = ?1 AND app_type = ?2",
            )
            .bind(original_id)
            .bind(app_type)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

        let target_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM providers WHERE id = ?1 AND app_type = ?2)",
        )
        .bind(provider.id.as_str())
        .bind(app_type)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if target_exists {
            return Err(format!("Provider with id {} already exists", provider.id));
        }

        let settings = serde_json::to_string(&provider.settings_config)
            .map_err(|e| format!("Failed to serialize settings_config: {e}"))?;
        let meta =
            serde_json::to_string(provider.meta.as_ref().unwrap_or(&ProviderMeta::default()))
                .map_err(|e| format!("Failed to serialize meta: {e}"))?;
        let sort_index = provider.sort_index.map(|v| v as i64).or(existing_sort);

        sqlx::query(
            "UPDATE providers SET
                id = ?1, name = ?2, settings_config = ?3, website_url = ?4, category = ?5,
                created_at = ?6, sort_index = ?7, notes = ?8, icon = ?9, icon_color = ?10,
                meta = ?11, is_current = ?12, in_failover_queue = ?13
             WHERE id = ?14 AND app_type = ?15",
        )
        .bind(provider.id.as_str())
        .bind(provider.name.as_str())
        .bind(settings)
        .bind(provider.website_url.as_deref())
        .bind(provider.category.as_deref())
        .bind(provider.created_at)
        .bind(sort_index)
        .bind(provider.notes.as_deref())
        .bind(provider.icon.as_deref())
        .bind(provider.icon_color.as_deref())
        .bind(meta)
        .bind(is_current)
        .bind(in_failover_queue)
        .bind(original_id)
        .bind(app_type)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 删除供应商。若为当前供应商则同时清空当前指针，并重排 sort_index。
    pub(crate) async fn delete_provider(&self, app_type: &str, id: &str) -> Result<(), String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;

        let deleted = sqlx::query("DELETE FROM providers WHERE id = ?1 AND app_type = ?2")
            .bind(id)
            .bind(app_type)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        if deleted.rows_affected() == 0 {
            return Err(format!("Provider {id} not found"));
        }

        // 重排剩余行的 sort_index，保持连续。
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM providers WHERE app_type = ?1
             ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC",
        )
        .bind(app_type)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        for (index, pid) in ids.iter().enumerate() {
            sqlx::query("UPDATE providers SET sort_index = ?1 WHERE id = ?2 AND app_type = ?3")
                .bind(index as i64)
                .bind(pid.as_str())
                .bind(app_type)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }

        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 设置当前供应商；传 `None` 清空该应用的当前指针。
    pub(crate) async fn set_current_provider(
        &self,
        app_type: &str,
        id: Option<&str>,
    ) -> Result<(), String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;

        if let Some(id) = id {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM providers WHERE id = ?1 AND app_type = ?2)",
            )
            .bind(id)
            .bind(app_type)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if !exists {
                return Err(format!("Provider {id} not found"));
            }
        }

        sqlx::query("UPDATE providers SET is_current = 0 WHERE app_type = ?1")
            .bind(app_type)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(id) = id {
            sqlx::query("UPDATE providers SET is_current = 1 WHERE id = ?1 AND app_type = ?2")
                .bind(id)
                .bind(app_type)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }

        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 按给定 ID 顺序重排供应商；未列出的追加到末尾。
    pub(crate) async fn reorder_providers(
        &self,
        app_type: &str,
        ordered_ids: &[String],
    ) -> Result<(), String> {
        let mut tx = self.pool.begin().await.map_err(|e| e.to_string())?;

        for (index, id) in ordered_ids.iter().enumerate() {
            sqlx::query("UPDATE providers SET sort_index = ?1 WHERE id = ?2 AND app_type = ?3")
                .bind(index as i64)
                .bind(id.as_str())
                .bind(app_type)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        // 未在 ordered_ids 中出现的行排到末尾（保持它们之间的相对顺序）。
        let rest: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM providers WHERE app_type = ?1
             ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC",
        )
        .bind(app_type)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let mut next = ordered_ids.len() as i64;
        for id in rest {
            if ordered_ids.iter().any(|o| o == &id) {
                continue;
            }
            sqlx::query("UPDATE providers SET sort_index = ?1 WHERE id = ?2 AND app_type = ?3")
                .bind(next)
                .bind(id.as_str())
                .bind(app_type)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            next += 1;
        }

        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 复制一个供应商（新 ID、名称追加 " Copy"、追加到末尾），返回新 ID。
    pub(crate) async fn duplicate_provider(
        &self,
        app_type: &str,
        id: &str,
    ) -> Result<String, String> {
        let source = self
            .get_provider(app_type, id)
            .await?
            .ok_or_else(|| format!("Provider {id} not found"))?;
        let mut copy = source;
        copy.id = uuid::Uuid::new_v4().to_string();
        copy.name = format!("{} Copy", copy.name);
        copy.sort_index = Some(self.next_sort_index(app_type).await? as usize);
        self.save_provider(app_type, &copy).await?;
        Ok(copy.id)
    }
}

// ============================================================================
// 模块级 API（走进程内全局数据库），供 ccs 其他模块与命令调用。
// ============================================================================

/// 列出某应用的全部供应商。
pub async fn list(app: AppType) -> Vec<Provider> {
    match db::global().await {
        Ok(db) => db.list_providers(app.as_str()).await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 获取单个供应商。
pub async fn get(app: AppType, id: &str) -> Option<Provider> {
    match db::global().await {
        Ok(db) => db.get_provider(app.as_str(), id).await.ok().flatten(),
        Err(_) => None,
    }
}

/// 获取当前供应商 ID。
pub async fn current(app: AppType) -> Option<String> {
    match db::global().await {
        Ok(db) => db.get_current_provider(app.as_str()).await.ok().flatten(),
        Err(_) => None,
    }
}

/// 添加供应商。若 ID 为空则自动生成；返回最终 ID。
pub async fn add(app: AppType, mut provider: Provider) -> Result<String, String> {
    let db = db::global().await?;
    if provider.id.trim().is_empty() {
        provider.id = uuid::Uuid::new_v4().to_string();
    }
    if db.get_provider(app.as_str(), &provider.id).await?.is_some() {
        return Err(format!("Provider with id {} already exists", provider.id));
    }
    provider.sort_index = Some(db.next_sort_index(app.as_str()).await?.max(0) as usize);
    db.save_provider(app.as_str(), &provider).await?;
    Ok(provider.id)
}

/// 更新供应商；`original_id` 与新 ID 不同时视为重命名 ID。
pub async fn update(app: AppType, original_id: &str, mut provider: Provider) -> Result<(), String> {
    let db = db::global().await?;
    let existing = db
        .get_provider(app.as_str(), original_id)
        .await?
        .ok_or_else(|| format!("Provider {original_id} not found"))?;

    // 保留原排序位置。
    provider.sort_index = existing.sort_index;

    if provider.id == original_id {
        return db.save_provider(app.as_str(), &provider).await;
    }
    // 主键变了：就地重命名（保留 is_current / sort_index）。
    db.rename_provider(app.as_str(), original_id, &provider)
        .await
}

/// 删除供应商；若它是当前供应商则清空当前指针。
pub async fn delete(app: AppType, id: &str) -> Result<(), String> {
    let db = db::global().await?;
    db.delete_provider(app.as_str(), id).await
}

/// 复制供应商，新 ID 自动生成，名称追加后缀。
pub async fn duplicate(app: AppType, id: &str) -> Result<String, String> {
    db::global()
        .await?
        .duplicate_provider(app.as_str(), id)
        .await
}

/// 设置当前供应商指针（不写配置文件；写文件由 switch 引擎负责）。
pub async fn set_current(app: AppType, id: Option<&str>) -> Result<(), String> {
    db::global()
        .await?
        .set_current_provider(app.as_str(), id)
        .await
}

/// 按给定 ID 顺序重排供应商。
pub async fn reorder(app: AppType, ordered_ids: Vec<String>) -> Result<(), String> {
    db::global()
        .await?
        .reorder_providers(app.as_str(), &ordered_ids)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(id: &str, name: &str) -> Provider {
        Provider::new(id.to_string(), name.into(), json!({ "env": {} }))
    }

    #[tokio::test]
    async fn add_get_update_delete_flow() {
        let db = db::Database::memory().await.unwrap();
        db.save_provider("pi", &sample("a", "Alpha")).await.unwrap();
        assert_eq!(
            db.get_provider("pi", "a").await.unwrap().unwrap().name,
            "Alpha"
        );

        let mut edited = db.get_provider("pi", "a").await.unwrap().unwrap();
        edited.name = "Alpha2".into();
        db.save_provider("pi", &edited).await.unwrap();
        assert_eq!(
            db.get_provider("pi", "a").await.unwrap().unwrap().name,
            "Alpha2"
        );

        db.delete_provider("pi", "a").await.unwrap();
        assert!(db.get_provider("pi", "a").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_orders_by_sort_index() {
        let db = db::Database::memory().await.unwrap();
        let mut b = sample("b", "B");
        b.sort_index = Some(1);
        let mut a = sample("a", "A");
        a.sort_index = Some(0);
        db.save_provider("pi", &b).await.unwrap();
        db.save_provider("pi", &a).await.unwrap();
        let ids: Vec<String> = db
            .list_providers("pi")
            .await
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[tokio::test]
    async fn duplicate_creates_new_with_suffix() {
        let db = db::Database::memory().await.unwrap();
        db.save_provider("pi", &sample("beta", "Beta"))
            .await
            .unwrap();
        let copy_id = db.duplicate_provider("pi", "beta").await.unwrap();
        assert_ne!(copy_id, "beta");
        assert_eq!(
            db.get_provider("pi", &copy_id).await.unwrap().unwrap().name,
            "Beta Copy"
        );
    }

    #[tokio::test]
    async fn set_current_validates_existence_and_clears() {
        let db = db::Database::memory().await.unwrap();
        assert!(db.set_current_provider("pi", Some("nope")).await.is_err());
        db.save_provider("pi", &sample("a", "A")).await.unwrap();
        db.set_current_provider("pi", Some("a")).await.unwrap();
        assert_eq!(
            db.get_current_provider("pi").await.unwrap().as_deref(),
            Some("a")
        );
        db.set_current_provider("pi", None).await.unwrap();
        assert_eq!(db.get_current_provider("pi").await.unwrap(), None);
    }

    #[tokio::test]
    async fn delete_clears_current_and_reindexes() {
        let db = db::Database::memory().await.unwrap();
        let mut a = sample("a", "A");
        a.sort_index = Some(0);
        let mut b = sample("b", "B");
        b.sort_index = Some(1);
        let mut c = sample("c", "C");
        c.sort_index = Some(2);
        for p in [&a, &b, &c] {
            db.save_provider("pi", p).await.unwrap();
        }
        db.set_current_provider("pi", Some("b")).await.unwrap();
        db.delete_provider("pi", "b").await.unwrap();

        assert_eq!(db.get_current_provider("pi").await.unwrap(), None);
        let list = db.list_providers("pi").await.unwrap();
        assert_eq!(
            list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "c"]
        );
        assert_eq!(list[0].sort_index, Some(0));
        assert_eq!(list[1].sort_index, Some(1));
    }

    #[tokio::test]
    async fn reorder_appends_unlisted() {
        let db = db::Database::memory().await.unwrap();
        for id in ["a", "b", "c"] {
            db.save_provider("pi", &sample(id, id)).await.unwrap();
        }
        db.reorder_providers("pi", &["c".to_string(), "a".to_string()])
            .await
            .unwrap();
        let ids: Vec<String> = db
            .list_providers("pi")
            .await
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
    }

    #[tokio::test]
    async fn rename_preserves_current_and_sort() {
        let db = db::Database::memory().await.unwrap();
        let mut a = sample("a", "A");
        a.sort_index = Some(0);
        let mut b = sample("b", "B");
        b.sort_index = Some(1);
        db.save_provider("pi", &a).await.unwrap();
        db.save_provider("pi", &b).await.unwrap();
        db.set_current_provider("pi", Some("a")).await.unwrap();

        let mut renamed = a.clone();
        renamed.id = "a2".into();
        renamed.sort_index = None; // 依赖行上已有的 sort_index
        db.rename_provider("pi", "a", &renamed).await.unwrap();

        assert!(db.get_provider("pi", "a").await.unwrap().is_none());
        let after = db.get_provider("pi", "a2").await.unwrap().unwrap();
        assert_eq!(after.name, "A");
        assert_eq!(after.sort_index, Some(0));
        assert_eq!(
            db.get_current_provider("pi").await.unwrap().as_deref(),
            Some("a2")
        );

        // 目标 ID 已占用时报错。
        let mut clash = b.clone();
        clash.id = "a2".into();
        assert!(db.rename_provider("pi", "b", &clash).await.is_err());
    }
}
